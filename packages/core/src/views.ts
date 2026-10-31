import type { EventBuffer } from "./buffer.js";
import type { IncidentStore } from "./incidents.js";
import { incidentDetail, incidentPart, isIncidentPart, listIncidents } from "./incident-view.js";
import { CONFIG_FILE } from "./config.js";
import { ruleId, type NoiseFile, type NoiseRule } from "./noise.js";
import { patternOf } from "./patterns.js";
import { RpcError } from "./protocol.js";
import type { CompactDisplay } from "./compact-event.js";
import { resolveStale, runPatternQuery, runQuery, type PatternResult, type Query, type QueryResult } from "./query.js";
import { SCHEMA_VERSION } from "./schema.js";
import { isPlainObject } from "./util.js";
import { eventsForQuery } from "./verify.js";

export interface ViewDeps {
  readonly buffer: EventBuffer;
  /** Capped drop-at-ingest ring; merged into query/patterns when includeMuted. */
  readonly mutedBuffer?: EventBuffer | undefined;
  readonly incidents: IncidentStore;
  readonly noise: NoiseFile;
  /** Project root + extra plumbing patterns for compact / incident stack display. */
  readonly display?: CompactDisplay | undefined;
  /** Daemon process start time (ms); stamped on query pages and used for stale flags. */
  readonly startedAt?: number | undefined;
}

function paramsOf(params: unknown): Record<string, unknown> {
  return isPlainObject(params) ? params : {};
}

function optional<T>(params: Record<string, unknown>, key: string, type: "string" | "number" | "boolean"): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new RpcError(`${key} must be a ${type}`);
  return value as T;
}

function required<T>(params: Record<string, unknown>, key: string, type: "string" | "number"): T {
  const value = optional<T>(params, key, type);
  if (value === undefined) throw new RpcError(`${key} is required`);
  return value;
}

const withIds = (rules: readonly NoiseRule[]) => rules.map((rule) => ({ id: ruleId(rule), ...rule }));

function patternIdsOf(params: Record<string, unknown>): string[] {
  const { pattern, patterns } = params;
  if (pattern !== undefined && patterns !== undefined) throw new RpcError("provide pattern or patterns, not both");
  if (typeof pattern === "string" && pattern !== "") return [pattern];
  if (Array.isArray(patterns) && patterns.length > 0 && patterns.every((id) => typeof id === "string" && id !== "")) {
    return patterns as string[];
  }
  throw new RpcError("pattern is required");
}

/** The read and noise methods the daemon serves over its socket. */
export function createViews({ buffer, mutedBuffer, incidents, noise, display = {}, startedAt }: ViewDeps) {
  const incident = (params: Record<string, unknown>) => {
    const id = required<number>(params, "id", "number");
    const record = incidents.get(id);
    if (record === undefined) throw new RpcError(`no incident ${id}; list them with \`hindwatch incidents\``);
    return record;
  };

  const snapshot = (query: Query) => eventsForQuery(buffer, query, mutedBuffer);

  return {
    query: async (query: Query): Promise<QueryResult> =>
      runQuery(snapshot(query), resolveStale(query, startedAt), await noise.filter(), undefined, { display, startedAt }),

    patterns: async (query: Query): Promise<PatternResult> =>
      runPatternQuery(snapshot(query), resolveStale(query, startedAt), await noise.filter()),

    /** Mutes patterns from the buffer, or an iOS subsystem (+ optional category). Returns only what this call muted. */
    mute: async (params: unknown) => {
      const p = paramsOf(params);
      const allSources = optional<boolean>(p, "allSources", "boolean") === true;
      const subsystem = optional<string>(p, "subsystem", "string");
      const category = optional<string>(p, "category", "string");
      const source = optional<string>(p, "source", "string");
      const hasPattern = p.pattern !== undefined || p.patterns !== undefined;
      if (category !== undefined && subsystem === undefined) {
        throw new RpcError("category mute requires subsystem (category alone is refused); pass subsystem+category or a pattern id");
      }
      if (subsystem !== undefined && hasPattern) {
        throw new RpcError("provide pattern/patterns or subsystem, not both");
      }
      const rules: NoiseRule[] = [];
      if (subsystem !== undefined) {
        if (subsystem === "") throw new RpcError("subsystem must be a non-empty string");
        if (category !== undefined && category === "") throw new RpcError("category must be a non-empty string");
        const base =
          category === undefined ? { subsystem } : { subsystem, category };
        rules.push(
          allSources || source === undefined
            ? base
            : { ...base, source },
        );
      } else {
        const ids = patternIdsOf(p);
        const events = buffer.snapshot();
        for (const pattern of ids) {
          const seen = events.find((event) => patternOf(event).id === pattern);
          if (seen === undefined) throw new RpcError(`no pattern ${pattern} in the buffer; list them with \`hindwatch patterns\``);
          const { template } = patternOf(seen);
          rules.push(allSources ? { template } : { template, source: seen.source });
        }
      }
      await noise.muteMany(rules);
      const muted = rules.map((rule) => ({ id: ruleId(rule), ...rule }));
      return muted.length === 1 ? { muted: muted[0], file: CONFIG_FILE } : { muted, file: CONFIG_FILE };
    },

    unmute: async (params: unknown) => {
      const id = required<string>(paramsOf(params), "id", "string");
      const before = await noise.rules();
      const after = await noise.unmute(id);
      if (after.length === before.length) throw new RpcError(`no mute rule ${id}; list them with \`hindwatch noise\``);
      return { unmuted: id, file: CONFIG_FILE };
    },

    noise: async () => ({ schemaVersion: SCHEMA_VERSION, file: CONFIG_FILE, rules: withIds(await noise.rules()) }),

    incidents: (params: unknown) => {
      const p = paramsOf(params);
      return listIncidents(incidents.list(), {
        sinceId: optional<number>(p, "sinceId", "number"),
        cursor: optional<string>(p, "cursor", "string"),
        budgetChars: optional<number>(p, "budgetChars", "number"),
        startedAt,
      });
    },

    incident: async (params: unknown) => {
      const p = paramsOf(params);
      const record = incident(p);
      const budgetChars = optional<number>(p, "budgetChars", "number");
      const part = p.part;
      const isMuted = await noise.filter();
      if (part === undefined) return incidentDetail(record, buffer.snapshot(), budgetChars, isMuted, display, startedAt);
      if (!isIncidentPart(part)) throw new RpcError(`part must be one of trigger, stack, code, context`);
      return incidentPart(record, part, buffer.snapshot(), { budgetChars, cursor: optional<string>(p, "cursor", "string") }, isMuted, display);
    },
  };
}
