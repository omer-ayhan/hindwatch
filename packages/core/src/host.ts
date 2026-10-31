import type { EventBuffer } from "./buffer.js";
import type { Clocks } from "./clock.js";
import { DeviceIdentity } from "./device-identity.js";
import { IncidentStore } from "./incidents.js";
import type { EventPatch, Ingest, RedactedEvent } from "./ingest.js";
import {
  PLUGIN_API_VERSION,
  type Detector,
  type Enricher,
  type PluginManifest,
  type Source,
  type SourceContext,
  type SourceHealth,
} from "./plugin.js";
import type { MuteFilter } from "./query.js";
import { InvalidEventError, levelRank, parseRawEvent, type DebugEvent } from "./schema.js";
import { errorMessage } from "./util.js";

export class IncompatiblePluginError extends Error {
  override readonly name = "IncompatiblePluginError";
}

export interface PluginHostDeps {
  readonly root: string;
  readonly ingest: Ingest;
  readonly clocks: Clocks;
  readonly log: (message: string) => void;
  /** How long one enrich call may take before that enricher is skipped for the event. */
  readonly enrichTimeoutMs?: number;
  /** Events one source may have waiting for enrichers; past it they are stored unenriched. */
  readonly maxQueuedPerSource?: number;
  /** Clock for attach/silent timing; tests inject a fake. */
  readonly now?: () => number;
  /** Override DEFAULT_SILENT_AFTER_MS (tests use a short window). */
  readonly silentAfterMs?: number;
  /**
   * Sync mute check consulted before an event is enriched or buffered. Daemon wires NoiseFile.peekFilter.
   * Return true to drop at ingest (counts as mutedDropped, never enters the main buffer).
   */
  readonly isMuted?: () => MuteFilter;
  /**
   * Capped side ring for muted drops. wait_for/logs --include-muted read it; not the main 50k.
   */
  readonly mutedBuffer?: EventBuffer;
}

const DEFAULT_ENRICH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_QUEUED_PER_SOURCE = 1_000;
const TIMED_OUT = Symbol("timed out");

/** How long after attach with zero events before status warns the source may be deaf. */
export const DEFAULT_SILENT_AFTER_MS = 30_000;

export interface SourceActivity {
  readonly name: string;
  readonly events: number;
  readonly attachedAt: number;
  readonly lastEventAt?: number;
  /** Last health the source reported via setHealth (waiting / live / idle). */
  readonly health?: SourceHealth;
}

interface MutableActivity {
  attachedAt: number;
  events: number;
  lastEventAt?: number;
  health?: SourceHealth;
}

/**
 * Runs built-in sources and plugin sources the same way. Every event goes source -> ingest
 * (redact) -> mute check -> enrichers (each output redacted again) -> buffer -> detectors, so no
 * plugin ever sees an unredacted value and muted noise never fills the ring.
 */
