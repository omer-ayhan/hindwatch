import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  IOS_MIN_LEVEL,
  bootedUdid,
  iosSimSource,
  loadConfig,
  loadPlugin,
  parseConfig,
  crashMessage,
  parseCrashReport,
  parseSimLogLine,
  streamLevelFor,
  LEVELS,
  type PluginRef,
  type ProcessRunner,
} from "@hindwatch/core";
import { aborted, pipeline, SIMCTL_LOG, until } from "./helpers.js";
import { test } from "./timed.js";

const BUNDLE = "com.hindwatch.fixture";
const UDID = "6B1F0C2E-4A7D-4E39-8C5B-1D2E3F405A6B";
const TOY_PLUGIN = fileURLToPath(new URL("./plugins/ios-category.ts", import.meta.url));
const PARSED_LOG_EVENTS = 6;
/** After the ios-sim Debug floor, the recorded stream yields this many buffered events. */
const BUFFERED_EVENTS = 5;
const iosSimConfig = (options: Record<string, unknown>) => parseConfig({ sources: { "ios-sim": options } }).sources["ios-sim"];

/** A booted simulator that replays the recorded `log stream` and then keeps it open. */
async function fakeSimctl() {
  const recorded = (await readFile(SIMCTL_LOG, "utf8")).split("\n");
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args.includes("list")) {
        return JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: UDID, state: "Booted", name: "iPhone 17 Pro" }],
          },
        });
      }
      if (args.includes("appinfo")) return `{\n    CFBundleExecutable = FixtureApp;\n    CFBundleIdentifier = "${BUNDLE}";\n}\n`;
      throw new Error(`unexpected simctl ${args.join(" ")}`);
    },
    async runBytes() {
      throw new Error("simctl is read as text");
    },
    async read() {
      throw new Error("simctl's log stream is read as lines");
    },
    async stream(_command, args, onLine, signal) {
      calls.push([...args]);
      for (const line of recorded) onLine(line);
      await aborted(signal);
    },
  };
  return { runner, calls };
}

/** A crash-report folder that doesn't exist, so a test never watches the real one. */
const NO_CRASH_REPORTS = join(tmpdir(), `hindwatch-no-crash-reports-${process.pid}`);

async function attach(root = "/", plugins: readonly PluginRef[] = [], crashReportsDir = NO_CRASH_REPORTS) {
  const simctl = await fakeSimctl();
  const { host, buffer } = pipeline();
  for (const ref of plugins) host.add(await loadPlugin(root, ref));
  host.add({
    name: "builtin",
    apiVersion: "0.1",
    sources: [iosSimSource(iosSimConfig({ bundleId: BUNDLE })!, { runner: simctl.runner, restartMs: 5, crashReportsDir })],
  });
  await host.startAll();
  return { ...simctl, host, events: () => buffer.snapshot() };
}

test("ndjson log events parse; banners and activity events are skipped", async () => {
  const lines = (await readFile(SIMCTL_LOG, "utf8")).split("\n");
  const parsed = lines.map(parseSimLogLine);
  assert.equal(parsed.filter((p) => p !== undefined).length, PARSED_LOG_EVENTS);
  assert.equal(parsed[0], undefined, "the Filtering banner");
  assert.equal(parsed[3], undefined, "an activityCreateEvent");
  assert.deepEqual(parsed[1], {
    deviceTs: Date.parse("2026-10-23T13:29:15.620Z"),
    pid: 4101,
    level: "info",
    msg: "app launched",
    subsystem: "com.hindwatch.fixture",
    category: "lifecycle",
  });
  assert.deepEqual(
    parsed.flatMap((p) => (p === undefined ? [] : [p.level])),
    ["info", "debug", "error", "fatal", "info", "info"],
  );
});

