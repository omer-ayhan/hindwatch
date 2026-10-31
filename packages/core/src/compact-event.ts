import { isPlainObject } from "./util.js";
import { displayFile, isPlumbingFrame } from "./stack.js";
import type { DebugEvent, Level } from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * One event in a logs / query page: the fields an agent needs to scan the timeline.
 * Shared identity (schemaVersion, sessionId, deviceId, app, …) lives on the page envelope
 * when every event on the page agrees; see `compactQueryPage`.
 */
export interface CompactEvent {
  readonly id: number;
  readonly ts: number;
  readonly source: string;
  readonly level: Level;
  readonly msg: string;
  readonly pid?: number;
  readonly deviceId?: string;
  readonly app?: string;
  readonly sessionId?: string;
  readonly estimated?: boolean;
  readonly attrs?: Readonly<Record<string, unknown>>;
  /** Chars removed from msg when budget forced a cut; msg itself stays readable. */
  readonly msgCut?: number;
  /** Attrs were dropped to fit the budget (see msgCut). */
  readonly attrsOmitted?: true;
  /** Window around a text-filter hit when the full msg may hide it. */
  readonly match?: string;
  /** True when ts is before the daemon startedAt on the page envelope. */
  readonly stale?: true;
}

/** Fields stated once at the top of a query page when uniform across that page. */
export interface QueryEnvelope {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly app?: string;
  /** Daemon start time (ms); events with ts before this may be marked stale. */
  readonly startedAt?: number;
  /** Page order: asc = oldest first (default), desc = newest first. */
  readonly order?: "asc" | "desc";
}

/** How compact / incident views shorten paths and classify plumbing frames. */
export interface CompactDisplay {
  readonly root?: string | undefined;
  readonly plumbing?: readonly string[] | undefined;
}

/** Metro bundle URLs in messages → `bundle:line:col` so a stack fits the char budget. */
const BUNDLE_IN_TEXT = /https?:\/\/[^\s)]+\.bundle[^\s)]*:(\d+):(\d+)/gi;

export function shortenBundlesInText(text: string): string {
  return text.replace(BUNDLE_IN_TEXT, "bundle:$1:$2");
}

function frameWhere(file: string, line: number, column: number | undefined, root: string | undefined): string {
  if (file.includes(".bundle")) {
    return typeof column === "number" ? `bundle:${line}:${column}` : `bundle:${line}`;
  }
  const shown = displayFile(file, root);
  return typeof column === "number" ? `${shown}:${line}:${column}` : `${shown}:${line}`;
}

/** One stack frame as `fn (file:line:col)`, with Metro bundle paths shortened. */
export function formatCompactFrame(frame: unknown, display: CompactDisplay = {}): string | undefined {
  if (!isPlainObject(frame)) return undefined;
  const fn = frame.methodName ?? frame.functionName;
  const file = frame.file ?? frame.url;
  const line = frame.lineNumber;
  const column = frame.column ?? frame.columnNumber;
  if (typeof file !== "string" || typeof line !== "number") return undefined;
  return `${typeof fn === "string" && fn !== "" ? fn : "<anonymous>"} (${frameWhere(file, line, typeof column === "number" ? column : undefined, display.root)})`;
}

const MAX_COMPACT_FRAMES = 8;

function keepAttrString(attrs: Readonly<Record<string, unknown>>, key: string, out: Record<string, unknown>): void {
  const value = attrs[key];
  if (typeof value === "string" && value !== "") out[key] = value;
}

/**
 * Keep flags, native identity (tag / subsystem / category), and a short stack; drop code frames
 * (available via `incident --part code`) and other bulky attrs so the message / stack win the budget.
 */
export function compactAttrs(
  attrs: Readonly<Record<string, unknown>>,
  display: CompactDisplay = {},
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (attrs.exception === true) out.exception = true;
  if (attrs.symbolicated === true) out.symbolicated = true;
  if (attrs.incident !== undefined) out.incident = attrs.incident;
  keepAttrString(attrs, "tag", out);
  keepAttrString(attrs, "subsystem", out);
  keepAttrString(attrs, "category", out);
  if (Array.isArray(attrs.stack) && attrs.stack.length > 0) {
    const plumbing = display.plumbing ?? [];
    const frames: string[] = [];
    for (const frame of attrs.stack) {
      if (isPlainObject(frame) && isPlumbingFrame(frame, plumbing)) continue;
      const text = formatCompactFrame(frame, display);
      if (text === undefined) continue;
      frames.push(text);
      if (frames.length >= MAX_COMPACT_FRAMES) break;
    }
    if (frames.length > 0) {
      out.stack = frames;
      if (attrs.stack.length > frames.length) out.stackOmitted = attrs.stack.length - frames.length;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Per-event compact form before shared fields are hoisted onto the page. */
export function toCompactEvent(event: DebugEvent, display: CompactDisplay = {}): CompactEvent {
  const attrs = compactAttrs(event.attrs, display);
  return {
    id: event.id,
    ts: event.ts,
    source: event.source,
    level: event.level,
    msg: shortenBundlesInText(event.msg),
    ...(typeof event.pid === "number" ? { pid: event.pid } : {}),
    deviceId: event.deviceId,
    app: event.app,
    sessionId: event.sessionId,
    ...(event.estimated === true ? { estimated: true } : {}),
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

function sharedValue<K extends keyof CompactEvent>(
  events: readonly CompactEvent[],
  key: K,
): CompactEvent[K] | undefined {
  if (events.length === 0) return undefined;
  const first = events[0]![key];
  return events.every((e) => e[key] === first) ? first : undefined;
}

/**
 * Hoist identity fields that every event on the page shares, and always state schemaVersion
 * once. Returns the page envelope plus events with those keys stripped.
 */
export function compactQueryPage(
  events: readonly DebugEvent[],
  display: CompactDisplay = {},
): {
  readonly envelope: QueryEnvelope;
  readonly events: CompactEvent[];
} {
  const compact = events.map((e) => toCompactEvent(e, display));
  const sessionId = sharedValue(compact, "sessionId");
  const deviceId = sharedValue(compact, "deviceId");
  const app = sharedValue(compact, "app");
  // Omit default `estimated: false` / null pid: agents still filter gap-fill with `!e.estimated`
  // (undefined and false both drop). Keep `estimated: true` so gap-fill rows stay flagged.
  const stripped = compact.map((e) => {
    const next: CompactEvent = {
      id: e.id,
      ts: e.ts,
      source: e.source,
      level: e.level,
      msg: e.msg,
      ...(e.estimated === true ? { estimated: true } : {}),
      ...(typeof e.pid === "number" ? { pid: e.pid } : {}),
      ...(e.attrs !== undefined ? { attrs: e.attrs } : {}),
      ...(typeof e.msgCut === "number" ? { msgCut: e.msgCut } : {}),
      ...(e.attrsOmitted === true ? { attrsOmitted: true } : {}),
      ...(e.match !== undefined ? { match: e.match } : {}),
      ...(e.stale === true ? { stale: true } : {}),
      ...(sessionId === undefined && e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
      ...(deviceId === undefined && e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
      ...(app === undefined && e.app !== undefined ? { app: e.app } : {}),
    };
    return next;
  });
  return {
    envelope: {
      schemaVersion: SCHEMA_VERSION,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(app !== undefined ? { app } : {}),
    },
    events: stripped,
  };
}
