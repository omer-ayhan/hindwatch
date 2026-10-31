import { addAbortListener } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { ClockTracker } from "../clock.js";
import type { Source, SourceContext } from "../plugin.js";
import { supervisedRunner, type ProcessRunner } from "../proc.js";
import type { Level } from "../schema.js";
import { errorMessage, isPlainObject } from "../util.js";
import { appLogEvents, crashEvent, IOS, IOS_MIN_LEVEL, parseCrashReport } from "./apple.js";
import { loopSource, reattach } from "./loop.js";
import { OS_TRACE_RELAY, startActivityRequest, TraceFrames, type TraceEntry } from "./os-trace.js";
import { DeviceError, listDevices, Lockdown, readPairRecord, USB, USBMUXD_SOCKET, type MuxDevice } from "./usbmux.js";

export interface IosOptions {
  readonly bundleId: string;
  /** Device UDID. Defaults to the only iPhone attached. */
  readonly device: string | undefined;
  /** Lowest level to ingest. Defaults to {@link IOS_MIN_LEVEL}, as on the simulator. */
  readonly minLevel: Level | undefined;
  /** How often the device clock is re-measured on top of every attach. */
  readonly clockResyncMs: number;
}

/** The lockdown service that lists installed apps. */
const INSTALLATION_PROXY = "com.apple.mobile.installation_proxy";

export interface IosDeps {
  /** Runs xcrun devicectl, which lists and copies crash reports. */
  readonly runner: ProcessRunner;
  /** usbmuxd's socket, which reaches the device's log stream. */
  readonly usbmuxd: string;
  /** Wait before reattaching once the device is gone or the stream ended. */
  readonly restartMs: number;
  /** How often the device's crash reports are listed. */
  readonly crashPollMs: number;
}

/** The device asked for, or else the only one attached, by USB where any is. */
export function pickDevice(devices: readonly MuxDevice[], udid: string | undefined): MuxDevice {
  if (udid !== undefined) {
    const device = devices.find((candidate) => candidate.udid === udid);
    if (device === undefined) throw new DeviceError(`iPhone ${udid} is not attached`, "connect it by USB and unlock it, or set sources.ios.device to an attached one");
    return device;
  }
  const cabled = devices.filter((device) => device.connection === USB);
  const candidates = cabled.length > 0 ? cabled : devices;
  if (candidates.length === 0) throw new DeviceError("no iPhone attached", "connect one by USB and unlock it");
  if (candidates.length > 1) throw new DeviceError(`${candidates.length} iPhones attached (${candidates.map((device) => device.udid).join(", ")})`, "set sources.ios.device to one");
  return candidates[0]!;
}

/** The crash reports in `devicectl device info files --domain-type systemCrashLogs`, by name, with their sizes. */
export function crashReportFiles(json: string): Map<string, number> {
  const parsed: unknown = JSON.parse(json);
  const result = isPlainObject(parsed) ? parsed.result : undefined;
  if (!isPlainObject(result)) throw new Error("devicectl printed no result");
  const reports = new Map<string, number>();
  for (const file of Array.isArray(result.files) ? result.files : []) {
    if (!isPlainObject(file) || typeof file.relativePath !== "string" || !file.relativePath.endsWith(".ips")) continue;
    const size = isPlainObject(file.metadata) ? file.metadata.size : undefined;
    reports.set(file.relativePath, typeof size === "number" ? size : -1);
  }
  return reports;
}

/** The app's bundle folder on the device, as installation_proxy reports it. */
async function appBundlePath(session: Lockdown, bundleId: string, signal: AbortSignal): Promise<string | undefined> {
  const reply = await session.serviceRequest(INSTALLATION_PROXY, { Command: "Lookup", ClientOptions: { BundleIDs: [bundleId], ReturnAttributes: ["Path"] } }, signal);
  const app = isPlainObject(reply.LookupResult) ? reply.LookupResult[bundleId] : undefined;
  return isPlainObject(app) && typeof app.Path === "string" ? app.Path : undefined;
}

/**
 * Streams one app's unified log from an iPhone, as Console.app does: through usbmuxd to the device's
 * os_trace_relay, signed in with the Mac's pairing. The app is told apart by its bundle folder's
 * name, which a reinstall keeps, so a restarted or reinstalled app stays in the same stream.
 */
export function iosSource(options: IosOptions, overrides: Partial<IosDeps> = {}): Source {
  const deps: IosDeps = {
    runner: overrides.runner ?? supervisedRunner(),
    usbmuxd: overrides.usbmuxd ?? USBMUXD_SOCKET,
    restartMs: overrides.restartMs ?? 2_000,
    crashPollMs: overrides.crashPollMs ?? 2_000,
  };
  return loopSource(IOS, (ctx, signal) => watch(ctx, options, deps, signal));
}

/** The key a failed listing is logged under, apart from the reports' own names. */
const LISTING_FAILED = "listing";

/** What is known of one device's crash reports; it outlives an attach, so a report written while detached is still reported. */
interface CrashReports {
  /** Each report's size when it was last read; the first listing is taken as read. */
  sizes: Map<string, number> | undefined;
  /** Reports that parsed, by file name, which are never read again, even once moved to another folder. */
  readonly parsed: Set<string>;
  /** Failures already logged, so each is logged once. */
  readonly logged: Set<string>;
}

/**
 * The log stream outlives the app, but a crash only shows up as a report, which the device writes
 * a while later. Each report that appears after the first listing and is this app's becomes a
 * fatal event. One that doesn't parse is read again only once its size changes, so a report still
 * being written is picked up and one of another format is read once. Never throws.
 */
