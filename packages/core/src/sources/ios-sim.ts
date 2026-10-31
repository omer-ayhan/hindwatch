import { readFile, watch as watchDir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Source, SourceContext } from "../plugin.js";
import { supervisedRunner, type ProcessRunner } from "../proc.js";
import type { Level } from "../schema.js";
import { errorMessage, isPlainObject } from "../util.js";
import { loopSource, reattach } from "./loop.js";
import { appLogEvents, crashEvent, IOS_MIN_LEVEL, IOS_SIM, MESSAGE_TYPES, parseAppleTimestamp, parseCrashReport, streamLevelFor } from "./apple.js";

export interface IosSimOptions {
  readonly bundleId: string;
  /** Process name for the log predicate. Defaults to the app's CFBundleExecutable. */
  readonly process: string | undefined;
  /** Simulator udid. Defaults to the booted one. */
  readonly device: string | undefined;
  /**
   * Lowest level to ingest. Defaults to {@link IOS_MIN_LEVEL} (`info`): Apple frameworks
   * spam Debug and fill the ring in minutes. Set `debug` or `verbose` when a native bug needs it.
   */
  readonly minLevel: Level | undefined;
}

export interface IosSimDeps {
  readonly runner: ProcessRunner;
  /** Wait before restarting a log stream that ended (simulator shut down, app not installed yet). */
  readonly restartMs: number;
  /** Where macOS writes crash reports, simulator apps' included. */
  readonly crashReportsDir: string;
}

export interface SimLogLine {
  readonly deviceTs: number;
  readonly pid: number;
  readonly level: Level;
  readonly msg: string;
  readonly subsystem: string;
  readonly category: string;
}

/** Undefined for anything that isn't a log event: `log stream` also prints banners and activity events. */
export function parseSimLogLine(line: string): SimLogLine | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(record) || record.eventType !== "logEvent") return undefined;
  const { messageType, eventMessage, processID, timestamp, subsystem, category } = record;
  const level = typeof messageType === "string" && Object.hasOwn(MESSAGE_TYPES, messageType) ? MESSAGE_TYPES[messageType as keyof typeof MESSAGE_TYPES].level : undefined;
  const deviceTs = typeof timestamp === "string" ? parseAppleTimestamp(timestamp) : Number.NaN;
  if (level === undefined || typeof eventMessage !== "string" || !Number.isSafeInteger(processID) || Number.isNaN(deviceTs)) {
    return undefined;
  }
  return {
    deviceTs,
    pid: processID as number,
    level,
    msg: eventMessage,
    subsystem: typeof subsystem === "string" ? subsystem : "",
    category: typeof category === "string" ? category : "",
  };
}

/** The udid of the first booted simulator in `simctl list devices booted -j`. */
export function bootedUdid(json: string): string | undefined {
  const parsed: unknown = JSON.parse(json);
  const runtimes = isPlainObject(parsed) && isPlainObject(parsed.devices) ? Object.values(parsed.devices) : [];
  for (const devices of runtimes) {
    for (const device of Array.isArray(devices) ? devices : []) {
      if (isPlainObject(device) && device.state === "Booted" && typeof device.udid === "string") return device.udid;
    }
  }
  return undefined;
}

function bundleExecutable(appinfo: string): string | undefined {
  return /CFBundleExecutable = "?([^";\n]+)"?;/.exec(appinfo)?.[1];
}

/**
 * Streams one app's unified log from a simulator. The predicate matches the process by name, so a
 * restarted app (new pid) shows up in the same stream and stays in the same session.
 */
export function iosSimSource(options: IosSimOptions, overrides: Partial<IosSimDeps> = {}): Source {
  const deps: IosSimDeps = {
    runner: overrides.runner ?? supervisedRunner(),
    restartMs: overrides.restartMs ?? 2_000,
    crashReportsDir: overrides.crashReportsDir ?? join(homedir(), "Library", "Logs", "DiagnosticReports"),
  };
  return loopSource(IOS_SIM, (ctx, signal) => watch(ctx, options, deps, signal));
}

/**
 * The log stream ends with the process, so a crash shows up only as a crash report. Each new report
 * for this app on this simulator becomes a fatal event; a report is read again until it parses.
 */
async function watchCrashReports(ctx: SourceContext, bundleId: string, udid: string, dir: string, signal: AbortSignal): Promise<void> {
  const handled = new Set<string>();
  try {
    for await (const { filename } of watchDir(dir, { signal })) {
      if (filename === null || !filename.endsWith(".ips") || handled.has(filename)) continue;
      const path = join(dir, filename);
      const report = parseCrashReport(await readFile(path, "utf8").catch(() => ""));
      if (report === undefined) continue;
      handled.add(filename);
      if (report.bundleId !== bundleId || !report.procPath.includes(`/${udid}/`)) continue;
      ctx.emit(crashEvent(IOS_SIM, udid, bundleId, report, path));
    }
  } catch (error) {
    if (!signal.aborted) ctx.log(`crash reports in ${dir} are not watched: ${errorMessage(error)}`);
  }
}

function watch(ctx: SourceContext, options: IosSimOptions, deps: IosSimDeps, signal: AbortSignal): Promise<void> {
  const { runner } = deps;
  const simctl = (args: readonly string[]) => runner.run("xcrun", ["simctl", ...args]);
  return reattach(ctx, signal, deps.restartMs, async (live) => {
    const streamEnded = new AbortController();
    let crashes: Promise<void> | undefined;
    try {
      const udid = options.device ?? bootedUdid(await simctl(["list", "devices", "booted", "-j"]));
      if (udid === undefined) throw new Error("no booted simulator");
      const process = options.process ?? bundleExecutable(await simctl(["appinfo", udid, options.bundleId]));
      if (process === undefined) throw new Error(`${options.bundleId} is not installed on ${udid}`);
      // The simulator shares the host clock. The zero offset still goes through Clocks, on every
      // (re)attach, so ios-sim events are mapped like every other source's.
      const syncClock = (now = Date.now()) => ctx.setClockSample(udid, { deviceTs: now, hostTs: now });
      syncClock();
      live(`streaming ${process} on ${udid}`);
      ctx.log(`streaming ${process} (${options.bundleId}) on ${udid}`);
      const predicate = `process == "${process.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
      const minLevel = options.minLevel ?? IOS_MIN_LEVEL;
      const args = ["simctl", "spawn", udid, "log", "stream", "--style", "ndjson", "--level", streamLevelFor(minLevel), "--predicate", predicate];
      crashes = watchCrashReports(ctx, options.bundleId, udid, deps.crashReportsDir, AbortSignal.any([signal, streamEnded.signal]));
      const onEntry = appLogEvents(ctx, IOS_SIM, udid, options.bundleId, minLevel, () => syncClock());
      await runner.stream("xcrun", args, (line) => {
        const parsed = parseSimLogLine(line);
        if (parsed !== undefined) onEntry(parsed);
      }, signal);
    } finally {
      streamEnded.abort();
      await crashes;
    }
  });
}
