import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { androidSource, type DebugEvent, isAnrReport, nextPollMs, parseConfig, parseDeviceDate, parseLogcatEntries, type ProcessRunner } from "@hindwatch/core";
import { aborted, ANR_LOG, JAVA_CRASH_LOG, LOGCAT_LOG, logcatFrame, type LogcatRecord, pipeline, until } from "./helpers.js";
import { test } from "./timed.js";

const PACKAGE = "com.hindwatch.fixture";
const SERIAL = "emulator-5554";
const RECORDED: readonly LogcatRecord[] = JSON.parse(readFileSync(LOGCAT_LOG, "utf8"));
const androidConfig = (options: Record<string, unknown>) => parseConfig({ sources: { android: options } }).sources.android;

const stampNs = (stamp: string) => {
  const [secs, fraction = ""] = stamp.split(".");
  return BigInt(secs!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};

const stampOf = (record: LogcatRecord) => `${record.sec}.${String(record.nsec).padStart(9, "0")}`;
const framesOf = (records: readonly LogcatRecord[]) => Buffer.concat(records.map(logcatFrame));
/** An ActivityManager error from system_server, logged at ms plus a few ns. */
const systemEntry = (ms: number, ns: number, tid: number, msg: string): LogcatRecord =>
  ({ sec: Math.floor(ms / 1000), nsec: (ms % 1000) * 1_000_000 + ns, pid: 555, tid, priority: 6, tag: "ActivityManager", msg });

/**
 * Like logd: -T starts after the entry stamped exactly at its time, or else at the first entry
 * stamped after it, and every entry stored after that follows in storage order, whatever its time.
 */
function startOf(stamps: readonly string[], args: readonly string[]): number {
  if (!args.includes("-T")) return 0;
  const since = stampNs(args[args.indexOf("-T") + 1]!);
  const first = stamps.findIndex((stamp) => stampNs(stamp) >= since);
  if (first === -1) return stamps.length;
  if (stampNs(stamps[first]!) !== since) return first;
  const next = stamps.findIndex((stamp, index) => index > first && stamp !== stamps[first]);
  return next === -1 ? stamps.length : next;
}

/** A device that replays the recorded logcat for whichever pid the app has right now. */
function fakeAdb() {
  const device = {
    pid: 1111 as number | null,
    serial: SERIAL,
    bootId: "boot-1",
    /** When set, the next boot id read fails. */
    bootIdFails: false,
    /** Runs while the system buffer is being dumped, before the dump is read. */
    duringDump: () => {},
    /** device clock minus host clock */
    driftMs: 5_000,
    dateReads: 0,
    /** When set, the app's logcat delivers these reads, with a pause between them like adb's packets, instead of the recording. */
    reads: undefined as Uint8Array[] | undefined,
    /** When set, a logcat stream ends after replaying instead of staying open. */
    streamsEnd: false,
    streams: [] as string[][],
    /** The system-buffer logcats, and the system buffer's entries in the order they were stored. */
    systemStreams: [] as string[][],
    systemEntries: [] as LogcatRecord[],
    /** Other devices' or boots' system buffers, by "serial/bootId". */
    otherSystemEntries: {} as Record<string, LogcatRecord[]>,
    /** When set, the open system-buffer logcat ends once, like adb dropping it. */
    endSystemStream: false,
    /** When set, every system-buffer logcat fails at once with this message. */
    systemFailure: undefined as string | undefined,
    systemFailureAfterMs: 0,
  };
  const systemBuffer = (serial: string) =>
    serial === SERIAL && device.bootId === "boot-1" ? device.systemEntries : (device.otherSystemEntries[`${serial}/${device.bootId}`] ??= []);
  const runner: ProcessRunner = {
    async run(_command, args) {
      if (args.includes("pidof")) {
        if (device.pid === null) throw new Error("exit 1");
        return `${device.pid}\n`;
      }
      if (args.includes("get-serialno")) return `${device.serial}\n`;
      if (args.includes("/proc/sys/kernel/random/boot_id")) {
        if (device.bootIdFails) {
          device.bootIdFails = false;
          throw new Error("device offline");
        }
        return `${device.bootId}\n`;
      }
      if (args.includes("date")) {
        device.dateReads++;
        return `${BigInt(Date.now() + device.driftMs) * 1_000_000n}\n`;
      }
      throw new Error(`unexpected adb ${args.join(" ")}`);
    },
    async runBytes(_command, args) {
      if (!args.includes("-d")) throw new Error(`unexpected adb ${args.join(" ")}`);
      // A dump takes an adb round trip, like any other call.
      device.duringDump();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return framesOf(systemBuffer(args[1]!));
    },
    async stream() {
      throw new Error("adb's logcat is read as bytes");
    },
    async read(_command, args, onData, signal) {
      if (!args.some((a) => a.startsWith("--pid="))) {
        device.systemStreams.push([...args]);
        if (device.systemFailure !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, device.systemFailureAfterMs));
          throw new Error(device.systemFailure);
        }
        const entries = systemBuffer(args[1]!);
        for (let shown = startOf(entries.map(stampOf), args); !signal.aborted; await new Promise((resolve) => setTimeout(resolve, 5))) {
          if (device.endSystemStream) {
            device.endSystemStream = false;
            return;
          }
          if (shown < entries.length) onData(framesOf(entries.slice(shown)));
          shown = entries.length;
        }
        return;
      }
      device.streams.push([...args]);
      for (const read of device.reads ?? []) {
        onData(read);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (device.reads !== undefined) return aborted(signal);
      const pid = Number(args.find((a) => a.startsWith("--pid="))!.slice("--pid=".length));
      const entries = RECORDED.filter((entry) => entry.pid === pid);
      onData(framesOf(entries.slice(startOf(entries.map(stampOf), args))));
      if (!device.streamsEnd) await aborted(signal);
    },
  };
  return { device, runner };
}

