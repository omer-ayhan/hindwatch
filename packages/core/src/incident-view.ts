import { budgetOf, clipText, fitPage, sizeOf } from "./budget.js";
import type { IncidentRecord } from "./incidents.js";
import { collapse, type Pattern } from "./patterns.js";
import { InvalidQueryError, runQuery, selectEvents, type MuteFilter } from "./query.js";
import { levelRank, SCHEMA_VERSION, type DebugEvent } from "./schema.js";
import { shortenBundlesInText, type CompactDisplay } from "./compact-event.js";
import {
  displayFile,
  framesInText,
  isAppFrame,
  isPlumbingFrame,
  stripAnsi,
} from "./stack.js";
import { isPlainObject } from "./util.js";

/** How far before its trigger an incident's context reaches, across every source. */
export const CONTEXT_WINDOW_MS = 30_000;
const SUMMARY_FRAMES = 5;
const MAX_LIST_TITLE_CHARS = 120;
const MAX_TRIGGER_CHARS = 400;
const MAX_FIRST_ERROR_CHARS = 200;
const MAX_SNIPPET_CHARS = 600;

export const INCIDENT_PARTS = ["trigger", "stack", "code", "context"] as const;
export type IncidentPart = (typeof INCIDENT_PARTS)[number];

export function isIncidentPart(value: unknown): value is IncidentPart {
  return typeof value === "string" && (INCIDENT_PARTS as readonly string[]).includes(value);
}

interface ListItem {
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly count: number;
  readonly source: string;
  readonly app: string;
  readonly firstTs: number;
  readonly lastTs: number;
  /** True when every occurrence came before the daemon started. */
  readonly stale?: true;
}

export interface IncidentList {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly incidents: readonly ListItem[];
  readonly truncated: boolean;
  readonly omitted: number;
  /** Pass back as `cursor`. Null on the last page. */
  readonly next: string | null;
  /** Highest incident id covered: the next `sinceId`. */
  readonly lastId: number;
  /** Daemon start time when known; incidents with lastTs before it are stale. */
  readonly startedAt?: number;
}

export interface ListQuery {
  readonly sinceId?: number | undefined;
  readonly cursor?: string | undefined;
  readonly budgetChars?: number | undefined;
  readonly startedAt?: number | undefined;
}

/** An incident is stale while it has only occurred before the daemon started, in replayed history. */
function staleness(lastTs: number, startedAt: number | undefined): { stale?: true } {
  return startedAt !== undefined && lastTs < startedAt ? { stale: true } : {};
}

export function parseListCursor(text: string): { afterId: number; uptoId: number } {
  const [afterId, uptoId, ...rest] = text.split(":").map(Number);
  if (rest.length > 0 || !Number.isSafeInteger(afterId) || !Number.isSafeInteger(uptoId)) {
    throw new InvalidQueryError(`invalid cursor: ${text}`);
  }
  return { afterId: afterId as number, uptoId: uptoId as number };
}

