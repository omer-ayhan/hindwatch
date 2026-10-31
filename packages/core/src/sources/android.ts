import { setTimeout as sleep } from "node:timers/promises";
import { ClockTracker } from "../clock.js";
import type { Source, SourceContext } from "../plugin.js";
import { loopSource } from "./loop.js";
import { supervisedRunner, type ProcessRunner } from "../proc.js";
import { errorMessage } from "../util.js";
import { logcatArgs, parseLogcatEntries, readLogcatEntries, ReadMark, type LogcatEntry } from "./logcat.js";

export interface AndroidOptions {
  /** Application id, as `adb shell pidof` knows it. */
  readonly package: string;
  /** adb serial. Defaults to the only connected device. */
  readonly serial: string | undefined;
  /** How often the device clock is re-measured on top of every attach. */
  readonly clockResyncMs: number;
}

export interface AndroidDeps {
  readonly runner: ProcessRunner;
  /** The adb to run, as resolveAdb found it. */
  readonly adb: string;
  /** How often to check whether the app's pid changed, while nothing is attached. */
  readonly pollMs: number;
  /** The check backs off from pollMs to this while the attached pid stays the same. */
  readonly maxPollMs: number;
}

/**
 * Doubles while attached to an unchanged pid, so an idle app costs a few adb calls a minute;
 * anything else polls at the base rate. A logcat that ends cuts the backoff short.
 */
export function nextPollMs(previousMs: number, steady: boolean, { pollMs, maxPollMs }: Pick<AndroidDeps, "pollMs" | "maxPollMs">): number {
  return steady ? Math.min(Math.max(previousMs, pollMs) * 2, maxPollMs) : pollMs;
}

/** Parses `date +%s%N` output into epoch ms. */
export function parseDeviceDate(text: string): number {
  const value = text.trim();
  if (/^\d{19}$/.test(value)) return Number(BigInt(value) / 1_000_000n);
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  throw new Error(`unexpected device date ${JSON.stringify(value.slice(0, 40))}`);
}

/** The system_server tag and buffer an ANR is reported in, outside the app's own pid. */
export const ANR_TAG = "ActivityManager";
export const ANR_BUFFER = "system";
export const ANR_PREFIX = "ANR in ";
/** Changes on every boot, so it tells apart two boots, or two emulators, behind one serial. */
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

