import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  crashReportFiles,
  IOS_MIN_LEVEL,
  iosSource,
  listDevices,
  Lockdown,
  parseConfig,
  pickDevice,
  readPairRecord,
  type ClockSample,
  type ProcessRunner,
  type RawEvent,
  type SourceContext,
  type SourceHealth,
} from "@hindwatch/core";
import { fakeUsbmuxd, type FakeDevice, type FakeUsbmuxdOptions } from "./fake-usbmuxd.js";
import { OS_TRACE_LOG, relayFrames, until } from "./helpers.js";
import { test } from "./timed.js";

const BUNDLE = "com.example.app";
const UDID = "00008110-000A1B2C3D4E5F60";
const APP = "/private/var/containers/Bundle/Application/5F0C2A9E-7B41-4D3A-9C6E-2B8F1D4A7E30/HindwatchRN.app";
const DEVICE_AHEAD_MS = 1_500;
const iosConfig = (options: Record<string, unknown>) => parseConfig({ sources: { ios: options } }).sources.ios!;

/** The two entries of the app's own in the recorded relay output; the third is locationd's. */
const RECORDED = [
  {
    pid: 14125,
    deviceTs: 1793363236838,
    level: "info",
    msg: "'hwburst 1793363236764 0  ü😀', { i: 0, nested: { a: [ 1, 2 ] } }",
  },
  {
    pid: 14125,
    deviceTs: 1793363236849,
    level: "error",
    msg: "'hwburst 1793363236764 3 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ü😀', { i: 3, nested: { a: [ 1, 2 ] } }",
  },
];

const CAPTURE_TIME = "2026-10-30 15:31:47.8812 +0300";
const CRASHED_AT = Date.parse("2026-10-30T15:31:47.881+03:00");

/** An .ips report as the device writes it: a header line, then the body. */
const crashReport = (bundleId: string) =>
  `${JSON.stringify({ app_name: "HindwatchRN", bundleID: bundleId, bug_type: "309", name: "HindwatchRN" })}\n${JSON.stringify({
    procName: "HindwatchRN",
    procPath: `${APP}/HindwatchRN`,
    pid: 14125,
    captureTime: CAPTURE_TIME,
    exception: { type: "EXC_CRASH", signal: "SIGQUIT" },
    termination: { indicator: "Quit: 3" },
  })}`;

/** Listings fail while failListings is above zero, counting it down; each listing takes listingMs and each copy copyMs. */
interface Faults {
  failListings: number;
  readonly listingMs?: number;
  readonly copyMs?: number;
}

/** devicectl for one iPhone, whose crash logs are whatever the test puts there. */
function fakeDevicectl(crashLogs: Map<string, string>, faults: Faults = { failListings: 0 }) {
  const copies: string[] = [];
  let listings = 0;
  let running = 0;
  const crashLogsOf = ["--device", UDID, "--domain-type", "systemCrashLogs", "-q"];
  const runner: ProcessRunner = {
    async run(command, args) {
      assert.equal(command, "xcrun");
      if (args.join(" ") === ["devicectl", "device", "info", "files", "-j", "-", ...crashLogsOf].join(" ")) {
        running++;
        await new Promise((resolve) => setTimeout(resolve, faults.listingMs ?? 0)).finally(() => running--);
        listings++;
        if (faults.failListings > 0) {
          faults.failListings--;
          throw new Error("CoreDevice is not ready");
        }
        const files = [...crashLogs].map(([name, text]) => ({ name, relativePath: name, metadata: { size: text.length }, resources: { isDirectory: false } }));
        return JSON.stringify({ result: { files: [{ name: "Assistant", relativePath: "Assistant", metadata: { size: 96 } }, ...files] } });
      }
      const [, , , , source, name, destination, copy, ...rest] = args;
      if (args.slice(0, 4).join(" ") === "devicectl device copy from" && source === "--source" && destination === "--destination" && rest.join(" ") === crashLogsOf.join(" ")) {
        copies.push(name!);
        await new Promise((resolve) => setTimeout(resolve, faults.copyMs ?? 0));
        await writeFile(copy!, crashLogs.get(name!)!);
        return "";
      }
      throw new Error(`unexpected devicectl ${args.join(" ")}`);
    },
    async runBytes() {
      throw new Error("devicectl is read as text");
    },
    async read() {
      throw new Error("devicectl is read as text");
    },
    async stream() {
      throw new Error("devicectl is read as text");
    },
  };
  return { runner, copies, listings: () => listings, running: () => running };
}