test("the booted simulator is found in simctl's device list", () => {
  const list = { devices: { a: [{ udid: "X", state: "Shutdown" }], b: [{ udid: UDID, state: "Booted" }] } };
  assert.equal(bootedUdid(JSON.stringify(list)), UDID);
  assert.equal(bootedUdid(JSON.stringify({ devices: {} })), undefined);
});

test("the recorded log stream replays through simctl with the app's process predicate", async () => {
  const { calls, host, events } = await attach();
  await until(() => events().length === BUFFERED_EVENTS, "the recorded events");
  await host.stopAll();
  const stream = calls.find((c) => c.includes("stream"))!;
  assert.deepEqual(stream.slice(0, 4), ["simctl", "spawn", UDID, "log"]);
  assert.equal(stream[stream.indexOf("--level") + 1], streamLevelFor(IOS_MIN_LEVEL));
  assert.equal(stream.at(-1), 'process == "FixtureApp"');
  assert.deepEqual(events().map((e) => e.level), ["info", "error", "fatal", "info", "info"]);
  assert.ok(events().every((e) => e.level !== "debug"), "Debug never enters the ring");
  assert.equal(events()[1]!.msg, "login failed for [REDACTED:email] password=[REDACTED:secret]");
  // The zero offset went through Clocks, so device time is trusted rather than estimated.
  for (const e of events()) {
    assert.equal(e.estimated, false);
    assert.equal(e.ts, e.deviceTs);
  }
});

test("an app restart (new pid) stays in the same session", async () => {
  const { host, events } = await attach();
  await until(() => events().length === BUFFERED_EVENTS, "the recorded events");
  await host.stopAll();
  assert.deepEqual([...new Set(events().map((e) => e.pid))], [4101, 4188]);
  assert.equal(new Set(events().map((e) => e.sessionId)).size, 1);
  assert.ok(events().every((e) => e.deviceId === UDID && e.app === BUNDLE));
});

test("a toy feature Enricher loaded from hindwatch.config.json transforms ios-sim events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-toy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: [TOY_PLUGIN] }));
  const config = await loadConfig(root);
  const { host, events } = await attach(root, config.plugins);
  await until(() => events().length === BUFFERED_EVENTS, "the recorded events");
  await host.stopAll();
  assert.deepEqual(events().slice(0, 2).map((e) => e.msg), [
    "[lifecycle] app launched",
    "[network] login failed for [REDACTED:email] password=[REDACTED:secret]",
  ]);
  assert.equal(events().at(-1)!.msg, "CFNetwork task started", "no category, left alone");
});

test('sources["ios-sim"] in hindwatch.config.json is validated; unknown sources are rejected', () => {
  assert.throws(() => iosSimConfig({}), /bundleId is required/);
  assert.throws(() => iosSimConfig({ bundleId: BUNDLE, device: 3 }), /device/);
  assert.deepEqual(iosSimConfig({ bundleId: BUNDLE }), {
    bundleId: BUNDLE,
    process: undefined,
    device: undefined,
    minLevel: IOS_MIN_LEVEL,
  });
  assert.equal(iosSimConfig({ bundleId: BUNDLE, minLevel: "debug" })!.minLevel, "debug");
  assert.throws(() => iosSimConfig({ bundleId: BUNDLE, minLevel: "nope" }), /minLevel/);
  assert.throws(() => parseConfig({ sources: { tvos: {} } }), /sources.tvos is not a built-in source \(android, ios-sim, ios\)/);
  assert.throws(() => parseConfig({ sources: [] }), /sources must be an object/);
  assert.deepEqual(parseConfig({}).sources, {});
});

test("every minLevel maps to a level log stream accepts, and verbose streams Debug", () => {
  const accepted = ["default", "info", "debug"];
  for (const level of LEVELS) assert.ok(accepted.includes(streamLevelFor(level)), `${level} -> ${streamLevelFor(level)}`);
  assert.equal(streamLevelFor("verbose"), "debug");
  assert.equal(streamLevelFor("debug"), "debug");
  assert.equal(streamLevelFor("info"), "info");
  assert.equal(streamLevelFor("warn"), "default");
});

