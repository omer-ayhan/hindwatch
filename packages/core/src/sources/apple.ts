import type { SourceContext } from "../plugin.js";
import { levelRank, type Level, type RawEvent } from "../schema.js";
import { isPlainObject } from "../util.js";

export const IOS_SIM = "ios-sim";
export const IOS = "ios";
/** The sources that read Apple's unified log and crash reports: the simulator, and an iPhone. */
export const APPLE_SOURCES = [IOS_SIM, IOS] as const;
export type AppleSource = (typeof APPLE_SOURCES)[number];

export function isAppleSource(source: string): source is AppleSource {
  return (APPLE_SOURCES as readonly string[]).includes(source);
}

/** Default floor for the iOS sources: Apple frameworks spam Debug and fill the ring in minutes. */
export const IOS_MIN_LEVEL: Level = "info";

/** `log stream --level` values, each one also streaming every type the ones before it do. */
const STREAM_LEVELS = ["default", "info", "debug"] as const;
type StreamLevel = (typeof STREAM_LEVELS)[number];

/** Each unified-logging message type: the level it ingests as, and the stream level that carries it. */
export const MESSAGE_TYPES = {
  Debug: { level: "debug", stream: "debug" },
  Info: { level: "info", stream: "info" },
  Default: { level: "info", stream: "default" },
  Error: { level: "error", stream: "default" },
  Fault: { level: "fatal", stream: "default" },
} as const satisfies Readonly<Record<string, { readonly level: Level; readonly stream: StreamLevel }>>;

/** The narrowest `log stream --level` that still carries every message type at or above minLevel. */
export function streamLevelFor(minLevel: Level): StreamLevel {
  const needed = Object.values(MESSAGE_TYPES)
    .filter((type) => levelRank(type.level) >= levelRank(minLevel))
    .map((type) => STREAM_LEVELS.indexOf(type.stream));
  return STREAM_LEVELS[Math.max(0, ...needed)]!;
}

/** One unified-log entry of the app's, as either Apple source reads it. */
export interface AppleLogEntry {
  readonly pid: number;
  readonly deviceTs: number;
  readonly level: Level;
  readonly msg: string;
  readonly subsystem: string;
  readonly category: string;
}

/**
 * Emits the app's log entries as events, muted below minLevel at the source so spam below the
 * configured level never enters the ring. onRestart runs when the app comes back under a new pid.
 */
export function appLogEvents(ctx: SourceContext, source: AppleSource, udid: string, bundleId: string, minLevel: Level, onRestart: () => void): (entry: AppleLogEntry) => void {
  let pid: number | undefined;
  return (entry) => {
    if (entry.pid !== pid) {
      if (pid !== undefined) {
        ctx.log(`${bundleId} restarted: pid ${pid} -> ${entry.pid}`);
        onRestart();
      }
      pid = entry.pid;
    }
    if (levelRank(entry.level) < levelRank(minLevel)) return;
    ctx.emit({
      source,
      deviceId: udid,
      app: bundleId,
      pid: entry.pid,
      deviceTs: entry.deviceTs,
      level: entry.level,
      msg: entry.msg,
      attrs: { subsystem: entry.subsystem, category: entry.category },
    });
  };
}

/** "2026-10-23 16:29:15.620053+0300" (log stream) or "2026-10-30 11:54:20.5827 +0300" (crash report) -> epoch ms. */
export function parseAppleTimestamp(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d* ?([+-]\d{2})(\d{2})$/.exec(value);
  return match === null ? Number.NaN : Date.parse(`${match[1]}T${match[2]}${match[3] ?? ""}${match[4]}:${match[5]}`);
}

export interface CrashReport {
  readonly bundleId: string | undefined;
  readonly procName: string;
  readonly procPath: string;
  readonly pid: number | undefined;
  readonly exceptionType: string | undefined;
  readonly signal: string | undefined;
  readonly termination: string | undefined;
  /** When the process crashed, which can be well before the report is written. */
  readonly capturedAt: number | undefined;
}

/** An .ips crash report: a JSON header line, then the JSON body. Undefined until both parse. */
export function parseCrashReport(text: string): CrashReport | undefined {
  const newline = text.indexOf("\n");
  if (newline < 0) return undefined;
  let header: unknown;
  let body: unknown;
  try {
    header = JSON.parse(text.slice(0, newline));
    body = JSON.parse(text.slice(newline + 1));
  } catch {
    return undefined;
  }
  if (!isPlainObject(header) || !isPlainObject(body) || typeof body.procPath !== "string") return undefined;
  const stringOf = (value: unknown) => (typeof value === "string" ? value : undefined);
  const exception = isPlainObject(body.exception) ? body.exception : {};
  const termination = isPlainObject(body.termination) ? body.termination : {};
  const bundleInfo = isPlainObject(body.bundleInfo) ? body.bundleInfo : {};
  const capturedAt = typeof body.captureTime === "string" ? parseAppleTimestamp(body.captureTime) : Number.NaN;
  return {
    bundleId: stringOf(header.bundleID) ?? stringOf(bundleInfo.CFBundleIdentifier),
    procName: stringOf(body.procName) ?? stringOf(header.name) ?? body.procPath,
    procPath: body.procPath,
    pid: Number.isSafeInteger(body.pid) ? (body.pid as number) : undefined,
    exceptionType: stringOf(exception.type),
    signal: stringOf(exception.signal),
    termination: stringOf(termination.indicator),
    capturedAt: Number.isNaN(capturedAt) ? undefined : capturedAt,
  };
}

/** One line for the timeline and the incident title: what crashed, and how. */
export function crashMessage(report: CrashReport): string {
  const how = [report.exceptionType, report.signal === undefined ? undefined : `(${report.signal})`].filter((part) => part !== undefined).join(" ");
  const why = report.termination === undefined ? "" : `: ${report.termination}`;
  return `${report.procName} crashed${how === "" ? "" : ` with ${how}`}${why}`;
}

/** The fatal event for a crash report: `crashReport` names the report and marks the event as a crash. */
export function crashEvent(source: AppleSource, deviceId: string, app: string, report: CrashReport, location: string): RawEvent {
  return {
    source,
    deviceId,
    app,
    ...(report.pid === undefined ? {} : { pid: report.pid }),
    ...(report.capturedAt === undefined ? {} : { deviceTs: report.capturedAt }),
    level: "fatal",
    msg: crashMessage(report),
    attrs: {
      crashReport: location,
      ...(report.exceptionType === undefined ? {} : { exceptionType: report.exceptionType }),
      ...(report.signal === undefined ? {} : { signal: report.signal }),
    },
  };
}