async function watchCrashReports(ctx: SourceContext, options: IosOptions, deps: IosDeps, udid: string, reports: CrashReports, signal: AbortSignal): Promise<void> {
  const devicectl = (args: readonly string[]) => deps.runner.run("xcrun", ["devicectl", ...args, "--device", udid, "--domain-type", "systemCrashLogs", "-q"]);
  const logOnce = (failure: string, message: string) => {
    if (signal.aborted || reports.logged.has(failure)) return;
    reports.logged.add(failure);
    ctx.log(message);
  };
  const list = async () => {
    try {
      const listing = crashReportFiles(await devicectl(["device", "info", "files", "-j", "-"]));
      reports.logged.delete(LISTING_FAILED);
      return listing;
    } catch (error) {
      logOnce(LISTING_FAILED, `listing crash reports on ${udid} failed, retrying: ${errorMessage(error)}`);
      return undefined;
    }
  };
  const read = async (dir: string, name: string, size: number, sizes: Map<string, number>) => {
    const copy = join(dir, basename(name));
    try {
      await devicectl(["device", "copy", "from", "--source", name, "--destination", copy]);
      sizes.set(name, size);
      const report = parseCrashReport(await readFile(copy, "utf8"));
      if (report === undefined) return;
      reports.parsed.add(basename(name));
      if (report.bundleId === options.bundleId && !signal.aborted) ctx.emit(crashEvent(IOS, udid, options.bundleId, report, name));
    } catch (error) {
      logOnce(name, `copying crash report ${name} failed, retrying: ${errorMessage(error)}`);
    } finally {
      await rm(copy, { force: true });
    }
  };
  const take = async (dir: string, listing: Map<string, number>) => {
    const sizes = reports.sizes;
    if (sizes === undefined) {
      reports.sizes = listing;
      return;
    }
    for (const [name, size] of listing) {
      if (signal.aborted) return;
      if (!reports.parsed.has(basename(name)) && sizes.get(name) !== size) await read(dir, name, size, sizes);
    }
  };
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "hindwatch-ios-"));
    while (!signal.aborted) {
      const listing = await list();
      if (listing !== undefined) await take(dir, listing);
      await sleep(deps.crashPollMs, undefined, { signal }).catch(() => {});
    }
  } catch (error) {
    if (!signal.aborted) ctx.log(`crash reports on ${udid} are not watched: ${errorMessage(error)}`);
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
}

/** Reads the relay until it closes, handing on the entries of the processes it wants. */
function readRelay(stream: Duplex, wants: (process: string) => boolean, onEntry: (entry: TraceEntry) => void, onStarted: () => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const frames = new TraceFrames(onEntry, onStarted, wants);
    const unlisten = addAbortListener(signal, () => stream.destroy());
    stream
      .on("data", (chunk: Buffer) => {
        try {
          frames.push(chunk);
        } catch (error) {
          stream.destroy(error as Error);
        }
      })
      .on("error", (error) => {
        unlisten[Symbol.dispose]();
        reject(error);
      })
      .on("close", () => {
        unlisten[Symbol.dispose]();
        resolve();
      })
      .resume();
    stream.write(startActivityRequest());
  });
}

function watch(ctx: SourceContext, options: IosOptions, deps: IosDeps, signal: AbortSignal): Promise<void> {
  const minLevel = options.minLevel ?? IOS_MIN_LEVEL;
  const crashReports = new Map<string, CrashReports>();
  return reattach(ctx, signal, deps.restartMs, async (live) => {
    let lockdown: Lockdown | undefined;
    let clock: ClockTracker | undefined;
    let crashes: Promise<void> | undefined;
    const attached = new AbortController();
    try {
      const device = pickDevice(await listDevices(deps.usbmuxd, signal), options.device);
      const udid = device.udid;
      const session = await Lockdown.open(deps.usbmuxd, device, await readPairRecord(deps.usbmuxd, udid, signal), signal);
      lockdown = session;
      const bundle = await appBundlePath(session, options.bundleId, signal);
      if (bundle === undefined) throw new Error(`${options.bundleId} is not installed on ${udid}`);
      const bundleName = basename(bundle);
      const tracker = new ClockTracker({
        read: async () => {
          const seconds = await session.value("TimeIntervalSince1970");
          if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new Error(`lockdownd's clock reads ${String(seconds)}`);
          return seconds * 1000;
        },
        onSample: (sample) => ctx.setClockSample(udid, sample),
        intervalMs: options.clockResyncMs,
        onError: (error) => {
          if (!attached.signal.aborted) ctx.log(`clock reading failed, keeping the last offset: ${errorMessage(error)}`);
        },
      });
      clock = tracker;
      await tracker.resample();
      const relay = await session.startService(OS_TRACE_RELAY, signal);
      const onEntry = appLogEvents(ctx, IOS, udid, options.bundleId, minLevel, () => void tracker.resample());
      await readRelay(
        relay,
        (process) => basename(dirname(process)) === bundleName,
        onEntry,
        () => {
          live(`streaming ${bundleName} on ${udid}`);
          ctx.log(`streaming ${bundleName} (${options.bundleId}) on ${udid}`);
          let reports = crashReports.get(udid);
          if (reports === undefined) crashReports.set(udid, (reports = { sizes: undefined, parsed: new Set(), logged: new Set() }));
          crashes = watchCrashReports(ctx, options, deps, udid, reports, AbortSignal.any([signal, attached.signal]));
        },
        signal,
      );
      if (!signal.aborted) throw new Error(`the log stream from ${udid} ended`);
    } finally {
      attached.abort();
      clock?.stop();
      lockdown?.close();
      await crashes;
    }
  });
}
