import { isPlainObject } from "./util.js";

export const SCHEMA_VERSION = 1 as const;

export const LEVELS = ["verbose", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

/** What a source emits. Untrusted until parseRawEvent accepts it. */
export interface RawEvent {
  readonly source: string;
  readonly deviceId: string;
  readonly app: string;
  readonly level: Level;
  readonly msg: string;
  readonly pid?: number | undefined;
  /** Device clock in epoch ms. Absent when the source has none. */
  readonly deviceTs?: number | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}

export interface DebugEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Arrival order, starting at 1. The since-cursor. */
  readonly id: number;
  /** Device time mapped onto the host clock. The timeline sorts on this. */
  readonly ts: number;
  readonly deviceTs: number | null;
  /** When the host received the event. */
  readonly hostTs: number;
  /** True when ts fell back to hostTs because the device time or its clock offset is unknown. */
  readonly estimated: boolean;
  readonly source: string;
  readonly deviceId: string;
  readonly app: string;
  /** The app's capture session. Survives pid changes. */
  readonly sessionId: string;
  readonly pid: number | null;
  readonly level: Level;
  readonly msg: string;
  readonly attrs: Readonly<Record<string, unknown>>;
}

export class InvalidEventError extends Error {
  override readonly name = "InvalidEventError";
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new InvalidEventError(`${key} must be a non-empty string`);
  }
  return value;
}

export function parseRawEvent(value: unknown): RawEvent {
  if (!isPlainObject(value)) throw new InvalidEventError("event must be an object");
  const { level, msg, pid, deviceTs, attrs } = value;
  if (!isLevel(level)) throw new InvalidEventError(`level must be one of ${LEVELS.join(", ")}`);
  if (typeof msg !== "string") throw new InvalidEventError("msg must be a string");
  if (pid !== undefined && !Number.isSafeInteger(pid)) throw new InvalidEventError("pid must be an integer");
  if (deviceTs !== undefined && !Number.isFinite(deviceTs)) {
    throw new InvalidEventError("deviceTs must be a finite number");
  }
  if (attrs !== undefined && !isPlainObject(attrs)) throw new InvalidEventError("attrs must be an object");
  return {
    source: requireString(value, "source"),
    deviceId: requireString(value, "deviceId"),
    app: requireString(value, "app"),
    level,
    msg,
    pid: pid as number | undefined,
    deviceTs: deviceTs as number | undefined,
    attrs: attrs as Record<string, unknown> | undefined,
  };
}