test('sources["ios-sim"].minLevel lowers the log stream floor so debug enters the ring', async () => {
  const simctl = await fakeSimctl();
  const { host, buffer } = pipeline();
  host.add({
    name: "builtin",
    apiVersion: "0.1",
    sources: [
      iosSimSource(iosSimConfig({ bundleId: BUNDLE, minLevel: "debug" })!, {
        runner: simctl.runner,
        restartMs: 5,
      }),
    ],
  });
  await host.startAll();
  await until(() => buffer.snapshot().length === PARSED_LOG_EVENTS, "debug included");
  await host.stopAll();
  const stream = simctl.calls.find((c) => c.includes("stream"))!;
  assert.equal(stream[stream.indexOf("--level") + 1], "debug");
  assert.ok(buffer.snapshot().some((e) => e.level === "debug"), "debug enters when floor is debug");
});

const CAPTURE_TIME = "2026-10-30 11:54:20.5827 +0300";
const CRASHED_AT = Date.parse("2026-10-30T11:54:20.582+03:00");

/** An .ips report as macOS writes it: a header line, then the body. */
const crashReport = (bundleId: string, udid: string, pid = 4321) =>
  `${JSON.stringify({ app_name: "FixtureApp", bundleID: bundleId, bug_type: "309", name: "FixtureApp" })}\n${JSON.stringify(
    {
      procName: "FixtureApp",
      procPath: `/Users/dev/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/FixtureApp.app/FixtureApp`,
      pid,
      captureTime: CAPTURE_TIME,
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
      termination: { indicator: "Segmentation fault: 11" },
    },
    null,
    2,
  )}`;

test("crash reports parse once whole, and read as one line", () => {
  const text = crashReport(BUNDLE, UDID);
  assert.equal(parseCrashReport(text.slice(0, text.length - 5)), undefined, "a half-written report");
  const report = parseCrashReport(text)!;
  assert.deepEqual(
    [report.bundleId, report.pid, report.exceptionType, report.signal, report.capturedAt],
    [BUNDLE, 4321, "EXC_BAD_ACCESS", "SIGSEGV", CRASHED_AT],
  );
  assert.equal(crashMessage(report), "FixtureApp crashed with EXC_BAD_ACCESS (SIGSEGV): Segmentation fault: 11");
  assert.equal(crashMessage({ ...report, exceptionType: undefined, signal: undefined, termination: undefined }), "FixtureApp crashed");
});

test("a new crash report for this app on this simulator becomes a fatal ios-sim event, at the time it crashed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hindwatch-crash-reports-"));
  try {
    const { host, events } = await attach("/", [], dir);
    await until(() => events().length === BUFFERED_EVENTS, "the recorded events");
    await writeFile(join(dir, "Other-1.ips"), crashReport("com.example.other", UDID));
    await writeFile(join(dir, "Elsewhere-1.ips"), crashReport(BUNDLE, "00000000-0000-0000-0000-000000000000"));
    await writeFile(join(dir, "notes.txt"), crashReport(BUNDLE, UDID));
    await writeFile(join(dir, "FixtureApp-1.ips"), crashReport(BUNDLE, UDID));
    await until(() => events().some((e) => e.attrs.crashReport !== undefined), "the crash event");
    await writeFile(join(dir, "FixtureApp-1.ips"), crashReport(BUNDLE, UDID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.stopAll();
    const crashes = events().filter((e) => e.attrs.crashReport !== undefined);
    assert.deepEqual(
      crashes.map((e) => [e.source, e.deviceId, e.app, e.pid, e.deviceTs, e.level, e.msg, e.attrs.crashReport]),
      [["ios-sim", UDID, BUNDLE, 4321, CRASHED_AT, "fatal", "FixtureApp crashed with EXC_BAD_ACCESS (SIGSEGV): Segmentation fault: 11", join(dir, "FixtureApp-1.ips")]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