export function listIncidents(records: readonly IncidentRecord[], query: ListQuery): IncidentList {
  const cursor = query.cursor === undefined ? undefined : parseListCursor(query.cursor);
  const uptoId = cursor?.uptoId ?? records.at(-1)?.id ?? query.sinceId ?? 0;
  const afterId = Math.max(cursor?.afterId ?? 0, query.sinceId ?? 0);
  const startedAt = query.startedAt;
  const matched = records
    .filter((r) => r.id > afterId && r.id <= uptoId)
    .map((r): ListItem => ({
      id: r.id,
      kind: r.kind,
      title: clipText(r.title, MAX_LIST_TITLE_CHARS),
      count: r.count,
      source: r.trigger.source,
      app: r.trigger.app,
      firstTs: r.trigger.ts,
      lastTs: r.lastTs,
      ...staleness(r.lastTs, startedAt),
    }));
  return fitPage(matched, budgetOf(query.budgetChars), (page) => {
    const truncated = page.length < matched.length;
    const last = page.at(-1);
    return {
      schemaVersion: SCHEMA_VERSION,
      incidents: page,
      truncated,
      omitted: matched.length - page.length,
      next: truncated && last !== undefined ? `${last.id}:${uptoId}` : null,
      lastId: uptoId,
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }).result;
}

/** One frame as `fn (file:line:col)`, from Metro's or CDP's frame shape. */
function formatFrame(frame: unknown, display: CompactDisplay): string | undefined {
  if (!isPlainObject(frame)) return undefined;
  const fn = frame.methodName ?? frame.functionName;
  const file = frame.file ?? frame.url;
  const line = frame.lineNumber;
  const column = frame.column ?? frame.columnNumber;
  if (typeof file !== "string" || typeof line !== "number") return undefined;
  const shown = displayFile(file, display.root);
  const where = typeof column === "number" ? `${shown}:${line}:${column}` : `${shown}:${line}`;
  return `${typeof fn === "string" && fn !== "" ? fn : "<anonymous>"} (${where})`;
}

function framesFrom(
  stack: readonly unknown[],
  display: CompactDisplay,
): { app: string[]; useful: string[]; all: string[]; usefulCount: number } {
  const app: string[] = [];
  const useful: string[] = [];
  const all: string[] = [];
  let usefulCount = 0;
  const plumbing = display.plumbing ?? [];
  for (const frame of stack) {
    const text = formatFrame(frame, display);
    if (text === undefined) continue;
    all.push(text);
    if (!isPlainObject(frame)) continue;
    // Hard skip: console.js / ExceptionsManager / react-devtools / etc.
    if (isPlumbingFrame(frame, plumbing)) continue;
    // "Useful" includes Metro-collapsed library frames — after /symbolicate those are the
    // real origin, even though Metro sets collapse on every node_modules file.
    useful.push(text);
    usefulCount += 1;
    if (isAppFrame(frame, plumbing)) app.push(text);
  }
  return { app, useful, all, usefulCount };
}

/**
 * Prefer attrs.stack when it has any non-plumbing frames (including symbolicated, possibly
 * collapsed, library frames). Fall back to the Error stack in `msg` when attrs is only
 * console call-site plumbing. Summary prefers true app frames, else useful frames.
 */
function framesOf(trigger: DebugEvent, display: CompactDisplay): { app: string[]; all: string[] } {
  const attrsStack = Array.isArray(trigger.attrs.stack) ? trigger.attrs.stack : [];
  const fromAttrs = framesFrom(attrsStack, display);
  const fromMsg = framesFrom(framesInText(trigger.msg, trigger.app), display);
  const picked =
    fromAttrs.usefulCount > 0 ? fromAttrs : fromMsg.all.length > 0 ? fromMsg : fromAttrs;
  const shown = picked.app.length > 0 ? picked.app : picked.useful;
  return { app: shown, all: picked.all };
}

interface CodeFrame {
  readonly file: string | null;
  readonly line: number | null;
  readonly snippet: string;
}

function codeOf(trigger: DebugEvent, maxChars: number, display: CompactDisplay): CodeFrame | null {
  const frame = trigger.attrs.codeFrame;
  if (!isPlainObject(frame) || typeof frame.content !== "string") return null;
  const fileName = typeof frame.fileName === "string" ? frame.fileName : null;
  // A code frame pointing at console.js / ExceptionsManager is noise — omit it.
  if (fileName !== null && isPlumbingFrame({ file: fileName }, display.plumbing ?? [])) return null;
  const location = isPlainObject(frame.location) ? frame.location : {};
  return {
    file: fileName === null ? null : displayFile(fileName, display.root),
    line: typeof location.row === "number" ? location.row : null,
    snippet: clipText(stripAnsi(frame.content), maxChars),
  };
}

/** What led up to the trigger: every source, the window before it, noise and incident markers left out. */
function contextOf(record: IncidentRecord, events: readonly DebugEvent[], isMuted: MuteFilter) {
  const to = record.trigger.ts;
  const from = to - CONTEXT_WINDOW_MS;
  const { events: selected, muted } = selectEvents(events, { from, to }, isMuted);
  const before = selected.filter((e) => e.id !== record.trigger.id && e.attrs.incident === undefined);
  return { from, to, before, muted };
}

function fitHeader(header: IncidentHeader, measure: (header: IncidentHeader) => number, budget: number): IncidentHeader {
  let fitted = header;
  for (const field of ["trigger", "title"] as const) {
    const over = measure(fitted) - budget;
    if (over <= 0) break;
    const text = field === "trigger" ? fitted.trigger.msg : fitted.title;
    const clipped = clipText(text, Math.max(0, sizeOf(text) - over));
    fitted = field === "trigger" ? { ...fitted, trigger: { ...fitted.trigger, msg: clipped } } : { ...fitted, title: clipped };
  }
  return fitted;
}

interface IncidentHeader {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly detector: string;
  readonly count: number;
  readonly source: string;
  readonly app: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly trigger: { readonly eventId: number; readonly level: string; readonly msg: string };
  readonly stale?: true;
  readonly startedAt?: number;
}

interface IncidentSummary extends IncidentHeader {
  readonly stack?: { readonly frames: string[]; readonly totalFrames: number; readonly omittedFrames?: number } | null;
  readonly code?: CodeFrame | null;
  readonly firstError?: { readonly eventId: number; readonly source: string; readonly ts: number; readonly msg: string } | null;
}

export interface IncidentDetail extends IncidentSummary {
  readonly context: {
    readonly from: number;
    readonly to: number;
    readonly events: number;
    readonly muted: number;
    readonly patterns: Pattern[];
    readonly omittedPatterns: number;
  };
  readonly omittedParts: string[];
  readonly parts: typeof INCIDENT_PARTS;
}

/**
 * The one-call view: header, trigger, top app frames, code frame, the first error before it, and
 * the patterns leading up to it. Parts that don't fit are named in `omittedParts`; each is one
 * `--part` call away.
 */
export function incidentDetail(
  record: IncidentRecord,
  events: readonly DebugEvent[],
  budgetChars: number | undefined,
  isMuted: MuteFilter,
  display: CompactDisplay = {},
  startedAt?: number,
): IncidentDetail {
  const budget = budgetOf(budgetChars);
  const { trigger } = record;
  const frames = framesOf(trigger, display);
  const context = contextOf(record, events, isMuted);
  const firstError = context.before.find((e) => levelRank(e.level) >= levelRank("error"));
  const patterns = collapse(context.before).sort((a, b) => b.lastTs - a.lastTs);
  const omittedParts: string[] = [];
  // Context goes last: as many patterns as fit, nearest the trigger first, shown in timeline order.
  const build = (detail: IncidentSummary, page: readonly Pattern[]): IncidentDetail => ({
    ...detail,
    context: {
      from: context.from,
      to: context.to,
      events: context.before.length,
      muted: context.muted,
      // Timeline toward the trigger (last occurrence), matching how the page was fitted.
      patterns: [...page].sort((a, b) => a.lastTs - b.lastTs),
      omittedPatterns: patterns.length - page.length,
    },
    omittedParts,
    parts: INCIDENT_PARTS,
  });
  const header = fitHeader(
    {
      schemaVersion: SCHEMA_VERSION,
      id: record.id,
      kind: record.kind,
      title: record.title,
      detector: record.detector,
      count: record.count,
      source: trigger.source,
      app: trigger.app,
      deviceId: trigger.deviceId,
      sessionId: trigger.sessionId,
      firstTs: trigger.ts,
      lastTs: record.lastTs,
      trigger: {
        eventId: trigger.id,
        level: trigger.level,
        msg: clipText(shortenBundlesInText(trigger.msg), MAX_TRIGGER_CHARS),
      },
      ...staleness(record.lastTs, startedAt),
      ...(startedAt !== undefined ? { startedAt } : {}),
    },
    // Reserve room for every part's name in omittedParts, so adding one can't break the budget.
    (h) => sizeOf(build(h, [])) + sizeOf(INCIDENT_PARTS),
    budget,
  );
  const optional = {
    stack: (() => {
      if (frames.all.length === 0) return null;
      const shown = frames.app.slice(0, SUMMARY_FRAMES);
      const omittedFrames = frames.all.length - shown.length;
      return {
        frames: shown,
        totalFrames: frames.all.length,
        ...(omittedFrames > 0 ? { omittedFrames } : {}),
      };
    })(),
    code: codeOf(trigger, MAX_SNIPPET_CHARS, display),
    firstError:
      firstError === undefined
        ? null
        : { eventId: firstError.id, source: firstError.source, ts: firstError.ts, msg: clipText(firstError.msg, MAX_FIRST_ERROR_CHARS) },
  };
  let detail: IncidentSummary = header;
  for (const [name, value] of Object.entries(optional)) {
    const next = { ...detail, [name]: value };
    if (sizeOf(build(next, [])) + sizeOf(INCIDENT_PARTS) <= budget) detail = next;
    else omittedParts.push(name);
  }
  return fitPage(patterns, budget, (page) => build(detail, page)).result;
}

/** One part in full, paged under the budget. */
export function incidentPart(
  record: IncidentRecord,
  part: IncidentPart,
  events: readonly DebugEvent[],
  query: { readonly budgetChars?: number | undefined; readonly cursor?: string | undefined },
  isMuted: MuteFilter,
  display: CompactDisplay = {},
): Record<string, unknown> {
  const budget = budgetOf(query.budgetChars);
  const envelope = { incident: record.id, part };
  const room = budget - sizeOf(envelope) - 1;
  switch (part) {
    // The trigger is kept with the incident, so it is shown even after the buffer evicted it.
    case "trigger":
      return { ...envelope, ...runQuery([record.trigger], { includeMuted: true }, isMuted, room, display) };
    case "context": {
      const to = record.trigger.ts;
      return { ...envelope, ...runQuery(events, { from: to - CONTEXT_WINDOW_MS, to, cursor: query.cursor }, isMuted, room, display) };
    }
    case "stack": {
      const { all } = framesOf(record.trigger, display);
      return fitPage(all, budget, (frames) => ({ ...envelope, frames, omitted: all.length - frames.length })).result;
    }
    case "code": {
      const full = codeOf(record.trigger, Number.POSITIVE_INFINITY, display);
      if (full === null) return { ...envelope, code: null };
      const left = budget - sizeOf({ ...envelope, code: { ...full, snippet: "" } });
      return { ...envelope, code: { ...full, snippet: clipText(full.snippet, left + 2) } };
    }
  }
}