/** A source context that keeps what the source reports. */
function context() {
  const abort = new AbortController();
  const events: RawEvent[] = [];
  const health: SourceHealth[] = [];
  const samples: [string, ClockSample][] = [];
  const logs: string[] = [];
  const ctx: SourceContext = {
    root: "/",
    signal: abort.signal,
    emit: (event) => events.push(event),
    setClockSample: (deviceId, sample) => samples.push([deviceId, sample]),
    clearClockSample: () => {},
    setHealth: (next) => health.push(next),
    log: (message) => logs.push(message),
  };
  return { ctx, events, health, samples, logs };
}

interface AttachOptions {
  readonly config?: Record<string, unknown>;
  readonly devices?: readonly string[];
  readonly paired?: boolean;
  readonly installed?: boolean;
  readonly relay?: Buffer;
  readonly crashLogs?: Map<string, string>;
  readonly faults?: Faults;
  readonly mux?: Pick<FakeUsbmuxdOptions, "tls" | "forgotten" | "ignores">;
}

async function attach(options: AttachOptions = {}) {
  const devices = options.devices ?? [UDID];
  const attached: FakeDevice[] = devices.map((udid) => ({ udid, connection: "USB" }));
  const mux = await fakeUsbmuxd({
    devices: attached,
    paired: new Set(options.paired === false ? [] : devices),
    installed: new Map(options.installed === false ? [] : [[BUNDLE, APP]]),
    deviceNow: () => Date.now() + DEVICE_AHEAD_MS,
    relay: options.relay ?? (await readFile(OS_TRACE_LOG)),
    ...options.mux,
  });
  const crashLogs = options.crashLogs ?? new Map<string, string>();
  const devicectl = fakeDevicectl(crashLogs, options.faults);
  const source = iosSource(iosConfig({ bundleId: BUNDLE, ...options.config }), { runner: devicectl.runner, usbmuxd: mux.path, restartMs: 5, crashPollMs: 5 });
  const reported = context();
  await source.start(reported.ctx);
  return {
    ...reported,
    ...devicectl,
    mux,
    attached,
    crashLogs,
    async stop() {
      await source.stop();
      await mux.close();
    },
  };
}

test("an iPhone's log reaches the source through usbmuxd: the app's entries at or above the floor, labelled, on the device clock", async () => {
  const run = await attach();
  try {
    await until(() => run.events.length === RECORDED.length, "the app's recorded entries");
    assert.deepEqual(
      run.events.map((e) => ({ pid: e.pid, deviceTs: e.deviceTs, level: e.level, msg: e.msg })),
      RECORDED,
      "locationd's entry is left out, and the app's keep their stamp, level and text",
    );
    for (const e of run.events) {
      assert.deepEqual([e.source, e.deviceId, e.app], ["ios", UDID, BUNDLE]);
      assert.deepEqual(e.attrs, { subsystem: "com.facebook.react.log", category: "javascript" });
    }
    assert.deepEqual(run.mux.requests, [
      "mux ListDevices",
      "mux ReadPairRecord",
      "mux Connect",
      "lockdown StartSession",
      "lockdown StartService com.apple.mobile.installation_proxy",
      "mux Connect",
      "installation_proxy Lookup",
      "lockdown GetValue TimeIntervalSince1970",
      "lockdown StartService com.apple.os_trace_relay",
      "mux Connect",
      "relay StartActivity",
    ]);
    const [deviceId, sample] = run.samples[0]!;
    assert.equal(deviceId, UDID);
    assert.ok(Math.abs(sample.deviceTs - sample.hostTs - DEVICE_AHEAD_MS) < 50, "the offset is the device clock's");
    assert.deepEqual(run.health.at(-1), { status: "live", detail: `streaming HindwatchRN.app on ${UDID}` });
  } finally {
    await run.stop();
  }
});

test('sources.ios.minLevel sets the floor: "error" keeps the app\'s error alone', async () => {
  const run = await attach({ config: { minLevel: "error" } });
  try {
    await until(() => run.health.at(-1)?.status === "live", "the stream");
    await until(() => run.events.length > 0, "the error");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(run.events.map((e) => e.level), ["error"]);
  } finally {
    await run.stop();
  }
});