export class PluginHost {
  readonly #deps: PluginHostDeps;
  readonly #plugins: PluginManifest[] = [];
  readonly #abort = new AbortController();
  /** Per source, so a slow enricher call keeps one source's order without stalling the others. */
  readonly #queues = new Map<string, Promise<void>>();
  readonly #queued = new Map<string, number>();
  readonly #pending = new Set<RedactedEvent>();
  #invalidEvents = 0;
  #unenrichedEvents = 0;
  #mutedDropped = 0;
  readonly incidents = new IncidentStore();
  /** Native UDID preferred over Metro logical id when the pair collapses. */
  readonly #identity = new DeviceIdentity();
  /** Per source that finished start(): attach time and emit counts for silent-source warnings. */
  readonly #activity = new Map<string, MutableActivity>();

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** Every line goes to the daemon log redacted: plugin messages and errors can carry app data. */
  #log(message: string): void {
    this.#deps.log(this.#deps.ingest.redact(message));
  }

  #muted(): MuteFilter {
    return this.#deps.isMuted?.() ?? (() => false);
  }

  add(manifest: PluginManifest): void {
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new IncompatiblePluginError(
        `${manifest.name} targets plugin API ${manifest.apiVersion}, but this core speaks ${PLUGIN_API_VERSION}`,
      );
    }
    this.#plugins.push(manifest);
  }

  get pluginNames(): string[] {
    return this.#plugins.map((plugin) => plugin.name);
  }

  /** Names of every source the host is running, in plugin order. */
  get sourceNames(): string[] {
    return this.#sources().map((source) => source.name);
  }

  /** Attach/emit stats for sources that finished start(). */
  sourceActivity(): SourceActivity[] {
    return [...this.#activity.entries()].map(([name, act]) => ({
      name,
      events: act.events,
      attachedAt: act.attachedAt,
      ...(act.lastEventAt !== undefined ? { lastEventAt: act.lastEventAt } : {}),
      ...(act.health !== undefined ? { health: act.health } : {}),
    }));
  }

  /**
   * Warnings for sources that are waiting on a device/Metro, went quiet after events, or attached
   * live with nothing (possible deaf). Waiting / unset health / no device are never labeled "deaf".
   * Live with prior events does not warn "gone quiet" — RN idle while attached is healthy.
   */
  silentSourceWarnings(): string[] {
    const after = this.#deps.silentAfterMs ?? DEFAULT_SILENT_AFTER_MS;
    const now = this.#now();
    return this.sourceActivity().flatMap((act) => {
      const health = act.health;
      if (health?.status === "waiting") {
        const silentFor = now - act.attachedAt;
        if (silentFor < after) return [];
        return [`${act.name}: ${health.detail}`];
      }
      if (act.events === 0) {
        const silentFor = now - act.attachedAt;
        if (silentFor < after) return [];
        // Live but silent after attach → possibly deaf. Unset health (e.g. android before first
        // pidof) and idle are real waiting/no-device states, not deaf.
        if (health?.status === "live") {
          const secs = Math.max(1, Math.floor(silentFor / 1000));
          return [`${act.name}: no events for ${secs}s after attach; the source may be deaf`];
        }
        if (health?.status === "idle") return [`${act.name}: ${health.detail}`];
        return [`${act.name}: waiting (no device or not yet attached)`];
      }
      // Had events: warn when a non-live stream goes quiet. Live (RN idle) is fine.
      if (health?.status === "live") return [];
      const last = act.lastEventAt ?? act.attachedAt;
      const quietFor = now - last;
      if (quietFor < after) return [];
      if (health?.status === "idle") {
        return [`${act.name}: ${health.detail}`];
      }
      const secs = Math.max(1, Math.floor(quietFor / 1000));
      return [`${act.name}: no events for ${secs}s since last; source may have gone quiet`];
    });
  }

  /** Events rejected at ingest because they didn't match the schema. */
  get invalidEvents(): number {
    return this.#invalidEvents;
  }

  /** Events stored without enrichment because their source's queue was full. */
  get unenrichedEvents(): number {
    return this.#unenrichedEvents;
  }

  /** Events dropped at ingest because a noise rule muted them (never entered the buffer). */
  get mutedDropped(): number {
    return this.#mutedDropped;
  }

  /** A source that fails to start is logged and does not stop the others. */
  async startAll(): Promise<void> {
    await Promise.all(
      this.#sources().map(async (source) => {
        // Register before start so setHealth/emit during start (and its fire-and-forget watch) stick.
        this.#activity.set(source.name, { attachedAt: this.#now(), events: 0 });
        try {
          await source.start(this.#context(source));
        } catch (error) {
          this.#activity.delete(source.name);
          this.#log(`source ${source.name} failed to start: ${errorMessage(error)}`);
        }
      }),
    );
  }

  /** Events emitted but not yet stored because they wait for enrichers, in emit order. */
  pendingEvents(): RedactedEvent[] {
    return [...this.#pending];
  }

  /** Resolves once every event emitted so far has been enriched and stored. */
  async settled(): Promise<void> {
    await Promise.all(this.#queues.values());
  }

  async stopAll(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(this.#sources().map((source) => source.stop()));
  }

  #sources(): Source[] {
    return this.#plugins.flatMap((plugin) => plugin.sources);
  }

  #enrichers(): Enricher[] {
    return this.#plugins.flatMap((plugin) => plugin.enrichers ?? []);
  }

  #detectors(): Detector[] {
    return this.#plugins.flatMap((plugin) => plugin.detectors ?? []);
  }

  #context(source: Source): SourceContext {
    const { root, ingest, clocks } = this.#deps;
    const log = (message: string) => this.#log(message);
    const signal = this.#abort.signal;
    return {
      root,
      signal,
      emit: (event) => {
        if (signal.aborted) return;
        let redacted: RedactedEvent;
        try {
          const parsed = parseRawEvent(event);
          const { canonical, aliasedFrom } = this.#identity.bind(parsed.app, parsed.deviceId, source.name);
          if (aliasedFrom !== undefined) {
            clocks.rekey(aliasedFrom, canonical);
            // Rewrite already-buffered (and muted) events so exports/status never keep dual ids.
            const side = this.#deps.mutedBuffer;
            ingest.rekeyDevice(aliasedFrom, canonical, side === undefined ? [] : [side]);
          }
          redacted = ingest.prepare(
            canonical === parsed.deviceId ? parsed : { ...parsed, deviceId: canonical },
          );
          const act = this.#activity.get(source.name);
          if (act !== undefined) {
            act.events += 1;
            act.lastEventAt = this.#now();
          }
        } catch (error) {
          if (!(error instanceof InvalidEventError)) throw error;
          this.#invalidEvents++;
          log(`invalid event from ${source.name}: ${error.message}`);
          return;
        }
        // Drop muted before enrich/main buffer so native spam never fills the ring or queues
        // symbolicate. Keep a capped copy on mutedBuffer for wait_for/logs --include-muted.
        // Mute check must never crash ingest (bad noise/config file keeps last-good via peekFilter).
        let muted = false;
        try {
          muted = this.#muted()(redacted);
        } catch (error) {
          log(`mute check failed: ${errorMessage(error)}`);
        }
        if (muted) {
          this.#mutedDropped++;
          const side = this.#deps.mutedBuffer;
          if (side !== undefined) side.push(this.#deps.ingest.assignId(redacted));
          return;
        }
        const enrichers = this.#enrichers();
        // Without enrichers the event is stored synchronously, as before.
        if (enrichers.length === 0) {
          this.#store(redacted);
          return;
        }
        const queued = this.#queued.get(source.name) ?? 0;
        if (queued >= (this.#deps.maxQueuedPerSource ?? DEFAULT_MAX_QUEUED_PER_SOURCE)) {
          this.#unenrichedEvents++;
          this.#store(redacted);
          return;
        }
        this.#queued.set(source.name, queued + 1);
        this.#pending.add(redacted);
        const queue = (this.#queues.get(source.name) ?? Promise.resolve())
          .then(() => this.#enrich(redacted, enrichers))
          .then((enriched) => {
            if (!signal.aborted) this.#store(enriched);
          })
          .catch((error: unknown) => log(`event from ${source.name} lost: ${errorMessage(error)}`))
          .finally(() => {
            this.#queued.set(source.name, (this.#queued.get(source.name) ?? 1) - 1);
            this.#pending.delete(redacted);
          });
        this.#queues.set(source.name, queue);
      },
      setClockSample: (deviceId, sample) => clocks.setSample(this.#identity.remap(deviceId), sample),
      clearClockSample: (deviceId) => clocks.clearSample(this.#identity.remap(deviceId)),
      setHealth: (health) => {
        const act = this.#activity.get(source.name);
        if (act !== undefined) act.health = health;
      },
      log: (message) => log(`[${source.name}] ${message}`),
    };
  }

  /** Each enricher sees the previous one's redacted output. A failing or slow enricher is skipped. */
  async #enrich(event: RedactedEvent, enrichers: readonly Enricher[]): Promise<RedactedEvent> {
    let current = event;
    for (const enricher of enrichers) {
      try {
        const patch = await this.#enrichOne(enricher, current);
        if (patch !== undefined) current = this.#deps.ingest.applyPatch(current, patch);
      } catch (error) {
        this.#log(`enricher ${enricher.name} failed: ${errorMessage(error)}`);
      }
    }
    return current;
  }

  /**
   * The enricher works on a copy, so neither an in-place edit nor one made after a timeout can
   * reach the stored event; only a returned patch does, and that goes through applyPatch.
   */
  async #enrichOne(enricher: Enricher, event: RedactedEvent): Promise<EventPatch | undefined> {
    const timeoutMs = this.#deps.enrichTimeoutMs ?? DEFAULT_ENRICH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const work = Promise.resolve().then(() => enricher.enrich(structuredClone(event)));
    // A failure after the timeout has nobody left to report to.
    work.catch(() => {});
    try {
      const result = await Promise.race([work, timedOut]);
      if (result === TIMED_OUT) throw new Error(`timed out after ${timeoutMs}ms`);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  #store(redacted: RedactedEvent): void {
    // Enrich queues bake deviceId at emit time; remap here so a mid-flight UDID bind
    // cannot leave Metro ids in the buffer after rewrite already ran.
    const canonical = this.#identity.remap(redacted.deviceId);
    const ready =
      canonical === redacted.deviceId ? redacted : this.#deps.ingest.withDeviceId(redacted, canonical);
    const event = this.#deps.ingest.commit(ready);
    for (const detector of this.#detectors()) {
      try {
        const incident = detector.detect(structuredClone(event));
        if (incident !== undefined) this.#raise(detector.name, event, incident);
      } catch (error) {
        this.#log(`detector ${detector.name} failed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * A new incident is also recorded as one more event next to its trigger, so the timeline shows
   * it. It goes through ingest, so its title is redacted like everything else. A repeat of a known
   * incident only bumps that incident's count.
   */
  #raise(detector: string, event: DebugEvent, incident: unknown): void {
    const { kind, title } = (incident ?? {}) as Record<string, unknown>;
    if (typeof kind !== "string" || typeof title !== "string") {
      throw new InvalidEventError("an incident needs a kind and a title");
    }
    const { ingest } = this.#deps;
    const marker = ingest.prepare({
      source: event.source,
      deviceId: event.deviceId,
      app: event.app,
      pid: event.pid ?? undefined,
      deviceTs: event.deviceTs ?? undefined,
      level: levelRank(event.level) >= levelRank("error") ? event.level : "error",
      msg: title,
    });
    const { record, isNew } = this.incidents.raise(detector, kind, marker.msg, event);
    if (isNew) ingest.commit(ingest.applyPatch(marker, { attrs: { incident: { id: record.id, kind, detector, eventId: event.id } } }));
  }
}
