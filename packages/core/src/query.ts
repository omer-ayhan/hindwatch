import { createHash } from "node:crypto";
import { budgetOf, cutText, fitByBuild, fitPage, sizeOf } from "./budget.js";
import { compactQueryPage, type CompactDisplay, type CompactEvent, type QueryEnvelope } from "./compact-event.js";
import { collapse, patternOf, type Pattern } from "./patterns.js";
import { isLevel, levelRank, SCHEMA_VERSION, type DebugEvent, type Level } from "./schema.js";
import { isPlainObject } from "./util.js";

export interface Query {
  /** Arrival-order window, exclusive below and inclusive above. Marks resolve to these. */
  readonly sinceId?: number | undefined;
  readonly untilId?: number | undefined;
  /** Mark names of the asking client, resolved into sinceId/untilId by the daemon. */
  readonly sinceMark?: string | undefined;
  readonly untilMark?: string | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly sources?: readonly string[] | undefined;
  readonly minLevel?: Level | undefined;
  readonly app?: string | undefined;
  /** Only events whose msg contains this text. */
  readonly text?: string | undefined;
  /** Only events folded into this pattern id. */
  readonly pattern?: string | undefined;
  /** Also return events the project's noise file mutes. */
  readonly includeMuted?: boolean | undefined;
  /**
   * false = only events at/after daemon start (live); true = only pre-start replay.
   * Resolved into from/to against startedAt before selection.
   */
  readonly stale?: boolean | undefined;
  /** Page order: asc = oldest first (default), desc = newest first. */
  readonly order?: "asc" | "desc" | undefined;
  readonly budgetChars?: number | undefined;
  readonly cursor?: string | undefined;
  /**
   * Exclusive timeline keyset lower bound. Daemon injects this for sinceLast page
   * continuation so clock-skewed lower ids after the page end are not skipped.
   */
  readonly after?: { readonly ts: number; readonly id: number } | undefined;
}

export interface QueryResult extends QueryEnvelope {
  /** Sorted on ts. Compact: shared identity fields live on the envelope above. */
  readonly events: readonly CompactEvent[];
  readonly truncated: boolean;
  readonly omitted: number;
  /** Matching events hidden by the noise file. */
  readonly muted: number;
  /** Pass back as `cursor` to read the next page. Null on the last page. */
  readonly next: string | null;
  /** Highest event id this result and its pages cover. The next since-cursor. */
  readonly lastId: number;
}

export class InvalidQueryError extends Error {
  override readonly name = "InvalidQueryError";
}

/**
 * Folds `stale: false` (live) / `stale: true` (pre-start only) into from/to using daemon
 * startedAt, then strips `stale` so cursors fingerprint the resolved bounds.
 */
export function resolveStale(query: Query, startedAt: number | undefined): Query {
  const { stale, ...rest } = query;
  if (stale === undefined || startedAt === undefined) return rest;
  if (stale) {
    const to = rest.to === undefined ? startedAt - 1 : Math.min(rest.to, startedAt - 1);
    return { ...rest, to };
  }
  const from = rest.from === undefined ? startedAt : Math.max(rest.from, startedAt);
  return { ...rest, from };
}

/** Keyset position plus the id ceiling, so events that arrive while paging can't slip in. */
interface Cursor {
  readonly ts: number;
  readonly id: number;
  readonly uptoId: number;
  /** Fingerprint of the filters that selected this page's events. */
  readonly fp: string;
}

const CURSOR_FP = /^[0-9a-f]{8}$/;

/**
 * Stable hash of the filters that change which events are selected.
 * Page size (`budgetChars`) is excluded; `includeMuted` is included.
 */
export function selectionFingerprint(query: Omit<Query, "cursor" | "budgetChars">): string {
  const sources = query.sources === undefined ? "" : [...query.sources].sort().join("\0");
  const payload = [
    query.sinceId ?? "",
    query.untilId ?? "",
    query.from ?? "",
    query.to ?? "",
    sources,
    query.minLevel ?? "",
    query.app ?? "",
    query.text ?? "",
    query.pattern ?? "",
    query.includeMuted === true ? "1" : "",
    query.stale === true ? "stale" : query.stale === false ? "live" : "",
    query.order === "desc" ? "desc" : "",
  ].join("\u0001");
  return createHash("sha1").update(payload).digest("hex").slice(0, 8);
}