test("a crash report that appears for this app becomes a fatal event at the time it crashed; others and earlier ones don't", async () => {
  const crashLogs = new Map([["HindwatchRN-2026-10-29-101010.ips", crashReport(BUNDLE)]]);
  const run = await attach({ crashLogs });
  try {
    await until(() => run.listings() > 0, "the reports already there");
    crashLogs.set("logd.diskwrites_resource-2026-10-30-002823.ips", "{\"bug_type\":\"145\"}\nIncident Identifier: text, not JSON");
    crashLogs.set("Other-2026-10-30-153150.ips", crashReport("com.example.other"));
    crashLogs.set("HindwatchRN-2026-10-30-153150.ips", crashReport(BUNDLE));
    await until(() => run.events.some((e) => e.attrs?.crashReport !== undefined), "the crash event");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const crashes = run.events.filter((e) => e.attrs?.crashReport !== undefined);
    assert.deepEqual(
      crashes.map((e) => [e.source, e.deviceId, e.app, e.pid, e.deviceTs, e.level, e.msg, e.attrs]),
      [["ios", UDID, BUNDLE, 14125, CRASHED_AT, "fatal", "HindwatchRN crashed with EXC_CRASH (SIGQUIT): Quit: 3", { crashReport: "HindwatchRN-2026-10-30-153150.ips", exceptionType: "EXC_CRASH", signal: "SIGQUIT" }]],
    );
    assert.equal(run.copies.filter((name) => name.startsWith("logd.")).length, 1, "a report of another format is read once");
    assert.ok(!run.copies.includes("HindwatchRN-2026-10-29-101010.ips"), "reports from before the attach are left alone");
  } finally {
    await run.stop();
  }
});

const crashEvents = (events: readonly RawEvent[]) => events.filter((e) => e.attrs?.crashReport !== undefined);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a crash report still being written is read again once it grows, and reported once", async () => {
  const crashLogs = new Map<string, string>();
  const run = await attach({ crashLogs });
  try {
    await until(() => run.listings() > 0, "the reports already there");
    const name = "HindwatchRN-2026-10-30-153150.ips";
    const full = crashReport(BUNDLE);
    crashLogs.set(name, full.slice(0, full.indexOf("\n") + 10));
    await until(() => run.copies.includes(name), "the partial report read");
    await settle();
    assert.deepEqual(crashEvents(run.events), [], "a partial report is no crash yet");
    crashLogs.set(name, full);
    await until(() => crashEvents(run.events).length > 0, "the crash event");
    await settle();
    assert.equal(crashEvents(run.events).length, 1);
    crashLogs.set(name, `${full}\n`);
    await until(() => run.listings() > 2, "listings after it changed size");
    await settle();
    assert.equal(crashEvents(run.events).length, 1, "a report that parsed is reported once, whatever its size does after");
    assert.deepEqual(run.copies, [name, name], "read again once, when it grew, and then left alone");
  } finally {
    await run.stop();
  }
});

test("a failed crash log listing is logged once and retried, and the first listing that works is the baseline", async () => {
  const crashLogs = new Map([["HindwatchRN-2026-10-29-101010.ips", crashReport(BUNDLE)]]);
  const faults = { failListings: 3 };
  const run = await attach({ crashLogs, faults });
  try {
    await until(() => run.listings() > 3, "a listing that works");
    crashLogs.set("HindwatchRN-2026-10-30-153150.ips", crashReport(BUNDLE));
    await until(() => crashEvents(run.events).length > 0, "the crash event");
    faults.failListings = 1;
    await until(() => faults.failListings === 0, "another failed listing");
    await settle();
    assert.deepEqual(crashEvents(run.events).map((e) => e.attrs?.crashReport), ["HindwatchRN-2026-10-30-153150.ips"]);
    const failure = `listing crash reports on ${UDID} failed, retrying: CoreDevice is not ready`;
    assert.deepEqual(run.logs.filter((line) => line.includes("listing crash reports")), [failure, failure], "logged once per run of failures");
  } finally {
    await run.stop();
  }
});

