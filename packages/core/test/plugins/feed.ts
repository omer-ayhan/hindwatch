import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PLUGIN_API_VERSION, type PluginFactory, type RawEvent, type Source } from "@hindwatch/core";

const POLL_MS = 20;

/**
 * A live fixture app: emits every JSON line a test appends to options.file, so a test can
 * play a repro, a reload and a fix while the daemon runs.
 *
 * When a line carries deviceTs, a zero offset is registered for that deviceId so timeline ts
 * equals deviceTs (skew / sinceLast page-edge proves).
 *
 * With options.enrichDelayMs, events whose attrs.slow is true wait that long in an enricher.
 */
const createFeedPlugin: PluginFactory = (options) => {
  if (typeof options.file !== "string") throw new Error("feed: options.file must be a path");
  const file = options.file;
  const enrichDelayMs = typeof options.enrichDelayMs === "number" ? options.enrichDelayMs : undefined;
  let timer: NodeJS.Timeout | undefined;
  const source: Source = {
    name: "feed",
    async start(ctx) {
      const path = resolve(ctx.root, file);
      let offset = 0;
      let reading = false;
      const sampled = new Set<string>();
      timer = setInterval(() => {
        if (reading) return;
        reading = true;
        void readFile(path, "utf8")
          .then((text) => {
            const end = text.lastIndexOf("\n") + 1;
            for (const line of text.slice(offset, end).split("\n")) {
              if (line.trim() === "" || ctx.signal.aborted) continue;
              const parsed = JSON.parse(line) as Partial<RawEvent>;
              const deviceId = typeof parsed.deviceId === "string" ? parsed.deviceId : "feed-device";
              if (typeof parsed.deviceTs === "number" && !sampled.has(deviceId)) {
                ctx.setClockSample(deviceId, { deviceTs: 0, hostTs: 0 });
                sampled.add(deviceId);
              }
              ctx.emit({ source: "feed", deviceId: "feed-device", app: "com.hindwatch.feed", ...parsed } as RawEvent);
            }
            offset = Math.max(offset, end);
          })
          .catch(() => {})
          .finally(() => {
            reading = false;
          });
      }, POLL_MS);
    },
    async stop() {
      clearInterval(timer);
    },
  };
  // enrichDelayMs holds back events whose attrs.slow is true, like a symbolicator waiting on Metro.
  const enrichers =
    enrichDelayMs === undefined
      ? []
      : [{ name: "feed-slow", enrich: async (e: { attrs: Record<string, unknown> }) => void (e.attrs.slow === true && (await sleep(enrichDelayMs))) }];
  return { name: "feed", apiVersion: PLUGIN_API_VERSION, sources: [source], enrichers };
};

export default createFeedPlugin;
