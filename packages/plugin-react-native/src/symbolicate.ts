import type { Enricher } from "@hindwatch/core";
import { isRecord, metroUrl, type MetroDeps, type MetroOptions } from "./metro.js";

const SYMBOLICATE_TIMEOUT_MS = 5_000;
/** After a transport failure, skip symbolicate until this many ms pass, then retry once. */
const RETRY_AFTER_MS = 15_000;

/**
 * Maps a react-native event's bundle stack back to source through Metro's /symbolicate, and adds
 * the code frame Metro returns. Both pass back through the redactor, since source can hold secrets.
 *
 * When Metro is unreachable, fails once (daemon log), then skips until a cooldown elapses so a
 * Metro-down stretch does not spam "symbolicate failed: fetch failed" per event.
 */
export function symbolicateEnricher(options: MetroOptions, deps: Pick<MetroDeps, "fetch">): Enricher {
  let skipUntil = 0;
  let announcedDown = false;
  return {
    name: "symbolicate",
    async enrich(event) {
      const { stack } = event.attrs;
      if (event.source !== "react-native" || !Array.isArray(stack) || stack.length === 0) return undefined;
      const now = Date.now();
      if (now < skipUntil) return undefined;
      try {
        const response = await deps.fetch(metroUrl(options.port, "/symbolicate"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stack }),
          signal: AbortSignal.timeout(SYMBOLICATE_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Metro /symbolicate answered ${response.status}`);
        const result: unknown = await response.json();
        if (!isRecord(result) || !Array.isArray(result.stack)) throw new Error("Metro /symbolicate returned no stack");
        skipUntil = 0;
        announcedDown = false;
        return { attrs: { stack: result.stack, codeFrame: result.codeFrame ?? null, symbolicated: true } };
      } catch (error) {
        skipUntil = now + RETRY_AFTER_MS;
        // First failure while down: rethrow so the host logs once. Later events in the window skip.
        if (!announcedDown) {
          announcedDown = true;
          throw error;
        }
        return undefined;
      }
    },
  };
}