test("a crash report written while the iPhone was detached is reported once it is back, and nothing is listed meanwhile", async () => {
  const crashLogs = new Map<string, string>();
  const run = await attach({ crashLogs });
  try {
    await until(() => run.listings() > 0, "the reports already there");
    const device = run.attached.pop()!;
    run.mux.unplug();
    await until(() => run.health.at(-1)?.detail?.startsWith("no iPhone attached") === true, "detached");
    const listings = run.listings();
    crashLogs.set("HindwatchRN-2026-10-30-153150.ips", crashReport(BUNDLE));
    await settle();
    assert.equal(run.listings(), listings, "the crash log poller stopped with the stream");
    run.attached.push(device);
    await until(() => crashEvents(run.events).length > 0, "the crash event after reattaching");
    await settle();
    assert.equal(crashEvents(run.events).length, 1);
  } finally {
    await run.stop();
  }
});

test("stopping waits for a crash log listing under way", async () => {
  const run = await attach({ faults: { failListings: 0, listingMs: 50 } });
  try {
    await until(() => run.running() > 0, "a listing under way");
  } finally {
    await run.stop();
  }
  assert.equal(run.running(), 0);
});

test("the app under a new pid is logged as restarted, and the device clock is measured again", async () => {
  const recorded = await readFile(OS_TRACE_LOG);
  const restarted = Buffer.from(relayFrames(recorded)[2]!);
  restarted.writeUInt32LE(14337, 5 + 9);
  const run = await attach({ relay: Buffer.concat([recorded, restarted]) });
  try {
    await until(() => run.events.length === RECORDED.length + 1, "the restarted app's entry");
    assert.equal(run.events.at(-1)!.pid, 14337);
    assert.ok(run.logs.includes(`${BUNDLE} restarted: pid 14125 -> 14337`));
    await until(() => run.samples.length === 2, "the clock measured again");
  } finally {
    await run.stop();
  }
});

test("an iPhone that signs in over TLS, as a real one does, streams the same", async () => {
  const run = await attach({ mux: { tls: { pairedWith: "device" } } });
  try {
    await until(() => run.events.length === RECORDED.length, "the app's recorded entries");
    assert.deepEqual(run.health.at(-1), { status: "live", detail: `streaming HindwatchRN.app on ${UDID}` });
    assert.ok(run.samples.length > 0, "the clock read over the signed-in session");
  } finally {
    await run.stop();
  }
});

test("stopping while lockdownd or installation_proxy never answers still stops", async () => {
  for (const ignores of ["StartSession", "Lookup"]) {
    const run = await attach({ mux: { ignores } });
    await until(() => run.mux.requests.some((request) => request.endsWith(ignores)), `${ignores} asked`);
    await Promise.race([run.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error(`stop hung on ${ignores}`)), 2_000))]);
    assert.deepEqual(run.health, [], `${ignores}: no health while it was waiting on the device`);
  }
});

test("a stop in the middle of a batch of new crash reports copies no more of them", async () => {
  const crashLogs = new Map<string, string>();
  const run = await attach({ crashLogs, faults: { failListings: 0, copyMs: 20 } });
  await until(() => run.listings() > 0, "the reports already there");
  for (let index = 0; index < 10; index++) crashLogs.set(`HindwatchRN-2026-10-30-15315${index}.ips`, crashReport(BUNDLE));
  await until(() => run.copies.length > 0, "the first copy");
  await run.stop();
  assert.equal(run.copies.length, 1, "only the copy under way when it stopped");
  assert.deepEqual(crashEvents(run.events), [], "and nothing reported after the stop");
});

test("a device that goes away leaves the source waiting, and it streams again when it is back", async () => {
  const run = await attach();
  try {
    await until(() => run.events.length === RECORDED.length, "the first stream");
    run.mux.unplug();
    await until(() => run.health.some((h) => h.status === "waiting" && h.detail === `the log stream from ${UDID} ended`), "waiting");
    await until(() => run.events.length === 2 * RECORDED.length, "the stream again");
    assert.equal(run.health.at(-1)!.status, "live");
  } finally {
    await run.stop();
  }
});

