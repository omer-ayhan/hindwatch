import type { EventBuffer } from "./buffer.js";
import { evictedGap, type Gap } from "./gaps.js";
import { sizeOf } from "./budget.js";
import type { CompactDisplay, CompactEvent } from "./compact-event.js";
import type { RedactedEvent } from "./ingest.js";
import { matches, runQuery, type MuteFilter, type Query, type QueryResult } from "./query.js";
import type { DebugEvent } from "./schema.js";

const SCAN_BATCH = 1_000;

export const DEFAULT_WAIT_MS = 30_000;

/** Merge main + optional muted side-buffer after `afterId`, by id, capped to `limit`. */
function afterIncludingMuted(
  buffer: EventBuffer,
  mutedBuffer: EventBuffer | undefined,
  includeMuted: boolean,
  afterId: number,
  limit: number,
): DebugEvent[] {
  const main = buffer.after(afterId, limit);
  if (!includeMuted || mutedBuffer === undefined) return main;
  const side = mutedBuffer.after(afterId, limit);
  if (side.length === 0) return main;
  if (main.length === 0) return side;
  return [...main, ...side].sort((a, b) => a.id - b.id).slice(0, limit);
}

/**
 * Resolves with the first event that matches, or undefined on timeout or abort. With a since
 * bound it also looks at what is already buffered; without one it only sees what arrives next.
 * Muted events are skipped unless `filter.includeMuted`, matching expect/logs. Drop-at-ingest
 * muted rows live on `mutedBuffer` (not the main ring); pass it so --include-muted still works.
 */