async function attach(options: Record<string, unknown> = {}, maxPollMs = 20, before: (device: ReturnType<typeof fakeAdb>["device"]) => void = () => {}) {
  const adb = fakeAdb();
  before(adb.device);
  const pidofCalls = { count: 0 };
  const runner: ProcessRunner = {
    run: (command, args) => (args.includes("pidof") && pidofCalls.count++, adb.runner.run(command, args)),
    runBytes: adb.runner.runBytes,
    stream: adb.runner.stream,
    read: adb.runner.read,
  };
  const logs: string[] = [];
  const { host, buffer } = pipeline((message) => logs.push(message));
  const source = androidSource(androidConfig({ package: PACKAGE, ...options })!, { runner, pollMs: 5, maxPollMs });
  host.add({ name: "builtin", apiVersion: "0.1", sources: [source] });
  await host.startAll();
  return { ...adb, pidofCalls, logs, host, events: () => buffer.snapshot() };
}

test("logcat -B entries decode into device time, pid, level, tag, message and the stamp -T takes", () => {
  const entries = parseLogcatEntries(framesOf(RECORDED));
  assert.deepEqual([...new Set(entries.map((entry) => entry.level))].sort(), ["debug", "error", "fatal", "info", "verbose", "warn"]);
  assert.deepEqual(entries.map((entry) => entry.msg), RECORDED.map((record) => record.msg));
  assert.deepEqual(
    { deviceTs: entries[0]!.deviceTs, pid: entries[0]!.pid, tag: entries[0]!.tag, stamp: entries[0]!.stamp },
    { deviceTs: 1761226155100, pid: 1111, tag: "ActivityManager", stamp: "1761226155.100000000" },
  );
});

test("device dates in ns and in s both become epoch ms", () => {
  assert.equal(parseDeviceDate("1761226155978123456\n"), 1761226155978);
  assert.equal(parseDeviceDate("1761226155"), 1761226155000);
  assert.throws(() => parseDeviceDate("Thu Oct 23"), /unexpected device date/);
});

test("the recorded logcat replays as redacted, clock-mapped android events", async () => {
  const { host, events } = await attach();
  await until(() => events().length === 6, "pid 1111's lines");
  await host.stopAll();
  const [first, , , slow] = events();
  assert.deepEqual(
    { source: first!.source, deviceId: first!.deviceId, app: first!.app, pid: first!.pid, tag: first!.attrs.tag },
    { source: "android", deviceId: SERIAL, app: PACKAGE, pid: 1111, tag: "ActivityManager" },
  );
  assert.equal(slow!.msg, "slow response, Authorization: Bearer [REDACTED:bearer]");
  const crash = events().find((e) => e.attrs.tag === "AndroidRuntime");
  assert.deepEqual(crash!.msg.split("\n").slice(0, 3), ["FATAL EXCEPTION: main", "Process: com.hindwatch.fixture, PID: 1111", "java.lang.IllegalStateException: fixture crash"]);
  assert.ok(events().every((e) => !e.estimated));
});