/** True for ActivityManager's "ANR in <package>" report about this package, not one that starts with it. */
export function isAnrReport(msg: string, pkg: string): boolean {
  const prefix = `${ANR_PREFIX}${pkg}`;
  return msg.startsWith(prefix) && (msg.length === prefix.length || /[\s(]/.test(msg.charAt(prefix.length)));
}

interface Attachment {
  readonly pid: number;
  readonly serial: string;
  readonly abort: AbortController;
  ended: boolean;
  /** Where the app's logcat stopped, so a resumed one starts there. */
  readonly mark: ReadMark;
  anrEnded: boolean;
  /** Host time the ANR watch started; one that has run the longest poll pace has recovered. */
  anrStartedAt: number;
  /** The device boot the ANR watch's place belongs to. */
  anrKey: string;
}

/**
 * The ANR watch's place on one boot of a device, kept across the app's pids so an ANR logged
 * while the app was being reattached (often the ANR that killed it) is still read.
 */
interface AnrPlace {
  /** Where a resumed watch starts: the first watch's start, then the last entry it read. */
  readonly mark: ReadMark;
  /** Host time when the mark was the device's now, to find it again after the clock is set back. */
  readAt: number;
  /**
   * Keys of the ANR reports already in the buffer when the device was first seen, and of those
   * emitted since. A read from a time no entry has starts at the first entry stamped after it, and
   * after a clock change that can be an old one, with everything stored after it.
   */
  readonly known: Set<string>;
  /** The last failure logged, so a watch that keeps failing logs once. */
  error: string | undefined;
}

/**
 * Follows one app's logcat by pid. When the pid changes (a restart) it reattaches under the same
 * device and app, so the session carries on, and re-measures the device clock.
 */
export function androidSource(options: AndroidOptions, overrides: Partial<AndroidDeps> = {}): Source {
  const deps: AndroidDeps = {
    runner: overrides.runner ?? supervisedRunner(),
    adb: overrides.adb ?? "adb",
    pollMs: overrides.pollMs ?? 1_000,
    maxPollMs: overrides.maxPollMs ?? 10_000,
  };
  return loopSource("android", (ctx, signal) => watch(ctx, options, deps, signal));
}

async function watch(ctx: SourceContext, options: AndroidOptions, deps: AndroidDeps, signal: AbortSignal): Promise<void> {
  const { runner } = deps;
  const adb = (serial: string | undefined, args: readonly string[]) =>
    runner.run(deps.adb, serial === undefined ? args : ["-s", serial, ...args]);
  let current: Attachment | undefined;
  let wake = new AbortController();
  let deviceMinusHost = 0;
  const clock = new ClockTracker({
    read: async () => parseDeviceDate(await adb(current?.serial, ["shell", "date", "+%s%N"])),
    onSample: (sample) => {
      deviceMinusHost = sample.deviceTs - sample.hostTs;
      if (current !== undefined) ctx.setClockSample(current.serial, sample);
    },
    intervalMs: options.clockResyncMs,
    onError: (error) => ctx.log(`clock reading failed, keeping the last offset: ${errorMessage(error)}`),
  });

  const pidof = async (): Promise<number | null> => {
    try {
      const pid = Number.parseInt(await adb(options.serial, ["shell", "pidof", options.package]), 10);
      return Number.isSafeInteger(pid) ? pid : null;
    } catch {
      return null; // not running, or no device yet
    }
  };

  const follow = (attachment: Attachment) => {
    attachment.ended = false;
    // A new pid replays its buffered history, which holds the startup lines. A resumed one
    // starts where it stopped.
    const args = logcatArgs(attachment.serial, `--pid=${attachment.pid}`, ...attachment.mark.since());
    readLogcatEntries(
      runner,
      deps.adb,
      args,
      (entry) => {
        if (attachment.abort.signal.aborted) return;
        attachment.mark.passed(entry);
        ctx.emit({
          source: "android",
          deviceId: attachment.serial,
          app: options.package,
          pid: entry.pid,
          deviceTs: entry.deviceTs,
          level: entry.level,
          msg: entry.msg,
          attrs: { tag: entry.tag },
        });
      },
      attachment.abort.signal,
    )
      .catch((error: unknown) => ctx.log(`logcat for pid ${attachment.pid} failed: ${errorMessage(error)}`))
      .finally(() => {
        attachment.ended = true;
        wake.abort();
      });
  };

  const anrPlaces = new Map<string, AnrPlace>();
  const lastKeyOf = new Map<string, string>();

  /**
   * The place for this boot of the device, made on its first attach: where its ANR watch starts,
   * and the ANRs already stored before then, which it must not report. A serial alone can name
   * another emulator or a later boot; when the boot can't be read, it is taken to be the last one.
   */
  const placeAnrWatch = async (serial: string): Promise<string> => {
    const bootId = await adb(serial, ["shell", "cat", BOOT_ID_FILE]).then(
      (text) => text.trim(),
      () => undefined,
    );
    const key = bootId === undefined ? lastKeyOf.get(serial) ?? `${serial}\0` : `${serial}\0${bootId}`;
    lastKeyOf.set(serial, key);
    if (anrPlaces.has(key)) return key;
    const [readAt, startTs] = [Date.now(), Math.round(Date.now() + deviceMinusHost)];
    const known = new Set<string>();
    try {
      const dump = parseLogcatEntries(await runner.runBytes(deps.adb, logcatArgs(serial, "-d", "-b", ANR_BUFFER)));
      // An entry stamped around the dump may have been stored during it, so it is new. The dump's own
      // round trip bounds the clock's error; entries stamped well after it are old ones from a clock
      // that was set back since.
      const margin = Date.now() - readAt;
      const during = (ts: number) => ts >= startTs - margin && ts <= startTs + 2 * margin;
      for (const entry of dump) if (isOurAnr(entry) && !during(entry.deviceTs)) known.add(entry.key);
    } catch (error) {
      ctx.log(`reading the ANRs already on ${serial} failed: ${errorMessage(error)}`);
    }
    anrPlaces.set(key, { mark: new ReadMark(startTs), readAt, known, error: undefined });
    return key;
  };

  const isOurAnr = (entry: LogcatEntry) => entry.tag === ANR_TAG && isAnrReport(entry.msg, options.package);

  /**
   * ANRs are logged by system_server, which the app's --pid logcat never shows, so the watch reads
   * its whole buffer and keeps this package's reports. The first watch on a device starts at its
   * now; later ones resume after the last entry they read. A device clock set back before any entry
   * was read would leave the start ahead of every new entry, so it moves to that same moment on the
   * new clock instead.
   */
  const followAnrs = (attachment: Attachment) => {
    [attachment.anrEnded, attachment.anrStartedAt] = [false, Date.now()];
    const place = anrPlaces.get(attachment.anrKey)!;
    const deviceNow = Math.round(Date.now() + deviceMinusHost);
    if (place.mark.isAhead(deviceNow)) place.mark.restartAt(deviceNow - (Date.now() - place.readAt));
    const args = logcatArgs(attachment.serial, "-b", ANR_BUFFER, ...place.mark.since());
    readLogcatEntries(
      runner,
      deps.adb,
      args,
      (entry) => {
        if (attachment.abort.signal.aborted) return;
        place.mark.passed(entry);
        place.readAt = Date.now();
        if (!isOurAnr(entry) || place.known.has(entry.key)) return;
        place.known.add(entry.key);
        ctx.emit({
          source: "android",
          deviceId: attachment.serial,
          app: options.package,
          deviceTs: entry.deviceTs,
          level: entry.level,
          msg: entry.msg,
          attrs: { tag: entry.tag, buffer: ANR_BUFFER },
        });
      },
      attachment.abort.signal,
    )
      .catch((error: unknown) => {
        const message = errorMessage(error);
        if (attachment.abort.signal.aborted || message === place.error) return;
        place.error = message;
        ctx.log(`ANR watch on ${attachment.serial} failed: ${message}`);
      })
      .finally(() => {
        attachment.anrEnded = true;
      });
  };

  const attach = async (pid: number) => {
    const serial = options.serial ?? (await adb(undefined, ["get-serialno"])).trim();
    current = { pid, serial, abort: new AbortController(), ended: false, mark: new ReadMark(), anrEnded: false, anrStartedAt: Date.now(), anrKey: serial };
    ctx.log(`attached to ${options.package} pid ${pid} on ${serial}`);
    ctx.setHealth({ status: "live", detail: `attached to ${options.package} pid ${pid} on ${serial}` });
    await clock.resample();
    if (signal.aborted) return;
    current.anrKey = await placeAnrWatch(serial);
    if (signal.aborted) return;
    follow(current);
    followAnrs(current);
  };

  let waitMs = deps.pollMs;
  while (!signal.aborted) {
    wake = new AbortController();
    const pid = await pidof();
    if (signal.aborted) break;
    let steady = false;
    if (pid !== (current?.pid ?? null)) {
      current?.abort.abort();
      current = undefined;
      clock.stop();
      if (pid === null) {
        ctx.setHealth({
          status: "waiting",
          detail: `${options.package} is not running (or no device)`,
        });
        ctx.log(`${options.package} is not running`);
      } else await attach(pid).catch((error: unknown) => {
        ctx.setHealth({ status: "waiting", detail: `attach failed: ${errorMessage(error)}` });
        ctx.log(`attach failed: ${errorMessage(error)}`);
      });
    } else if (current?.ended) {
      follow(current);
    } else {
      steady = current !== undefined;
    }
    // At the loop's own pace, backed off while steady, so a watch that keeps failing can't spin
    // adb; it resumes where it stopped, so the wait loses nothing. Its next failure is news once it
    // has run as long as the slowest pace.
    if (current?.anrEnded) {
      await clock.resample();
      if (current !== undefined && !signal.aborted) followAnrs(current);
    } else if (current !== undefined && Date.now() - current.anrStartedAt >= deps.maxPollMs) {
      anrPlaces.get(current.anrKey)!.error = undefined;
    }
    waitMs = nextPollMs(waitMs, steady, deps);
    await sleep(deps.pollMs, undefined, { signal }).catch(() => {});
    const backoffMs = waitMs - deps.pollMs;
    if (backoffMs > 0) await sleep(backoffMs, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch(() => {});
  }
  current?.abort.abort();
  clock.stop();
}
