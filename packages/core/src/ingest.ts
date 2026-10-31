import { randomUUID } from "node:crypto";
import type { EventBuffer } from "./buffer.js";
import type { Clocks } from "./clock.js";
import type { Redactor } from "./redact.js";
import { InvalidEventError, SCHEMA_VERSION, type DebugEvent, type RawEvent } from "./schema.js";
import { isPlainObject } from "./util.js";

/** Longer messages are cut before redaction so one huge line (a base64 blob) can't stall the daemon. */
export const MAX_MSG_CHARS = 16_384;

/**
 * Cuts to MAX_MSG_CHARS, then drops the trailing partial token back to the last whitespace:
 * half a secret may no longer match its redaction rule.
 */
function capMessage(text: string): { readonly msg: string; readonly cut: number } {
  if (text.length <= MAX_MSG_CHARS) return { msg: text, cut: 0 };
  let end = MAX_MSG_CHARS;
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) end--;
  return { msg: text.slice(0, end), cut: text.length - end };
}

/** A normalized, redacted event that has not been numbered and stored yet. What enrichers see. */
export type RedactedEvent = Omit<DebugEvent, "id">;

/** What an enricher may change. Everything else about an event is fixed at ingest. */
export interface EventPatch {
  readonly msg?: string | undefined;
  /** Merged over the event's attrs. */
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}

export interface IngestDeps {
  readonly redactor: Redactor;
  readonly clocks: Clocks;
  readonly buffer: EventBuffer;
  readonly now?: () => number;
  readonly newSessionId?: () => string;
}

/** The single path into the buffer: redact, normalize time, number, store. */
export class Ingest {
  #nextId = 1;
  readonly #sessions = new Map<string, string>();
  readonly #deps: IngestDeps;
  readonly #now: () => number;
  readonly #newSessionId: () => string;

  constructor(deps: IngestDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#newSessionId = deps.newSessionId ?? randomUUID;
  }

  ingest(raw: RawEvent): DebugEvent {
    return this.commit(this.prepare(raw));
  }

  /** Redacts and normalizes. Nothing that leaves here carries an unredacted value. */
  prepare(raw: RawEvent): RedactedEvent {
    const { redactor, clocks } = this.#deps;
    const hostTs = this.#now();
    const { ts, estimated } = clocks.toHost(raw.deviceId, raw.deviceTs, hostTs);
    const { msg, cut } = capMessage(raw.msg);
    const attrs = cut > 0 ? { ...raw.attrs, truncatedChars: cut } : raw.attrs ?? {};
    return {
      schemaVersion: SCHEMA_VERSION,
      ts,
      deviceTs: raw.deviceTs ?? null,
      hostTs,
      estimated,
      source: raw.source,
      deviceId: raw.deviceId,
      app: raw.app,
      sessionId: this.#session(raw.deviceId, raw.app),
      pid: raw.pid ?? null,
      level: raw.level,
      // Redaction happens here, before the buffer and before any plugin sees the event.
      msg: redactor.redact(msg),
      attrs: redactor.redactValue(attrs) as Record<string, unknown>,
    };
  }

  /** Applies an enricher's output. It is untrusted, so it is capped and redacted like a source's. */
  applyPatch(event: RedactedEvent, patch: EventPatch): RedactedEvent {
    if (!isPlainObject(patch)) throw new InvalidEventError("patch must be an object");
    if (patch.msg !== undefined && typeof patch.msg !== "string") throw new InvalidEventError("patch.msg must be a string");
    if (patch.attrs !== undefined && !isPlainObject(patch.attrs)) throw new InvalidEventError("patch.attrs must be an object");
    const { redactor } = this.#deps;
    const capped = patch.msg === undefined ? undefined : capMessage(patch.msg);
    const added = capped !== undefined && capped.cut > 0 ? { ...patch.attrs, truncatedChars: capped.cut } : patch.attrs ?? {};
    return {
      ...event,
      msg: capped === undefined ? event.msg : redactor.redact(capped.msg),
      attrs: { ...event.attrs, ...(redactor.redactValue(added) as Record<string, unknown>) },
    };
  }

  /** For plugin text that leaves the daemon outside an event: its log lines and errors. */
  redact(text: string): string {
    return this.#deps.redactor.redact(text);
  }

  /** Numbers without storing. Used for the muted side-buffer (drop-at-ingest) and for commit. */
  assignId(event: RedactedEvent): DebugEvent {
    const { schemaVersion, ...rest } = event;
    return { schemaVersion, id: this.#nextId++, ...rest };
  }

  /** Numbers and stores. Ids follow store order, so a since-cursor never skips a late enrichment. */
  commit(event: RedactedEvent): DebugEvent {
    const stored = this.assignId(event);
    this.#deps.buffer.push(stored);
    return stored;
  }

  /**
   * When a Metro logical id collapses onto a native UDID, move session keys and rewrite held
   * events (main buffer plus any extras such as the muted side ring) so exports/status see one id.
   */
  rekeyDevice(from: string, to: string, extras: readonly EventBuffer[] = []): number {
    if (from === to) return 0;
    const sessionOf = new Map<string, string>();
    const prefix = `${from}\u0000`;
    for (const [key, sid] of [...this.#sessions]) {
      if (!key.startsWith(prefix)) continue;
      const app = key.slice(prefix.length);
      const dest = `${to}\u0000${app}`;
      const existing = this.#sessions.get(dest);
      if (existing === undefined) this.#sessions.set(dest, sid);
      else if (existing !== sid) sessionOf.set(sid, existing);
      this.#sessions.delete(key);
    }
    const mapSid = (sid: string) => sessionOf.get(sid) ?? sid;
    let n = this.#deps.buffer.rewriteDeviceId(from, to, mapSid);
    for (const extra of extras) n += extra.rewriteDeviceId(from, to, mapSid);
    return n;
  }

  /**
   * After an identity collapse, in-flight enrich commits still carry the old deviceId.
   * Point them at the canonical id and the session key that rekeyDevice left for it.
   */
  withDeviceId(event: RedactedEvent, deviceId: string): RedactedEvent {
    if (event.deviceId === deviceId) return event;
    return { ...event, deviceId, sessionId: this.#session(deviceId, event.app) };
  }

  /** One session per device and app, so an app restart with a new pid keeps its session. */
  #session(deviceId: string, app: string): string {
    const key = `${deviceId}\u0000${app}`;
    let sessionId = this.#sessions.get(key);
    if (sessionId === undefined) {
      sessionId = this.#newSessionId();
      this.#sessions.set(key, sessionId);
    }
    return sessionId;
  }
}