test("an entry cut across reads arrives whole once its last byte does, while the logcat stays open", async () => {
  const crash = readFileSync(JAVA_CRASH_LOG);
  const cuts = [1, 20, Math.floor(crash.length / 2), crash.length - 1, crash.length];
  const reads = cuts.map((end, index) => crash.subarray(cuts[index - 1] ?? 0, end));
  const { host, events } = await attach({}, 20, (device) => (device.reads = reads));
  await until(() => events().length > 0, "the crash");
  await host.stopAll();
  assert.deepEqual(events().map((e) => e.msg), parseLogcatEntries(crash).map((entry) => entry.msg));
});

test("a pid change reattaches into the same session and re-measures the clock", async () => {
  const { device, host, events } = await attach();
  await until(() => events().length === 6, "pid 1111's lines");
  assert.equal(device.dateReads, 1);
  device.driftMs = 7_000;
  device.pid = 2222;
  await until(() => events().length === 9, "pid 2222's lines");
  await host.stopAll();
  assert.equal(device.dateReads, 2, "the clock is read again on reattach");
  assert.equal(new Set(events().map((e) => e.sessionId)).size, 1);
  // ts = deviceTs - offset, so each pid's events carry the offset measured when it attached.
  for (const [pid, drift] of [[1111, 5_000], [2222, 7_000]] as const) {
    for (const e of events().filter((e) => e.pid === pid)) assert.ok(Math.abs(e.deviceTs! - e.ts - drift) < 100, `pid ${pid}`);
  }
});

test("while the app is down nothing is attached, and it reattaches when it comes back", async () => {
  const { device, host, events } = await attach();
  await until(() => events().length === 6, "pid 1111's lines");
  device.pid = null;
  await until(() => device.streams.length === 1 && device.dateReads === 1, "the app going down");
  await new Promise((resolve) => setTimeout(resolve, 30));
  device.pid = 2222;
  await until(() => events().length === 9, "pid 2222's lines");
  await host.stopAll();
  assert.deepEqual(device.streams.map((s) => s.find((a) => a.startsWith("--pid="))), ["--pid=1111", "--pid=2222"]);
});

test("a logcat that dies under the same pid resumes where it stopped, without repeats", async () => {
  // A long backoff: the ended logcat wakes the loop, it doesn't wait for the next check.
  const { device, host, events } = await attach({}, 60_000);
  device.streamsEnd = true;
  await until(() => device.streams.length >= 3, "two resumes");
  await host.stopAll();
  assert.deepEqual(device.streams[1]!.slice(-2), ["-T", "1761226155.978000000"]);
  assert.equal(events().length, 6);
  assert.equal(device.dateReads, 1, "a resume is not a reattach");
});

test("ANR reports name the package exactly", () => {
  assert.equal(isAnrReport(`ANR in ${PACKAGE}`, PACKAGE), true);
  assert.equal(isAnrReport(`ANR in ${PACKAGE} (${PACKAGE}/.MainActivity)`, PACKAGE), true);
  assert.equal(isAnrReport(`ANR in ${PACKAGE}.other (x)`, PACKAGE), false);
  assert.equal(isAnrReport(`Start proc 1111:${PACKAGE}/u0a190`, PACKAGE), false);
});

