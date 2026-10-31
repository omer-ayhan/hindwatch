import { budgetOf, sizeOf } from "./budget.js";
import { call, ensureDaemon, type EnsureResult } from "./client.js";
import { isMarkName } from "./marks.js";
import { parseListCursor } from "./incident-view.js";
import { parseCursor, parseOffsetCursor, parseQuery, type Query } from "./query.js";
import { DEFAULT_WAIT_MS } from "./verify.js";

/**
 * The daemon requests the CLI and the MCP server both make, built in one place so the two
 * surfaces share the same queries, budget, `next` cursors and output.
 */

/** A request the caller got wrong, as opposed to one the daemon failed. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** How much longer than its own timeout a wait-for answer is given to arrive. */
const CALL_SLACK_MS = 5_000;

/** A --since/--until value: epoch ms, an ISO 8601 time, or one of this client's marks. */
export type Instant = string | number;

export interface Filters {
  readonly sinceId?: number | undefined;
  readonly since?: Instant | undefined;
  readonly until?: Instant | undefined;
  readonly sources?: readonly string[] | undefined;
  readonly level?: string | undefined;
  readonly app?: string | undefined;
  readonly pattern?: string | undefined;
  readonly includeMuted?: boolean | undefined;
  /** false = live only (ts >= daemon start); true = pre-start replay only. */
  readonly stale?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly text?: string | undefined;
  /** asc = oldest first (default), desc = newest first. */
  readonly order?: "asc" | "desc" | undefined;
}

function instant(flag: string, value: Instant | undefined): { time?: number; mark?: string } {
  if (value === undefined) return {};
  if (typeof value === "number") return { time: value };
  if (/^\d+$/.test(value)) return { time: Number(value) };
  if (isMarkName(value)) return { mark: value };
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new UsageError(`--${flag} takes a mark name, epoch ms or an ISO time`);
  return { time };
}

/** Validated before anything is sent, so a bad filter fails before a daemon is started for it. */
export function queryOf(filters: Filters, checkCursor: (cursor: string) => unknown = parseCursor): Query {
  if (filters.cursor !== undefined) checkCursor(filters.cursor);
  const since = instant("since", filters.since);
  const until = instant("until", filters.until);
  return parseQuery({
    sinceId: filters.sinceId,
    from: since.time,
    sinceMark: since.mark,
    to: until.time,
    untilMark: until.mark,
    sources: filters.sources,
    minLevel: filters.level,
    app: filters.app,
    pattern: filters.pattern,
    includeMuted: filters.includeMuted === true ? true : undefined,
    stale: filters.stale,
    cursor: filters.cursor,
    text: filters.text,
    order: filters.order,
  });
}

export interface DaemonRequest {
  readonly method: string;
  /** Built once the budget left for the daemon's answer is known. */
  params(budgetChars: number): Record<string, unknown>;
  readonly timeoutMs?: number;
  /** For checks: whether the answer held. One that didn't is exit 1 on the CLI and a tool error over MCP. */
  readonly held?: (result: Record<string, unknown>) => boolean;
}

const plain = (method: string, params: Record<string, unknown>): DaemonRequest => ({ method, params: () => params });

export const requests = {
  logs: (clientId: string, filters: Filters, sinceLast: boolean): DaemonRequest => {
    const query = queryOf(filters);
    return { method: "query", params: (budgetChars) => ({ clientId, sinceLast, query: { ...query, budgetChars } }) };
  },
  patterns: (clientId: string, filters: Filters): DaemonRequest => {
    const query = queryOf(filters, parseOffsetCursor);
    return { method: "patterns", params: (budgetChars) => ({ clientId, query: { ...query, budgetChars } }) };
  },
  mark: (clientId: string, name: string) => plain("mark", { clientId, name }),
  marks: (clientId: string) => plain("marks", { clientId }),
  waitFor: (clientId: string, filters: Filters, timeoutMs = DEFAULT_WAIT_MS): DaemonRequest => {
    const query = queryOf(filters);
    return {
      method: "waitFor",
      params: (budgetChars) => ({ clientId, timeoutMs, query: { ...query, budgetChars } }),
      timeoutMs: timeoutMs + CALL_SLACK_MS,
      held: (result) => result.matched === true,
    };
  },
  expect: (clientId: string, expect: "absent" | "present", filters: Filters, timeoutMs = DEFAULT_WAIT_MS): DaemonRequest => {
    const query = queryOf(filters);
    return {
      method: "expect",
      params: (budgetChars) => ({ clientId, expect, timeoutMs, query: { ...query, budgetChars } }),
      timeoutMs: timeoutMs + CALL_SLACK_MS,
      held: (result) => result.ok === true,
    };
  },
  incidents: (sinceId: number | undefined, cursor: string | undefined): DaemonRequest => {
    if (cursor !== undefined) parseListCursor(cursor);
    return { method: "incidents", params: (budgetChars) => ({ sinceId, cursor, budgetChars }) };
  },
  incident: (id: number, part: string | undefined, cursor: string | undefined): DaemonRequest => {
    if (part === "context" && cursor !== undefined) parseCursor(cursor);
    return { method: "incident", params: (budgetChars) => ({ id, part, cursor, budgetChars }) };
  },
  mute: (
    pattern: string | readonly string[],
    allSources: boolean,
    scope?: { readonly subsystem: string; readonly category?: string; readonly source?: string },
  ): DaemonRequest => {
    if (scope !== undefined) {
      if (scope.category !== undefined && scope.subsystem === "") {
        throw new UsageError("mute subsystem must be non-empty");
      }
      return plain("mute", {
        subsystem: scope.subsystem,
        ...(scope.category !== undefined ? { category: scope.category } : {}),
        ...(scope.source !== undefined ? { source: scope.source } : {}),
        allSources,
      });
    }
    const patterns = (typeof pattern === "string" ? [pattern] : [...pattern]).filter((id) => id !== "");
    if (patterns.length === 0) throw new UsageError("mute needs a pattern id");
    return patterns.length === 1
      ? plain("mute", { pattern: patterns[0], allSources })
      : plain("mute", { patterns, allSources });
  },
  unmute: (id: string) => plain("unmute", { id }),
  noise: () => plain("noise", {}),
};

/** Added to an answer when the call had to launch the daemon. */
export function daemonNote(ensured: EnsureResult): Record<string, unknown> {
  return ensured.started ? { daemon: { started: true, note: "daemon (re)started: history begins now" } } : {};
}

/** Makes one call, holding the daemon's answer plus the note to the requested budget. */
export async function send(
  root: string,
  request: DaemonRequest,
  budget: number | undefined,
  note: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const total = budgetOf(budget);
  const budgetChars = Object.keys(note).length === 0 ? total : total - sizeOf(note) - 1;
  const result = (await call(root, request.method, request.params(budgetChars), request.timeoutMs)) as Record<string, unknown>;
  return { ...result, ...note };
}

/** Ensures the daemon, then sends: what every CLI read does. */
export async function ensureAndSend(root: string, request: DaemonRequest, budget: number | undefined): Promise<Record<string, unknown>> {
  return send(root, request, budget, daemonNote(await ensureDaemon(root)));
}