test("the source waits, saying why, for an iPhone that isn't attached, paired or carrying the app", async () => {
  const cases: { options: AttachOptions; detail: string }[] = [
    { options: { devices: [] }, detail: "no iPhone attached: connect one by USB and unlock it" },
    { options: { devices: ["A", "B"] }, detail: "2 iPhones attached (A, B): set sources.ios.device to one" },
    { options: { config: { device: "C" } }, detail: "iPhone C is not attached: connect it by USB and unlock it, or set sources.ios.device to an attached one" },
    { options: { paired: false }, detail: `${UDID} is not paired with this Mac: unlock it and tap Trust` },
    { options: { mux: { forgotten: true } }, detail: `${UDID} no longer trusts this Mac: unplug it, plug it back in, unlock it and tap Trust` },
    { options: { mux: { tls: { pairedWith: "other" } } }, detail: "the device's certificate is not the one it paired with" },
    { options: { installed: false }, detail: `${BUNDLE} is not installed on ${UDID}` },
  ];
  for (const { options, detail } of cases) {
    const run = await attach(options);
    try {
      await until(() => run.health.length >= 3, `${detail}, three times`);
      assert.deepEqual(new Set(run.health.map((h) => JSON.stringify(h))), new Set([JSON.stringify({ status: "waiting", detail })]));
      assert.deepEqual(run.logs, [detail], "logged once while it stays the same");
      assert.deepEqual(run.events, []);
    } finally {
      await run.stop();
    }
  }
});

test("usbmuxd lists a device on both USB and the network once, by USB, and the one asked for is picked", async () => {
  const mux = await fakeUsbmuxd({
    devices: [{ udid: UDID, connection: "Network" }, { udid: "B", connection: "Network" }, { udid: UDID, connection: "USB" }],
    paired: new Set(),
    installed: new Map(),
    deviceNow: Date.now,
    relay: Buffer.alloc(0),
  });
  try {
    const devices = await listDevices(mux.path, new AbortController().signal);
    assert.deepEqual(devices, [{ id: 3, udid: UDID, connection: "USB" }, { id: 2, udid: "B", connection: "Network" }]);
    assert.equal(pickDevice(devices, "B"), devices[1]);
    assert.equal(pickDevice(devices, undefined), devices[0], "the one by USB, when one is");
    assert.throws(() => pickDevice(devices.filter((device) => device.connection !== "USB").concat([{ id: 4, udid: "C", connection: "Network" }]), undefined), /2 iPhones attached \(B, C\)/);
  } finally {
    await mux.close();
  }
});

test("lockdownd requests made at once are answered in turn, each with its own reply", async () => {
  const mux = await fakeUsbmuxd({ devices: [{ udid: UDID, connection: "USB" }], paired: new Set([UDID]), installed: new Map(), deviceNow: () => Date.now() + DEVICE_AHEAD_MS, relay: Buffer.alloc(0) });
  const signal = new AbortController().signal;
  try {
    const [device] = await listDevices(mux.path, signal);
    const session = await Lockdown.open(mux.path, device!, await readPairRecord(mux.path, UDID, signal), signal);
    try {
      const [clock, missing, again] = await Promise.allSettled([session.value("TimeIntervalSince1970"), session.value("ProductVersion"), session.value("TimeIntervalSince1970")]);
      assert.equal(clock.status, "fulfilled");
      assert.match(String((missing as PromiseRejectedResult).reason), /lockdownd refused GetValue: UnsupportedRequest/);
      assert.equal(again.status, "fulfilled");
      assert.ok(Math.abs(Number((again as PromiseFulfilledResult<unknown>).value) * 1000 - Date.now() - DEVICE_AHEAD_MS) < 1000);
    } finally {
      session.close();
    }
  } finally {
    await mux.close();
  }
});

test("devicectl's crash log list keeps .ips files with their sizes", () => {
  const files = { result: { files: [{ relativePath: "Assistant", metadata: { size: 96 } }, { relativePath: "Retired/A.ips", metadata: { size: 10 } }, { relativePath: "B.ips" }] } };
  assert.deepEqual([...crashReportFiles(JSON.stringify(files))], [["Retired/A.ips", 10], ["B.ips", -1]]);
  assert.throws(() => crashReportFiles("{}"), /devicectl printed no result/);
});

test("sources.ios in hindwatch.config.json is validated", () => {
  assert.throws(() => iosConfig({}), /sources.ios.bundleId is required/);
  assert.throws(() => iosConfig({ bundleId: BUNDLE, device: 3 }), /sources.ios.device/);
  assert.throws(() => iosConfig({ bundleId: BUNDLE, minLevel: "loud" }), /sources.ios.minLevel/);
  assert.throws(() => iosConfig({ bundleId: BUNDLE, clockResyncMs: 0 }), /sources.ios.clockResyncMs/);
  assert.deepEqual(iosConfig({ bundleId: BUNDLE }), { bundleId: BUNDLE, device: undefined, minLevel: IOS_MIN_LEVEL, clockResyncMs: 60_000 });
});