const at = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}`;
/** An entry's stamp: logd's are in ns, so one in the ms a watch starts at is still after it. */
const stampAt = (ms: number) => `${at(ms)}000001`;
const anrEntry = (ms: number, what: string, pkg = PACKAGE) => systemEntry(ms, 1, 570, `ANR in ${pkg} (${what})`);
const amEntry = (ms: number, msg: string) => systemEntry(ms, 0, 571, msg);
const anrsOf = (events: () => readonly DebugEvent[]) => () => events().filter((e) => e.attrs.buffer === "system").map((e) => e.msg);
/** The emulator's ANR report, restamped and about this package. */
const anrReport = (ms: number) => systemEntry(ms, 1, 570, parseLogcatEntries(readFileSync(ANR_LOG))[0]!.msg.replaceAll("com.example.app", PACKAGE));

test("an ANR report arrives whole, its reason with it", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const report = anrReport(Date.now() + device.driftMs);
  device.systemEntries.push(report);
  const anrs = anrsOf(events);
  await until(() => anrs().length === 1, "the ANR report");
  await host.stopAll();
  assert.equal(anrs()[0], report.msg);
  assert.match(anrs()[0]!, new RegExp(`^ANR in ${PACKAGE.replaceAll(".", "\\.")} \\(.*\\)\\nPID: \\d+\\nReason: Input dispatching timed out`));
});

test("ANRs come from system_server's buffer, from attach on, for this package only", async () => {
  // logd starts a watch at the first entry stamped after its start: here an old one stamped ahead.
  const { device, host, events } = await attach({}, 20, (device) =>
    device.systemEntries.push(anrEntry(Date.now() + 5_000 - 120_000, "before attach"), amEntry(Date.now() + 5_000 + 60_000, "stamped ahead")),
  );
  await until(() => events().length === 6 && device.systemStreams.length === 1, "pid 1111's lines and the ANR watch");
  const [args] = device.systemStreams;
  assert.deepEqual(args!.slice(-4), ["-b", "system", "-T", args!.at(-1)!]);
  const since = Number(args!.at(-1)) * 1000;
  assert.ok(Math.abs(since - (Date.now() + device.driftMs)) < 1_000, "-T is the device's now");
  const anrs = anrsOf(events);
  const now = Date.now() + device.driftMs;
  device.systemEntries.push(anrEntry(now, "x", `${PACKAGE}.other`), anrEntry(now + 1, `${PACKAGE}/.MainActivity`));
  await until(() => anrs().length > 0, "the ANR line");
  await host.stopAll();
  assert.deepEqual(anrs(), [`ANR in ${PACKAGE} (${PACKAGE}/.MainActivity)`]);
  assert.deepEqual(events().filter((e) => e.attrs.buffer === "system").map((e) => [e.attrs.tag, e.app]), [["ActivityManager", PACKAGE]]);
});

test("an ANR is read even when the device clock was set back after attach", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const anrs = anrsOf(events);
  device.systemEntries.push(anrEntry(Date.now() + device.driftMs - 600_000, "clock set back"));
  await until(() => anrs().length === 1, "the ANR");
  await host.stopAll();
});

test("an ANR watch that ends resumes where it stopped reading, under the same pid", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const later = Date.now() + device.driftMs;
  const anrs = anrsOf(events);
  device.systemEntries.push(anrEntry(later, "first"));
  await until(() => anrs().length === 1, "the first ANR");
  device.endSystemStream = true;
  device.systemEntries.push(anrEntry(later + 1, "while it was down"));
  await until(() => device.systemStreams.length === 2, "a second ANR watch");
  assert.equal(device.systemStreams[1]!.at(-1), stampAt(later), "resumes after the last entry it read");
  device.systemEntries.push(anrEntry(later + 2, "after"));
  await until(() => anrs().length === 3, "every ANR");
  await host.stopAll();
  assert.deepEqual(anrs(), [`ANR in ${PACKAGE} (first)`, `ANR in ${PACKAGE} (while it was down)`, `ANR in ${PACKAGE} (after)`]);
  assert.equal(device.streams.length, 1, "the app's own logcat is untouched");
});

test("an ANR watch that ends before reading an entry resumes from where it started", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const started = device.systemStreams[0]!.at(-1)!;
  device.endSystemStream = true;
  device.systemEntries.push(anrEntry(Number(started) * 1000, "while it was down"));
  await until(() => device.systemStreams.length === 2, "a second ANR watch");
  assert.equal(device.systemStreams[1]!.at(-1), started);
  await until(() => anrsOf(events)().length === 1, "the ANR from the gap");
  await host.stopAll();
});

test("an ANR logged while the app is reattached under a new pid is still read", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const started = Number(device.systemStreams[0]!.at(-1)) * 1000;
  device.pid = 2222;
  device.endSystemStream = true;
  device.systemEntries.push(anrEntry(started + 1, "that killed pid 1111"));
  await until(() => device.streams.some((args) => args.includes("--pid=2222")), "pid 2222's logcat");
  await until(() => anrsOf(events)().length === 1, "the ANR");
  await host.stopAll();
});

test("a resumed ANR watch reads the ANRs logged while it was down after the device clock was set back", async () => {
  const { device, host, events } = await attach({}, 200);
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  device.driftMs -= 86_400_000;
  // Stored before the open watch's next read, which ends it instead.
  device.endSystemStream = true;
  device.systemEntries.push(anrEntry(Date.now() + device.driftMs, "while it was down"));
  await until(() => device.systemStreams.length === 2, "a second ANR watch");
  await until(() => anrsOf(events)().length === 1, "the ANR");
  await host.stopAll();
});

test("ANR watch places are kept per device, so one left for another device resumes where it stopped", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch on the first device");
  [device.serial, device.pid] = ["emulator-5556", 2222];
  await until(() => device.systemStreams.some((args) => args[1] === "emulator-5556"), "the ANR watch on the second device");
  device.systemEntries.push(anrEntry(Date.now() + device.driftMs, "while away"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  [device.serial, device.pid] = [SERIAL, 3333];
  await until(() => device.streams.some((args) => args.includes("--pid=3333")), "the first device again");
  await until(() => anrsOf(events)().length === 1, "the ANR from while it was away");
  await host.stopAll();
});

test("an ANR stored while the buffer is first dumped is still reported", async () => {
  const { host, events } = await attach({}, 20, (device) => {
    device.duringDump = () => device.systemEntries.push(anrEntry(Date.now() + device.driftMs, "during the dump"));
  });
  await until(() => anrsOf(events)().length === 1, "the ANR");
  await host.stopAll();
  assert.deepEqual(anrsOf(events)(), [`ANR in ${PACKAGE} (during the dump)`]);
});

test("an old ANR stamped ahead by a clock since set back isn't reported as new", async () => {
  const { device, host, events } = await attach({}, 20, (device) => device.systemEntries.push(anrEntry(Date.now() + device.driftMs + 86_400_000, "stamped ahead")));
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  device.systemEntries.push(anrEntry(Date.now() + device.driftMs, "new"));
  await until(() => anrsOf(events)().length > 0, "the new ANR");
  await host.stopAll();
  assert.deepEqual(anrsOf(events)(), [`ANR in ${PACKAGE} (new)`]);
});

test("a boot id that can't be read on reattach keeps the device's place", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  await new Promise((resolve) => setTimeout(resolve, 10));
  [device.pid, device.bootIdFails] = [2222, true];
  device.endSystemStream = true;
  device.systemEntries.push(anrEntry(Date.now() + device.driftMs, "that killed pid 1111"));
  await until(() => device.streams.some((args) => args.includes("--pid=2222")), "pid 2222's logcat");
  await until(() => anrsOf(events)().length === 1, "the ANR");
  await host.stopAll();
});

test("another boot behind the same serial gets a fresh place, so its old ANRs aren't reported", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  // A restored emulator: its clock is behind, and its buffer holds an ANR from before.
  device.driftMs -= 86_400_000;
  const now = Date.now() + device.driftMs;
  const restored = [anrEntry(now - 10_000, "from the restored buffer"), amEntry(now + 3_600_000, "stamped ahead")];
  device.otherSystemEntries[`${SERIAL}/boot-2`] = restored;
  [device.bootId, device.pid] = ["boot-2", 2222];
  await until(() => device.systemStreams.length === 2, "the ANR watch on the new boot");
  restored.push(anrEntry(Date.now() + device.driftMs, "new"));
  await until(() => anrsOf(events)().length > 0, "the new ANR");
  await host.stopAll();
  assert.deepEqual(anrsOf(events)(), [`ANR in ${PACKAGE} (new)`]);
});

test("a resumed ANR watch doesn't repeat an ANR an older stored line follows", async () => {
  const { device, host, events } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  const start = Number(device.systemStreams[0]!.at(-1)) * 1000;
  const anrs = anrsOf(events);
  device.systemEntries.push(anrEntry(start + 10, "once"), amEntry(start + 5, "logged earlier, stored later"));
  await until(() => anrs().length === 1, "the ANR");
  device.endSystemStream = true;
  await until(() => device.systemStreams.length === 2, "a second ANR watch");
  device.systemEntries.push(anrEntry(start + 20, "next"));
  await until(() => anrs().length === 2, "the next ANR");
  await host.stopAll();
  assert.deepEqual(anrs(), [`ANR in ${PACKAGE} (once)`, `ANR in ${PACKAGE} (next)`]);
});

test("an ANR watch that keeps failing is retried at the backed-off pace and logged once", async () => {
  const { device, host, logs } = await attach({}, 200);
  device.systemFailure = "logcat: Unknown buffer 'system'";
  device.endSystemStream = true;
  await until(() => device.systemStreams.length >= 2, "a retried ANR watch");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await host.stopAll();
  assert.ok(device.systemStreams.length <= 8, `${device.systemStreams.length} ANR watches in ~0.5 s`);
  assert.equal(logs.filter((line) => line.includes("Unknown buffer")).length, 1);
});

test("an ANR watch that keeps failing logs once across pid changes", async () => {
  const { device, host, logs } = await attach();
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  [device.systemFailure, device.systemFailureAfterMs] = ["device offline", 15];
  device.endSystemStream = true;
  for (const pid of [2222, 3333, 4444, 5555]) {
    device.pid = pid;
    await until(() => device.streams.some((args) => args.includes(`--pid=${pid}`)), `pid ${pid}'s logcat`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await host.stopAll();
  assert.equal(logs.filter((line) => line.includes("device offline")).length, 1);
});

