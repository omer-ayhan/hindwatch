/** The plugin contract, and all of it that the published `hindwatch` package exports. */
export { PLUGIN_API_VERSION } from "./plugin.js";
export type { Detector, Enricher, Incident, PluginFactory, PluginManifest, Source, SourceContext, SourceHealth } from "./plugin.js";
export type { ClockSample } from "./clock.js";
export type { EventPatch, RedactedEvent } from "./ingest.js";
export type { DebugEvent, RawEvent } from "./schema.js";
