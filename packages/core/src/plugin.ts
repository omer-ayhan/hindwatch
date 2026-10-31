import type { ClockSample } from "./clock.js";
import type { EventPatch, RedactedEvent } from "./ingest.js";
import type { DebugEvent, RawEvent } from "./schema.js";

/** 0.x is unstable: any breaking change bumps it, until three real plugins have shaped the API. */
export const PLUGIN_API_VERSION = "0.1";

/** Real source state for status warnings (not "deaf" when waiting on a device/Metro). */
export interface SourceHealth {
  readonly status: "waiting" | "live" | "idle";
  /** One line agents can show: "no booted simulator", "Metro on port 8081 is not reachable", … */
  readonly detail: string;
}

export interface SourceContext {
  /** Project root the daemon serves. */
  readonly root: string;
  /** Aborted when the daemon stops this source. */
  readonly signal: AbortSignal;
  /** Hands one event to the core, which validates, redacts and timestamps it. */
  emit(event: RawEvent): void;
  /** Records a device clock reading so device time can be mapped onto host time. */
  setClockSample(deviceId: string, sample: ClockSample): void;
  /** Drops a device offset (e.g. clock read failed before history replay). */
  clearClockSample(deviceId: string): void;
  /** Reports why a source is quiet (no device / no sim / Metro down) vs truly deaf. */
  setHealth(health: SourceHealth): void;
  log(message: string): void;
}

export interface Source {
  readonly name: string;
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Transforms events after redaction. Its output is redacted again before it is stored, so an
 * enricher can neither see nor add an unredacted value. Return undefined to leave an event alone.
 */
export interface Enricher {
  readonly name: string;
  enrich(event: RedactedEvent): EventPatch | undefined | Promise<EventPatch | undefined>;
}

/** The smallest incident M2 needs; the M3 incident engine replaces it. */
export interface Incident {
  readonly kind: string;
  readonly title: string;
}

/** Looks at each stored (redacted, enriched) event and may raise an incident about it. */
export interface Detector {
  readonly name: string;
  detect(event: DebugEvent): Incident | undefined;
}

export interface PluginManifest {
  readonly name: string;
  readonly apiVersion: string;
  readonly sources: readonly Source[];
  readonly enrichers?: readonly Enricher[] | undefined;
  readonly detectors?: readonly Detector[] | undefined;
}

export type PluginFactory = (
  options: Readonly<Record<string, unknown>>,
) => PluginManifest | Promise<PluginManifest>;
