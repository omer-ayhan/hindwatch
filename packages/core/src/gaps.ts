import type { EventBuffer } from "./buffer.js";
import type { EventFilter } from "./query.js";

/**
 * Events fromId..toId (arrival order) may be missing: "evicted" before the read began, or
 * "behind" when a slow reader fell back past the buffer's oldest event. Filters can't be
 * checked on events that are gone, so this is the most that may be missing.
 */
export interface Gap {
  readonly reason: "evicted" | "behind";
  readonly fromId: number;
  readonly toId: number;
  /** Timeline time of the newest missing event. */
  readonly toTs: number;
}

/** What eviction already took from a window. With only a time bound, arrival order stands in for time. */
export function evictedGap(buffer: EventBuffer, filter: EventFilter): Gap | undefined {
  const evicted = buffer.evicted;
  if (evicted === undefined || (filter.from !== undefined && evicted.ts < filter.from)) return undefined;
  const fromId = (filter.sinceId ?? 0) + 1;
  const toId = Math.min(evicted.id, filter.untilId ?? Infinity);
  return toId < fromId ? undefined : { reason: "evicted", fromId, toId, toTs: evicted.ts };
}