function formatCursor(event: DebugEvent, uptoId: number, query: Omit<Query, "cursor" | "budgetChars">): string {
  return `${event.ts}:${event.id}:${uptoId}:${selectionFingerprint(query)}`;
}

export function parseCursor(text: string): Cursor {
  const parts = text.split(":");
  if (parts.length !== 4) throw new InvalidQueryError(`invalid cursor: ${text}`);
  const [tsText, idText, uptoText, fp] = parts;
  const ts = Number(tsText);
  const id = Number(idText);
  const uptoId = Number(uptoText);
  if (!Number.isFinite(ts) || !Number.isSafeInteger(id) || !Number.isSafeInteger(uptoId) || fp === undefined || !CURSOR_FP.test(fp)) {
    throw new InvalidQueryError(`invalid cursor: ${text}`);
  }
  return { ts, id, uptoId, fp };
}

function requireCursorFilters(fp: string, query: Omit<Query, "cursor" | "budgetChars">): void {
  if (fp !== selectionFingerprint(query)) {
    throw new InvalidQueryError("cursor was minted with different filters");
  }
}

function byTimeline(a: { ts: number; id: number }, b: { ts: number; id: number }): number {
  return a.ts - b.ts || a.id - b.id;
}

/** Fits one oversized compact event into the room left so every page makes progress. */
function clipCompact(event: CompactEvent, room: number): CompactEvent {
  const bare: CompactEvent = {
    id: event.id,
    ts: event.ts,
    source: event.source,
    level: event.level,
    msg: "",
    attrsOmitted: true,
    ...(typeof event.pid === "number" ? { pid: event.pid } : {}),
    ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
    ...(event.app !== undefined ? { app: event.app } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.estimated === true ? { estimated: true } : {}),
    ...(event.match !== undefined ? { match: event.match } : {}),
    ...(event.stale === true ? { stale: true } : {}),
  };
  // Keep msg readable; record how many chars were cut in msgCut instead of burying notes in msg.
  const marker = (cut: number) => (cut > 0 ? "…" : "");
  // Reserve room for msgCut in the JSON (worst-case digit width).
  const reserve = sizeOf({ msgCut: event.msg.length }) - sizeOf({});
  const msg = cutText(event.msg, Math.max(0, room - sizeOf(bare) - reserve + 2), marker);
  const cut = event.msg.length - (msg.endsWith("…") ? msg.length - 1 : msg.length);
  return {
    ...bare,
    msg,
    ...(cut > 0 ? { msgCut: cut } : {}),
  };
}

/** Short window around a case-insensitive text hit so agents see why an event matched. */
export function matchSnippet(msg: string, text: string, radius = 40): string | undefined {
  if (text === "") return undefined;
  const i = msg.toLowerCase().indexOf(text.toLowerCase());
  if (i < 0) return undefined;
  const start = Math.max(0, i - radius);
  const end = Math.min(msg.length, i + text.length + radius);
  return `${start > 0 ? "…" : ""}${msg.slice(start, end)}${end < msg.length ? "…" : ""}`;
}

/** Says whether the project's noise file mutes an event (ingest or query). Needs source, msg, attrs. */
/** Shape mute rules need. DebugEvent and RedactedEvent both satisfy it. */
export type MuteTarget = {
  readonly source: string;
  readonly msg: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly level?: string | undefined;
};
export type MuteFilter = (event: MuteTarget) => boolean;

const NOTHING_MUTED: MuteFilter = () => false;

/** Where a page starts: after a keyset position, never past the id ceiling of its first page. */
export interface Bound {
  readonly after?: { readonly ts: number; readonly id: number } | undefined;
  /** Exclusive upper keyset for newest-first paging toward older events. */
  readonly before?: { readonly ts: number; readonly id: number } | undefined;
  readonly uptoId?: number | undefined;
}

/** The filters of a query that a single event can be checked against. */
export type EventFilter = Omit<Query, "cursor" | "budgetChars" | "includeMuted" | "sinceMark" | "untilMark">;

export function matches(e: DebugEvent, query: EventFilter): boolean {
  return (
    (query.sinceId === undefined || e.id > query.sinceId) &&
    (query.untilId === undefined || e.id <= query.untilId) &&
    (query.from === undefined || e.ts >= query.from) &&
    (query.to === undefined || e.ts <= query.to) &&
    (query.sources === undefined || query.sources.includes(e.source)) &&
    (query.app === undefined || e.app === query.app) &&
    (query.minLevel === undefined || levelRank(e.level) >= levelRank(query.minLevel)) &&
    (query.text === undefined || e.msg.toLowerCase().includes(query.text.toLowerCase())) &&
    (query.pattern === undefined || patternOf(e).id === query.pattern)
  );
}