export function waitFor(
  buffer: EventBuffer,
  filter: Query,
  timeoutMs: number,
  signal: AbortSignal,
  isMuted: MuteFilter = () => false,
  mutedBuffer?: EventBuffer,
): Promise<DebugEvent | undefined> {
  const includeMuted = filter.includeMuted === true;
  const tip = () =>
    Math.max(buffer.lastId, includeMuted && mutedBuffer !== undefined ? mutedBuffer.lastId : 0);
  let cursor = filter.sinceId ?? (filter.from !== undefined ? 0 : tip());
  const scan = (): DebugEvent | undefined => {
    for (
      let batch = afterIncludingMuted(buffer, mutedBuffer, includeMuted, cursor, SCAN_BATCH);
      batch.length > 0;
      batch = afterIncludingMuted(buffer, mutedBuffer, includeMuted, cursor, SCAN_BATCH)
    ) {
      for (const event of batch) {
        if (!matches(event, filter)) continue;
        if (!includeMuted && isMuted(event)) continue;
        return event;
      }
      cursor = batch.at(-1)!.id;
    }
    return undefined;
  };
  return new Promise((resolve) => {
    const found = scan();
    if (found !== undefined || signal.aborted) return resolve(found);
    const finish = (event: DebugEvent | undefined) => {
      off();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(event);
    };
    const abort = () => finish(undefined);
    const onPush = () => {
      const event = scan();
      if (event !== undefined) finish(event);
    };
    const unsubs = [buffer.onPush(onPush)];
    if (includeMuted && mutedBuffer !== undefined) unsubs.push(mutedBuffer.onPush(onPush));
    const off = () => {
      for (const unsub of unsubs) unsub();
    };
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface WaitResult {
  readonly matched: boolean;
  readonly waitedMs: number;
  /** Clipped like a query result so the answer fits the budget. */
  readonly event: CompactEvent | null;
  /** Set on a miss when the query names a source that nothing has run or emitted under yet. */
  readonly warning?: string;
}

export function waitResult(event: DebugEvent | undefined, waitedMs: number, budget: number, warning?: string): WaitResult {
  const head = { matched: event !== undefined, waitedMs, event: null };
  if (event === undefined) return warning === undefined ? head : { ...head, warning };
  const [fitted] = runQuery([event], {}, undefined, budget - sizeOf(head)).events;
  return { ...head, event: fitted ?? null };
}

export type Expectation = "absent" | "present";

export type ExpectResult = {
  readonly ok: boolean;
  readonly expect: Expectation;
  /** Matching events that count for ok (muted excluded unless includeMuted), including any beyond the page. */
  readonly matched: number;
  /** Set when eviction took part of the window, so an absence there can't be proven. */
  readonly gap?: Gap;
  /** Id and timeline span actually searched (min/max over the bound after since/until). */
  readonly window: {
    readonly fromId: number;
    readonly toId: number;
    readonly fromTs?: number;
    readonly toTs?: number;
  };
  /** Set when the search had no since/sinceId/from — whole-buffer absent can false-confidence. */
  readonly warning?: string;
  /** Events emitted but still waiting for enrichers when the check ran; an absence can't be proven past them. */
  readonly pending?: number;
} & QueryResult;

/**
 * Checks the buffered window now. `matched` / `ok` honor mute the same way the returned page does:
 * muted hits are excluded unless `query.includeMuted`. The page's `muted` count still reports
 * how many matching events the noise file hid.
 */
function expectWindow(events: readonly DebugEvent[], query: Query): ExpectResult["window"] {
  const bound = events.filter(
    (e) =>
      (query.sinceId === undefined || e.id > query.sinceId) &&
      (query.untilId === undefined || e.id <= query.untilId) &&
      (query.from === undefined || e.ts >= query.from) &&
      (query.to === undefined || e.ts <= query.to),
  );
  // Min/max over the bound so fromId/toId and fromTs/toTs always contain every searched row
  // (arrival order can put a later id with an earlier ts when clocks differ across sources).
  let fromId = 0;
  let toId = 0;
  let fromTs: number | undefined;
  let toTs: number | undefined;
  for (const e of bound) {
    if (fromId === 0 || e.id < fromId) fromId = e.id;
    if (e.id > toId) toId = e.id;
    if (fromTs === undefined || e.ts < fromTs) fromTs = e.ts;
    if (toTs === undefined || e.ts > toTs) toTs = e.ts;
  }
  return {
    fromId,
    toId,
    ...(fromTs !== undefined ? { fromTs } : {}),
    ...(toTs !== undefined ? { toTs } : {}),
  };
}

function unboundSince(query: Query): boolean {
  return query.sinceId === undefined && query.from === undefined && query.sinceMark === undefined;
}

/** Snapshot for expect/logs: main ring, plus muted side-buffer when includeMuted. */
export function eventsForQuery(
  buffer: EventBuffer,
  query: Pick<Query, "includeMuted">,
  mutedBuffer?: EventBuffer,
): DebugEvent[] {
  const main = buffer.snapshot();
  if (query.includeMuted !== true || mutedBuffer === undefined || mutedBuffer.size === 0) {
    return [...main];
  }
  return [...main, ...mutedBuffer.snapshot()].sort((a, b) => a.id - b.id);
}

/** Whether a not-yet-stored event could land in the query's window; it gets an id after every stored one. */
export function mayLandInWindow(event: RedactedEvent, query: Query): boolean {
  return matches({ ...event, id: Number.POSITIVE_INFINITY }, query);
}

export function expectEvents(
  buffer: EventBuffer,
  query: Query,
  expect: Expectation,
  budget: number,
  isMuted: MuteFilter = () => false,
  display: CompactDisplay = {},
  mutedBuffer?: EventBuffer,
  pending = 0,
): ExpectResult {
  const events = eventsForQuery(buffer, query, mutedBuffer);
  const includeMuted = query.includeMuted === true;
  let matched = 0;
  let mutedHits = 0;
  for (const event of events) {
    if (!matches(event, query)) continue;
    if (!includeMuted && isMuted(event)) {
      mutedHits++;
      continue;
    }
    matched++;
  }
  // Drop-at-ingest: muted rows live on the side ring. Count them for the absent warning even
  // when includeMuted is off (they are not in `events` then).
  if (!includeMuted && mutedBuffer !== undefined && mutedBuffer.size > 0) {
    for (const event of mutedBuffer.snapshot()) {
      if (matches(event, query) && isMuted(event)) mutedHits++;
    }
  }
  const gap = evictedGap(buffer, query);
  const window = expectWindow(events, query);
  const warnings: string[] = [];
  if (unboundSince(query)) {
    warnings.push(
      "no since/sinceId/from; searched the entire buffer — prefer a mark or sinceId so absent cannot false-pass on old rows",
    );
  }
  // Absent that only hid muted matches looks like a clean pass — surface the muted count.
  if (expect === "absent" && matched === 0 && mutedHits > 0 && !includeMuted) {
    warnings.push(
      `${mutedHits} muted matching event(s) were hidden; absent can false-pass — pass includeMuted or unmute`,
    );
  }
  if (expect === "absent" && matched === 0 && pending > 0) {
    warnings.push(`${pending} event(s) were still being enriched; absent cannot be proven yet — check again`);
  }
  const warning = warnings.length === 0 ? undefined : warnings.join("; ");
  const head = {
    ok: expect === "present" ? matched > 0 : matched === 0 && pending === 0,
    expect,
    matched,
    window,
    ...(warning !== undefined ? { warning } : {}),
    ...(gap === undefined ? {} : { gap }),
    ...(pending > 0 ? { pending } : {}),
  };
  return { ...head, ...runQuery(events, query, isMuted, budget - JSON.stringify(head).length - 1, display) };
}
