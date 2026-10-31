import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PLUGIN_API_VERSION, type PluginFactory, type RawEvent, type Source } from "@hindwatch/core";

/** After the one-time replay, keep cycling through the file's events at a fixed rate. */
export interface FixtureRate {
  readonly eventsPerSecond: number;
  readonly seconds: number;
}

export interface FixtureOptions {
  /** JSONL file of events, resolved against the project root. */
  readonly file: string;
  /** Simulated device clock skew in ms (device minus host), per deviceId. */
  readonly clockSkewMs: Readonly<Record<string, number>>;
  readonly rate: FixtureRate | undefined;
  /**
   * During rate flood, stamp events as fixture-0..fixture-(n-1) so a multi-source
   * burst can fill the global buffer under per-source quotas (maxEventsPerSource).
   */
  readonly rateSources: number | undefined;
}

const TICK_MS = 20;

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function parseRate(rate: unknown): FixtureRate | undefined {
  if (rate === undefined) return undefined;
  const { eventsPerSecond, seconds } = (typeof rate === "object" && rate !== null ? rate : {}) as Record<string, unknown>;
  if (!isPositive(eventsPerSecond) || !isPositive(seconds)) {
    throw new Error("fixture: options.rate needs positive eventsPerSecond and seconds");
  }
  return { eventsPerSecond, seconds };
}

function parseOptions(options: Readonly<Record<string, unknown>>): FixtureOptions {
  const { file, clockSkewMs = {}, rate, rateSources } = options;
  if (typeof file !== "string") throw new Error("fixture: options.file must be a path");
  if (typeof clockSkewMs !== "object" || clockSkewMs === null) {
    throw new Error("fixture: options.clockSkewMs must map deviceId to ms");
  }
  for (const [deviceId, skew] of Object.entries(clockSkewMs)) {
    if (typeof skew !== "number") throw new Error(`fixture: clockSkewMs.${deviceId} must be a number`);
  }
  if (rateSources !== undefined && !(typeof rateSources === "number" && Number.isInteger(rateSources) && rateSources >= 1)) {
    throw new Error("fixture: options.rateSources must be an integer >= 1");
  }
  return {
    file,
    clockSkewMs: clockSkewMs as Record<string, number>,
    rate: parseRate(rate),
    rateSources: rateSources as number | undefined,
  };
}

/** Replays recorded events once on start, then at options.rate if set. The core validates every event. */
const createFixturePlugin: PluginFactory = (options) => {
  const { file, clockSkewMs, rate, rateSources } = parseOptions(options);
  let timer: NodeJS.Timeout | undefined;
  const source: Source = {
    name: "fixture",
    async start(ctx) {
      const now = Date.now();
      for (const [deviceId, skew] of Object.entries(clockSkewMs)) {
        ctx.setClockSample(deviceId, { deviceTs: now + skew, hostTs: now });
      }
      const text = await readFile(resolve(ctx.root, file), "utf8");
      const events = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => ({ source: "fixture", app: "com.hindwatch.fixture", ...(JSON.parse(line) as object) }) as RawEvent);
      for (const event of events) {
        if (ctx.signal.aborted) return;
        ctx.emit(event);
      }
      if (rate === undefined || events.length === 0) return;
      // Replayed events are stamped now, as a live device would, so the buffer keeps them by count.
      const startedAt = Date.now();
      let sent = 0;
      timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const due = Math.floor((Math.min(elapsed, rate.seconds * 1_000) * rate.eventsPerSecond) / 1_000);
        for (; sent < due && !ctx.signal.aborted; sent++) {
          const event = events[sent % events.length]!;
          const shards = rateSources ?? 1;
          ctx.emit({
            ...event,
            ...(shards > 1 ? { source: `fixture-${sent % shards}` } : {}),
            deviceTs: Date.now() + (clockSkewMs[event.deviceId] ?? 0),
          });
        }
        if (elapsed >= rate.seconds * 1_000 || ctx.signal.aborted) clearInterval(timer);
      }, TICK_MS);
    },
    async stop() {
      clearInterval(timer);
    },
  };
  return { name: "fixture", apiVersion: PLUGIN_API_VERSION, sources: [source] };
};

export default createFixturePlugin;
