import { PLUGIN_API_VERSION, type PluginFactory, type PluginManifest } from "@hindwatch/core";
import { cdpSource } from "./cdp.js";
import { redboxDetector } from "./detect.js";
import { connectWebSocket, type MetroDeps, type MetroOptions } from "./metro.js";
import { symbolicateEnricher } from "./symbolicate.js";
export { symbolicateEnricher } from "./symbolicate.js";

export { formatArg, parseCdpEvent, parseTargets, type MetroTarget } from "./cdp.js";
export type { CdpConnection, CdpHandlers, Connect, MetroDeps, MetroOptions } from "./metro.js";

const DEFAULT_PORT = 8081;
const DEFAULT_CLOCK_RESYNC_MS = 60_000;

function positiveInteger(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`react-native: options.${key} must be a positive integer`);
  }
  return value;
}

export function parseOptions(options: Readonly<Record<string, unknown>>): MetroOptions {
  return {
    port: positiveInteger(options.port, "port", DEFAULT_PORT),
    clockResyncMs: positiveInteger(options.clockResyncMs, "clockResyncMs", DEFAULT_CLOCK_RESYNC_MS),
  };
}

export function createReactNativePlugin(options: MetroOptions, deps: MetroDeps): PluginManifest {
  return {
    name: "react-native",
    apiVersion: PLUGIN_API_VERSION,
    sources: [cdpSource(options, deps)],
    enrichers: [symbolicateEnricher(options, deps)],
    detectors: [redboxDetector],
  };
}

const createPlugin: PluginFactory = (options) =>
  createReactNativePlugin(parseOptions(options), { fetch, connect: connectWebSocket, pollMs: 2_000 });

export default createPlugin;