/** Filters shared by every view of the timeline: logs, patterns and incident context. */
export function selectEvents(
  events: readonly DebugEvent[],
  query: Omit<Query, "cursor" | "budgetChars">,
  isMuted: MuteFilter = NOTHING_MUTED,
  bound: Bound = {},
): { readonly events: DebugEvent[]; readonly muted: number; readonly uptoId: number } {
  const { after } = bound;
  const uptoId = bound.uptoId ?? events.at(-1)?.id ?? query.sinceId ?? 0;
  let muted = 0;
  const { before } = bound;
  const matched = events.filter((e) => {
    const match =
      e.id <= uptoId &&
      matches(e, query) &&
      (after === undefined || byTimeline(e, after) > 0) &&
      (before === undefined || byTimeline(e, before) < 0);
    if (!match || query.includeMuted === true || !isMuted(e)) return match;
    muted++;
    return false;
  });
  return { events: matched.sort(byTimeline), muted, uptoId };
}

/** `budget` is for callers that wrap the result in a larger response and pass what is left. */
export interface QueryExtras {
  readonly display?: CompactDisplay;
  /** Daemon start time; events before it are flagged stale on the page. */
  readonly startedAt?: number;
}

export function runQuery(
  events: readonly DebugEvent[],
  query: Query,
  isMuted?: MuteFilter,
  budget = budgetOf(query.budgetChars),
  displayOrExtras: CompactDisplay | QueryExtras = {},
): QueryResult {
  const extras: QueryExtras =
    "display" in displayOrExtras || "startedAt" in displayOrExtras
      ? (displayOrExtras as QueryExtras)
      : { display: displayOrExtras as CompactDisplay };
  const display = extras.display ?? {};
  const startedAt = extras.startedAt;
  const desc = query.order === "desc";
  const cursor = query.cursor === undefined ? undefined : parseCursor(query.cursor);
  if (cursor !== undefined) requireCursorFilters(cursor.fp, query);
  const selected = selectEvents(events, query, isMuted, {
    after: !desc ? (cursor ?? query.after) : undefined,
    before: desc ? cursor : undefined,
    uptoId: cursor?.uptoId,
  });
  const { muted, uptoId } = selected;
  const matched = desc ? [...selected.events].reverse() : selected.events;
  const build = (page: readonly DebugEvent[]): QueryResult => {
    const last = page.at(-1);
    const truncated = page.length < matched.length;
    const { envelope, events: compact } = compactQueryPage(page, display);
    // Rematch against the original (pre-budget) messages so a truncated msg still shows the hit.
    const withMatch = page.map((raw, i) => {
      const c = compact[i]!;
      const match = query.text ? matchSnippet(raw.msg, query.text) : undefined;
      const stale = startedAt !== undefined && raw.ts < startedAt;
      return {
        ...c,
        ...(match !== undefined ? { match } : {}),
        ...(stale ? { stale: true as const } : {}),
      };
    });
    return {
      ...envelope,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(desc ? { order: "desc" as const } : { order: "asc" as const }),
      events: withMatch,
      truncated,
      omitted: matched.length - page.length,
      muted,
      next: truncated && last !== undefined ? formatCursor(last, uptoId, query) : null,
      lastId: uptoId,
    };
  };
  // Measure the built (compact) page so hoisting / shortened URLs count toward the budget.
  const { page, result } = fitByBuild(matched, budget, build);
  const [first] = matched;
  if (page.length > 0 || first === undefined) return result;
  // One event alone still exceeds budget: drop attrs and cut msg on the compact form.
  const oversize = build([first]);
  const [raw] = oversize.events;
  if (raw === undefined) return oversize;
  const room = budget - (sizeOf(oversize) - sizeOf(raw));
  let clipped = clipCompact(raw, room);
  let out: QueryResult = { ...oversize, events: [clipped] };
  while (sizeOf(out) > budget && clipped.msg.length > 0) {
    const nextMsg = clipped.msg.endsWith("…") ? clipped.msg.slice(0, -2) + "…" : clipped.msg.slice(0, -1);
    const cut = (clipped.msgCut ?? 0) + (clipped.msg.length - nextMsg.length);
    clipped = { ...clipped, msg: nextMsg, ...(cut > 0 ? { msgCut: cut } : {}) };
    out = { ...oversize, events: [clipped] };
  }
  return out;
}

