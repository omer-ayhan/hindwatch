import { setTimeout as sleep } from "node:timers/promises";
import type { Source, SourceContext } from "../plugin.js";
import { errorMessage } from "../util.js";

/** A source whose whole life is one watch, which runs until stop() or the host aborts it. */
export function loopSource(name: string, watch: (ctx: SourceContext, signal: AbortSignal) => Promise<void>): Source {
  const stopped = new AbortController();
  let loop: Promise<void> | undefined;
  return {
    name,
    async start(ctx) {
      loop = watch(ctx, AbortSignal.any([ctx.signal, stopped.signal]));
    },
    async stop() {
      stopped.abort();
      await loop;
    },
  };
}

/**
 * Attaches again and again until the signal aborts, waiting restartMs between attaches. An attach
 * runs until its stream ends or fails; it calls live once it streams. A failure leaves the source
 * waiting, logged once while it stays the same.
 */
export async function reattach(ctx: SourceContext, signal: AbortSignal, restartMs: number, attach: (live: (detail: string) => void) => Promise<void>): Promise<void> {
  let lastError: string | undefined;
  const live = (detail: string) => {
    lastError = undefined;
    ctx.setHealth({ status: "live", detail });
  };
  while (!signal.aborted) {
    try {
      await attach(live);
    } catch (error) {
      const message = errorMessage(error);
      if (!signal.aborted) {
        ctx.setHealth({ status: "waiting", detail: message });
        if (message !== lastError) ctx.log(message);
      }
      lastError = message;
    }
    await sleep(restartMs, undefined, { signal }).catch(() => {});
  }
}