test("an ANR watch failure is logged again after the watch has recovered in between", async () => {
  const { device, host, logs } = await attach();
  const failures = () => logs.filter((line) => line.includes("device offline")).length;
  await until(() => device.systemStreams.length === 1, "the ANR watch");
  device.systemFailure = "device offline";
  device.endSystemStream = true;
  await until(() => failures() === 1, "the first failure");
  device.systemFailure = undefined;
  const recovered = device.systemStreams.length + 1;
  await until(() => device.systemStreams.length === recovered, "a watch that runs");
  await new Promise((resolve) => setTimeout(resolve, 100));
  device.systemFailure = "device offline";
  device.endSystemStream = true;
  await until(() => failures() === 2, "the failure after recovery");
  await host.stopAll();
});

test("pid checks back off from 1 s to 10 s while attached, and are back at 1 s on any change", () => {
  const deps = { pollMs: 1_000, maxPollMs: 10_000 };
  const steady: number[] = [];
  for (let ms = deps.pollMs, i = 0; i < 5; i++) steady.push((ms = nextPollMs(ms, true, deps)));
  assert.deepEqual(steady, [2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.equal(nextPollMs(10_000, false, deps), 1_000);
});

test("an attached app with an unchanged pid is checked less and less often", async () => {
  const { host, events, pidofCalls } = await attach({}, 60_000);
  await until(() => events().length === 6, "pid 1111's lines");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await host.stopAll();
  // At a fixed 5 ms that would be about 100 checks; doubling from 5 ms it is at most 8.
  assert.ok(pidofCalls.count <= 10, `${pidofCalls.count} pidof calls`);
});

test("the clock is re-measured every 60s by default, and on the configured interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const [options, intervalMs] of [[{}, 60_000], [{ clockResyncMs: 5_000 }, 5_000]] as const) {
    const { device, host, events } = await attach(options);
    await until(() => events().length === 6, "pid 1111's lines");
    assert.equal(device.dateReads, 1);
    t.mock.timers.tick(intervalMs - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(device.dateReads, 1);
    t.mock.timers.tick(1);
    await until(() => device.dateReads === 2, "the periodic reading");
    t.mock.timers.tick(intervalMs);
    await until(() => device.dateReads === 3, "the next periodic reading");
    await host.stopAll();
  }
});

test("sources.android in hindwatch.config.json is validated, with a 60s clock resync by default", () => {
  assert.throws(() => androidConfig({}), /sources.android.package is required/);
  assert.throws(() => androidConfig({ package: PACKAGE, clockResyncMs: 0 }), /clockResyncMs/);
  assert.deepEqual(androidConfig({ package: PACKAGE, serial: SERIAL }), {
    package: PACKAGE,
    serial: SERIAL,
    clockResyncMs: 60_000,
  });
});
