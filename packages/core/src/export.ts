import type { Writable } from "node:stream";
import type { EventBuffer } from "./buffer.js";
import { evictedGap, type Gap } from "./gaps.js";
import { matches, type EventFilter } from "./query.js";

const BATCH = 500;

export interface ExportEnd {
  /** "done" once the window is fully written; "closed" if the reader or the daemon went first. */
  readonly reason: "done" | "closed";
  readonly events: number;
  readonly gaps: number;
}

/**
 * Streams a window of the buffer to `out` as JSON lines: events in arrival order, a
 * `{"gap":…}` line wherever events were evicted before they could be sent, and a final
 * `{"end":…}`. It reads the buffer a batch at a time and waits for `drain` on a slow reader,
 * so the daemon never blocks and never holds more than a batch; whatever the buffer evicts
 * meanwhile becomes a gap. Without follow, the window ends at the newest event at the start.
 */
export function streamExport(out: Writable, buffer: EventBuffer, filter: EventFilter, follow: boolean): Promise<ExportEnd> {
  const until = Math.min(filter.untilId ?? Infinity, follow ? Infinity : buffer.lastId);
  let cursor = filter.sinceId ?? 0;
  let events = 0;
  let gaps = 0;
  let chunk = "";
  let unsubscribe: (() => void) | undefined;
  let finished = false;
  const open = () => !out.destroyed && !out.writableEnded;
  const addGap = (gap: Gap) => {
    gaps++;
    cursor = gap.toId;
    chunk += `${JSON.stringify({ gap })}\n`;
  };

  return new Promise((resolve) => {
    const finish = (reason: ExportEnd["reason"]) => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      out.off("close", closed);
      if (reason === "done" && open()) out.end(`${JSON.stringify({ end: { events, gaps } })}\n`);
      resolve({ reason, events, gaps });
    };
    const closed = () => finish("closed");
    out.once("close", closed);

    const pump = () => {
      if (finished) return;
      if (!open()) return finish("closed");
      const evicted = buffer.evicted;
      if (evicted !== undefined && evicted.id > cursor && cursor < until) {
        addGap({ reason: "behind", fromId: cursor + 1, toId: Math.min(evicted.id, until), toTs: evicted.ts });
      }
      const batch = cursor < until ? buffer.after(cursor, BATCH).filter((event) => event.id <= until) : [];
      for (const event of batch) {
        if (!matches(event, filter)) continue;
        chunk += `${JSON.stringify(event)}\n`;
        events++;
      }
      if (batch.length > 0) cursor = batch.at(-1)!.id;
      const flushed = chunk === "" || out.write(chunk);
      chunk = "";
      if (cursor >= until) return finish("done");
      if (!flushed) return void out.once("drain", pump);
      if (batch.length > 0) return void setImmediate(pump);
      // Caught up with a live window: wait for the next event.
      unsubscribe = buffer.onPush(() => {
        unsubscribe?.();
        unsubscribe = undefined;
        setImmediate(pump);
      });
    };

    const first = evictedGap(buffer, { ...filter, untilId: until });
    if (first !== undefined) addGap(first);
    // Evicted events a time bound already excludes are skipped without a gap.
    cursor = Math.max(cursor, Math.min(buffer.evicted?.id ?? 0, until));
    pump();
  });
}
