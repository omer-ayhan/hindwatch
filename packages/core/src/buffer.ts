import type { DebugEvent } from "./schema.js";

export interface BufferLimits {
  readonly maxEvents?: number;
  readonly maxAgeMs: number;
  /**
   * Soft per-source share. Under global pressure (size > maxEvents), over-share sources are
   * trimmed first so one flood cannot evict another. Alone, a source may exceed this up to maxEvents.
   * Defaults to half of maxEvents when omitted.
   */
  readonly maxEventsPerSource?: number;
}

/** Where the evicted part of the buffer ends: everything up to this id is gone. */
export interface EvictedUpTo {
  readonly id: number;
  readonly ts: number;
}

/** In-memory rolling buffer in arrival order. Never written to disk. */
export class EventBuffer {
  #events: DebugEvent[] = [];
  #head = 0;
  #dropped = 0;
  #lastId = 0;
  #evicted: EvictedUpTo | undefined;
  readonly #bySource = new Map<string, number>();
  readonly #seenSources = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #limits: BufferLimits;
  readonly #now: () => number;
  readonly #perSource: number;

  constructor(limits: BufferLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
    this.#perSource =
      limits.maxEventsPerSource ??
      (limits.maxEvents === undefined ? Infinity : Math.max(1, Math.floor(limits.maxEvents / 2)));
  }

  push(event: DebugEvent): void {
    this.#events.push(event);
    this.#lastId = event.id;
    this.#bySource.set(event.source, (this.#bySource.get(event.source) ?? 0) + 1);
    this.#seenSources.add(event.source);
    this.#evict(event.source);
    for (const listener of this.#listeners) listener();
  }

  /** Calls back after every push. Returns the unsubscribe. */
  onPush(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): readonly DebugEvent[] {
    this.#evict();
    return this.#events.slice(this.#head);
  }

  /** Up to limit events with an id above afterId, in arrival order, without copying the rest. */
  after(afterId: number, limit: number): DebugEvent[] {
    this.#evict();
    let low = this.#head;
    let high = this.#events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#events[mid]!.id <= afterId) low = mid + 1;
      else high = mid;
    }
    return this.#events.slice(low, low + limit);
  }

  get size(): number {
    this.#evict();
    return this.#events.length - this.#head;
  }

  /** The id of the newest event ever pushed, 0 before the first. */
  get lastId(): number {
    return this.#lastId;
  }

  /** The newest event evicted for any reason, undefined while nothing has been. */
  get evicted(): EvictedUpTo | undefined {
    this.#evict();
    return this.#evicted;
  }

  /** Events pushed out by newer ones because the buffer was full: overflow is counted, never kept. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Every source name pushed since construction, evicted ones included. */
  get seenSources(): ReadonlySet<string> {
    return this.#seenSources;
  }

  /** maxAgeMs from the limits the buffer was built with. */
  get maxAgeMs(): number {
    return this.#limits.maxAgeMs;
  }

  /**
   * The held event with the earliest timeline `ts` (not arrival head). Agents compare this to
   * maxAgeMs; arrival order can leave an older ts behind a fresher banner.
   */
  get oldest(): { readonly id: number; readonly ts: number } | undefined {
    this.#evict();
    let best: DebugEvent | undefined;
    for (let i = this.#head; i < this.#events.length; i++) {
      const event = this.#events[i]!;
      if (best === undefined || event.ts < best.ts || (event.ts === best.ts && event.id < best.id)) {
        best = event;
      }
    }
    return best === undefined ? undefined : { id: best.id, ts: best.ts };
  }

  /**
   * Rewrites held events that still carry `from` onto `to` (and optional session remap).
   * Used when native UDID replaces a Metro logical id mid-session.
   */
  rewriteDeviceId(from: string, to: string, sessionOf: (sessionId: string) => string = (s) => s): number {
    if (from === to) return 0;
    let n = 0;
    for (let i = this.#head; i < this.#events.length; i++) {
      const event = this.#events[i]!;
      if (event.deviceId !== from) continue;
      this.#events[i] = { ...event, deviceId: to, sessionId: sessionOf(event.sessionId) };
      n++;
    }
    return n;
  }

    /** How many held events came from this source. */
  countFor(source: string): number {
    this.#evict();
    return this.#bySource.get(source) ?? 0;
  }

  #dropAt(index: number, countOverflow: boolean): void {
    const event = this.#events[index]!;
    this.#evicted = { id: event.id, ts: event.ts };
    if (countOverflow) this.#dropped++;
    const n = (this.#bySource.get(event.source) ?? 1) - 1;
    if (n <= 0) this.#bySource.delete(event.source);
    else this.#bySource.set(event.source, n);
    if (index === this.#head) {
      this.#head++;
      return;
    }
    this.#events.splice(index, 1);
  }

  /** Drop the oldest held event from source (arrival order). */
  #dropOldestFrom(source: string): boolean {
    for (let i = this.#head; i < this.#events.length; i++) {
      if (this.#events[i]!.source === source) {
        this.#dropAt(i, true);
        return true;
      }
    }
    return false;
  }

  /** A held source currently over its soft share. Prefer non-incoming so a peer can reclaim room. */
  #overShare(except?: string): string | undefined {
    for (const [source, count] of this.#bySource) {
      if (source === except) continue;
      if (count > this.#perSource) return source;
    }
    if (except !== undefined && (this.#bySource.get(except) ?? 0) > this.#perSource) return except;
    return undefined;
  }

  #evict(incomingSource?: string): void {
    const cutoff = this.#now() - this.#limits.maxAgeMs;
    while (this.#head < this.#events.length) {
      const oldest = this.#events[this.#head]!;
      if (oldest.hostTs >= cutoff) break;
      // Age expiry is not overflow.
      this.#dropAt(this.#head, false);
    }
    // Soft per-source: only trim over-share while making room for global maxEvents.
    // A lone source may exceed its share up to capacity; empty slots stay usable.
    const maxEvents = this.#limits.maxEvents ?? Infinity;
    while (this.#events.length - this.#head > maxEvents) {
      const over = this.#overShare(incomingSource);
      if (over !== undefined && this.#dropOldestFrom(over)) continue;
      this.#dropAt(this.#head, true);
    }
    // Compact occasionally so eviction stays O(1) amortized.
    if (this.#head > 1024 && this.#head * 2 > this.#events.length) {
      this.#events = this.#events.slice(this.#head);
      this.#head = 0;
    }
  }
}