export interface PatternResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Most frequent first. */
  readonly patterns: readonly Pattern[];
  /** Events the patterns on every page fold together. */
  readonly events: number;
  readonly truncated: boolean;
  readonly omitted: number;
  readonly muted: number;
  readonly next: string | null;
  readonly lastId: number;
}

export function parseOffsetCursor(text: string): { offset: number; uptoId: number; fp: string } {
  const parts = text.split(":");
  if (parts.length !== 3) throw new InvalidQueryError(`invalid cursor: ${text}`);
  const [offsetText, uptoText, fp] = parts;
  const offset = Number(offsetText);
  const uptoId = Number(uptoText);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(uptoId) || fp === undefined || !CURSOR_FP.test(fp)) {
    throw new InvalidQueryError(`invalid cursor: ${text}`);
  }
  return { offset, uptoId, fp };
}

function formatOffsetCursor(offset: number, uptoId: number, query: Omit<Query, "cursor" | "budgetChars">): string {
  return `${offset}:${uptoId}:${selectionFingerprint(query)}`;
}

/** The timeline folded into patterns, under the same filters and budget as a query. */
export function runPatternQuery(
  events: readonly DebugEvent[],
  query: Query,
  isMuted?: MuteFilter,
  budget = budgetOf(query.budgetChars),
): PatternResult {
  const cursor = query.cursor === undefined ? undefined : parseOffsetCursor(query.cursor);
  if (cursor !== undefined) requireCursorFilters(cursor.fp, query);
  const { events: selected, muted, uptoId } = selectEvents(events, query, isMuted, { uptoId: cursor?.uptoId });
  const offset = cursor?.offset ?? 0;
  const all = collapse(selected).sort((a, b) => b.count - a.count || a.firstId - b.firstId);
  const rest = all.slice(offset);
  return fitPage(rest, budget, (page) => {
    const truncated = page.length < rest.length;
    return {
      schemaVersion: SCHEMA_VERSION,
      patterns: page,
      events: selected.length,
      truncated,
      omitted: rest.length - page.length,
      muted,
      next: truncated ? formatOffsetCursor(offset + page.length, uptoId, query) : null,
      lastId: uptoId,
    };
  }).result;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidQueryError(`${key} must be a number`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidQueryError(`${key} must be a string`);
  return value;
}

/** Parses a query that came over the socket or the command line. */
export function parseQuery(value: unknown): Query {
  if (!isPlainObject(value)) throw new InvalidQueryError("query must be an object");
  const { sources, minLevel, includeMuted, stale } = value;
  if (sources !== undefined && !(Array.isArray(sources) && sources.every((s) => typeof s === "string"))) {
    throw new InvalidQueryError("sources must be a list of strings");
  }
  if (includeMuted !== undefined && typeof includeMuted !== "boolean") throw new InvalidQueryError("includeMuted must be a boolean");
  if (stale !== undefined && typeof stale !== "boolean") throw new InvalidQueryError("stale must be a boolean");
  if (minLevel !== undefined && !isLevel(minLevel)) throw new InvalidQueryError(`unknown level: ${String(minLevel)}`);
  return {
    sinceId: optionalNumber(value, "sinceId"),
    untilId: optionalNumber(value, "untilId"),
    sinceMark: optionalString(value, "sinceMark"),
    untilMark: optionalString(value, "untilMark"),
    from: optionalNumber(value, "from"),
    to: optionalNumber(value, "to"),
    sources: sources as string[] | undefined,
    minLevel,
    app: optionalString(value, "app"),
    text: optionalString(value, "text"),
    pattern: optionalString(value, "pattern"),
    includeMuted,
    stale: stale as boolean | undefined,
    order: (() => {
      const order = optionalString(value, "order");
      if (order === undefined) return undefined;
      if (order !== "asc" && order !== "desc") throw new InvalidQueryError('order must be "asc" or "desc"');
      return order;
    })(),
    budgetChars: optionalNumber(value, "budgetChars"),
    cursor: optionalString(value, "cursor"),
  };
}
