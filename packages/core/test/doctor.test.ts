import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { CONFIG_FILE, HINDWATCH_VERSION, NOISE_FILE, REACT_NATIVE_PLUGIN, askAdbServer, defaultDoctorDeps, runDoctor, runProgram, type DoctorDeps } from "@hindwatch/core";
import { alive, bareEnv, CRASH_DETECTOR_PLUGIN, eventually, IDLE_SOURCE_PLUGIN, runCli } from "./helpers.js";
import { fakeUsbmuxd, type FakeDevice } from "./fake-usbmuxd.js";
import { test } from "./timed.js";

const temps: string[] = [];
after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A project with this config file, or with none when config is null. */
/** Every project gets this plugin file, with one source and nothing to install. */
const ONE_SOURCE = { plugins: ["./a-source.js"] };

async function project(config: Record<string, unknown> | null = ONE_SOURCE, files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-doctor-")));
  temps.push(root);
  await mkdir(join(root, "run"), { mode: 0o700 });
  if (config !== null) await writeFile(join(root, CONFIG_FILE), JSON.stringify(config));
  await writeFile(join(root, "a-source.js"), IDLE_SOURCE_PLUGIN);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

const EVERYTHING = {
  sources: { android: { package: "com.example" }, "ios-sim": { bundleId: "com.example" } },
  plugins: [{ module: REACT_NATIVE_PLUGIN, options: { port: 19000 } }],
};

const SIMCTL_BOOTED = JSON.stringify({ devices: { "iOS 26": [{ name: "iPhone 17", udid: "SIM-1", state: "Booted" }] } });

/** Everything installed and answering; each test breaks one thing. */
function fakes(root: string, overrides: Partial<DoctorDeps> = {}) {
  const runs: string[] = [];
  const fetched: string[] = [];
  const deps: DoctorDeps = {
    platform: "darwin",
    nodeVersion: "22.12.0",
    env: { PATH: "/sdk/bin:/usr/bin" },
    run: async (command, args) => {
      runs.push([command, ...args].join(" "));
      if (command === "/sdk/bin/adb" && args[0] === "version") return "Android Debug Bridge version 1.0.41\nVersion 36.0.0\n";
      if (command === "xcrun" && args[0] === "devicectl") return "651.13.5\n";
      if (command === "xcrun") return SIMCTL_BOOTED;
      throw new Error(`unexpected ${command}`);
    },
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response("packager-status:running");
    }) as typeof fetch,
    adbServer: async () => "emulator-5554\tdevice\nR58M\tunauthorized\n",
    isExecutable: async (path) => path === "/sdk/bin/adb",
    usbmuxd: join(root, "usbmuxd"),
    homedir: "/Users/me",
    runtimeDir: join(root, "run"),
    checkTimeoutMs: 1_000,
    simctlTimeoutMs: 1_000,
    ...overrides,
  };
  return { deps, runs, fetched };
}

const byName = (report: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(report.checks.map((check) => [check.name, check]));

test("doctor passes when everything the config needs is there, and names each check with its detail", async () => {
  const root = await project(EVERYTHING);
  const { deps, fetched } = fakes(root);
  const report = await runDoctor(root, deps);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.version, HINDWATCH_VERSION);
  assert.deepEqual(report.checks.map((check) => [check.name, check.ok, check.required]), [
    ["node", true, true],
    ["config", true, true],
    ["runtime dir", true, true],
    ["adb", true, true],
    ["adb devices", true, false],
    ["xcrun simctl", true, true],
    ["xcrun devicectl", true, false],
    ["iphone", true, false],
    ["metro", true, true],
    ["rename leftovers", true, false],
  ]);
  const checks = byName(report);
  assert.match(checks.adb!.detail, /^\/sdk\/bin\/adb \(from PATH\): Android Debug Bridge version 1\.0\.41$/);
  assert.match(checks["adb devices"]!.detail, /emulator-5554 \(device\), R58M \(unauthorized\)/);
  assert.match(checks["xcrun simctl"]!.detail, /booted: iPhone 17 \(SIM-1\)/);
  assert.deepEqual(fetched, ["http://localhost:19000/status"]);
  assert.ok(report.checks.every((check) => check.fix === undefined));
});

test("a stopped adb server is reported, not started: doctor never runs an adb command that reaches the server", async () => {
  const root = await project(EVERYTHING);
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5037"), { code: "ECONNREFUSED" });
  const { deps, runs } = fakes(root, { adbServer: async () => Promise.reject(refused) });
  const report = await runDoctor(root, deps);
  const devices = byName(report)["adb devices"]!;
  assert.equal(devices.ok, false);
  assert.match(devices.detail, /no adb server on port 5037; doctor doesn't start one/);
  assert.ok(devices.fix);
  assert.equal(report.ok, true, "no device is not a required failure");
  assert.deepEqual(runs.filter((run) => run.includes("adb")), ["/sdk/bin/adb version"]);
});

test("a configured serial that isn't ready is named, with a fix, and doesn't fail doctor", async () => {
  const root = await project({ ...EVERYTHING, sources: { ...EVERYTHING.sources, android: { package: "com.example", serial: "R58M" } } });
  const report = await runDoctor(root, fakes(root).deps);
  const devices = byName(report)["adb devices"]!;
  assert.deepEqual([devices.ok, devices.required, report.ok], [false, false, true]);
  assert.match(devices.detail, /^configured serial R58M isn't ready; adb sees emulator-5554 \(device\), R58M \(unauthorized\)$/);
  assert.equal(devices.fix, "boot or attach R58M");
});

test("with ADB_SERVER_SOCKET set the device list is skipped as unsupported, never read from 5037", async () => {
  const root = await project(EVERYTHING);
  const asked: number[] = [];
  const { deps } = fakes(root, {
    env: { PATH: "/sdk/bin:/usr/bin", ADB_SERVER_SOCKET: "tcp:192.168.1.5:5037" },
    adbServer: async (port) => (asked.push(port), "emulator-5554\tdevice\n"),
  });
  const report = await runDoctor(root, deps);
  const devices = byName(report)["adb devices"]!;
  assert.deepEqual([devices.ok, devices.required, report.ok], [false, false, true]);
  assert.match(devices.detail, /ADB_SERVER_SOCKET=tcp:192\.168\.1\.5:5037 is set, which doctor doesn't support/);
  assert.ok(devices.fix);
  assert.deepEqual(asked, []);
});

test("the adb server is asked over its own protocol on localhost, and a closed port is ECONNREFUSED", async (t) => {
  const requests: string[] = [];
  const server: Server = createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(data.toString());
      const payload = "emulator-5554\tdevice\n";
      socket.end(`OKAY${payload.length.toString(16).padStart(4, "0")}${payload}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  assert.equal(await askAdbServer(port, "host:devices", AbortSignal.timeout(1_000)), "emulator-5554\tdevice\n");
  assert.deepEqual(requests, ["000chost:devices"]);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(askAdbServer(port, "host:devices", AbortSignal.timeout(1_000)), { code: "ECONNREFUSED" });
});

test("doctor reports the adb the daemon will run, and a missing adb only counts when android is configured", async () => {
  const env = { PATH: "/usr/bin", ANDROID_HOME: "/Users/me/Android/sdk" };
  const sdkAdb = "/Users/me/Android/sdk/platform-tools/adb";
  const configured = await project(EVERYTHING);
  const { deps, runs } = fakes(configured, {
    env,
    isExecutable: async (path) => path === sdkAdb,
    run: async (command, args) => (runs.push([command, ...args].join(" ")), command === "xcrun" ? SIMCTL_BOOTED : "Android Debug Bridge version 1.0.41\n"),
  });
  const adb = byName(await runDoctor(configured, deps)).adb!;
  assert.deepEqual([adb.ok, adb.detail], [true, `${sdkAdb} (from ANDROID_HOME): Android Debug Bridge version 1.0.41`]);
  assert.ok(runs.includes(`${sdkAdb} version`));

  const missing = await runDoctor(configured, fakes(configured, { env, isExecutable: async () => false }).deps);
  assert.deepEqual([byName(missing).adb!.ok, missing.ok], [false, false]);
  assert.match(byName(missing).adb!.detail, /not on PATH or at \/Users\/me\/Android\/sdk\/platform-tools\/adb, \/Users\/me\/Library\/Android\/sdk\/platform-tools\/adb$/);

  const bare = await project();
  const optional = await runDoctor(bare, fakes(bare, { isExecutable: async () => false }).deps);
  assert.deepEqual([byName(optional).adb!.ok, byName(optional).adb!.required, optional.ok], [false, false, true]);
});

test("off macOS the simulator check is skipped without running xcrun", async () => {
  const root = await project(EVERYTHING);
  const { deps, runs } = fakes(root, { platform: "linux" });
  const report = await runDoctor(root, deps);
  const simctl = byName(report)["xcrun simctl"]!;
  assert.deepEqual([simctl.ok, simctl.required], [true, false]);
  assert.match(simctl.detail, /^skipped: .*linux/);
  assert.ok(!runs.some((run) => run.startsWith("xcrun")));
});

test("Metro at the default port: down or not Metro fails, and fails doctor only with the react-native plugin", async () => {
  const bare = await project();
  const down = fakes(bare, { fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch });
  const optional = await runDoctor(bare, down.deps);
  assert.deepEqual([byName(optional).metro!.ok, optional.ok], [false, true]);
  assert.match(byName(optional).metro!.detail, /nothing answered at http:\/\/localhost:8081\/status/);

  const rn = await project({ plugins: [REACT_NATIVE_PLUGIN] });
  const other = fakes(rn, { fetch: (async () => new Response("hello", { status: 200 })) as typeof fetch });
  const report = await runDoctor(rn, other.deps);
  assert.equal(report.ok, false);
  assert.match(byName(report).metro!.detail, /answered 200 "hello", not Metro/);
  assert.match(byName(report).metro!.fix!, /port 8081/);
});

test("an old Node, a bad config or an open runtime folder fails doctor; a missing runtime folder doesn't", async () => {
  const root = await project();
  assert.equal((await runDoctor(root, fakes(root, { nodeVersion: "20.18.0" }).deps)).ok, false);

  await writeFile(join(root, CONFIG_FILE), "{ nope");
  const bad = await runDoctor(root, fakes(root).deps);
  assert.deepEqual([byName(bad).config!.ok, bad.ok], [false, false]);
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(ONE_SOURCE));

  await chmod(join(root, "run"), 0o755);
  const open = await runDoctor(root, fakes(root).deps);
  assert.deepEqual([byName(open)["runtime dir"]!.ok, open.ok], [false, false]);

  const missing = await runDoctor(root, fakes(root, { runtimeDir: join(root, "not-yet") }).deps);
  assert.equal(byName(missing)["runtime dir"]!.ok, true);
  assert.match(byName(missing)["runtime dir"]!.detail, /doesn't exist yet/);
});

test("doctor names the root, and with no config file names the package.json its zero-config came from and how to add native logs", async () => {
  for (const [kind, dependency] of [["expo", "expo"], ["bare-rn", "react-native"]] as const) {
    const root = await project(null, { "package.json": JSON.stringify({ dependencies: { [dependency]: "*" } }) });
    const report = await runDoctor(root, fakes(root).deps);
    assert.equal(report.root, root);
    assert.deepEqual([byName(report).config!.ok, byName(report).config!.detail], [true, `zero-config: ${kind} (from ${join(root, "package.json")}), android off, ios-sim off, ios off, 1 plugin(s); add android or ios-sim or ios to ${CONFIG_FILE} for native logs`]);
  }
  const configured = await project();
  assert.equal(byName(await runDoctor(configured, fakes(configured).deps)).config!.detail, `${join(configured, CONFIG_FILE)}, android off, ios-sim off, ios off, 1 plugin(s)`);
});

test("a package.json that doesn't parse, or a config with no sources, file or detected, fails doctor's config check", async () => {
  const broken = await project(null, { "package.json": "{ nope" });
  const report = await runDoctor(broken, fakes(broken).deps);
  const config = byName(report).config!;
  assert.deepEqual([report.ok, config.ok, config.required], [false, false, true]);
  assert.match(config.detail, new RegExp(`^${join(broken, "package.json")} doesn't parse: `));
  assert.equal(config.fix, `fix ${join(broken, "package.json")}, or add ${CONFIG_FILE}`);

  for (const files of [{}, { "package.json": "{}" }] as Record<string, string>[]) {
    const empty = await project(null, files);
    const nothing = await runDoctor(empty, fakes(empty).deps);
    assert.deepEqual([nothing.ok, byName(nothing).config!.ok, byName(nothing).config!.fix], [false, false, `add a source to ${CONFIG_FILE}`]);
    assert.match(byName(nothing).config!.detail, /^nothing to capture in /);
  }
  const sourceless = await project({});
  const sourcelessReport = await runDoctor(sourceless, fakes(sourceless).deps);
  assert.deepEqual([sourcelessReport.ok, byName(sourcelessReport).config!.fix], [false, `add a source to ${CONFIG_FILE}`]);
  assert.equal(byName(sourcelessReport).config!.detail, `nothing to capture in ${sourceless}: ${join(sourceless, CONFIG_FILE)} names no sources or plugins; add a source to ${CONFIG_FILE}`);
  const detectorOnly = await project({ plugins: [CRASH_DETECTOR_PLUGIN] });
  const detectorReport = await runDoctor(detectorOnly, fakes(detectorOnly).deps);
  assert.deepEqual([detectorReport.ok, byName(detectorReport).config!.fix], [false, `add a source to ${CONFIG_FILE}`]);
  assert.match(byName(detectorReport).config!.detail, /has no source, only plugins without one \(crash-detector\); add a source to hindwatch\.config\.json$/);
});

test("the checks run side by side, and one that hangs times out on its own", async () => {
  const root = await project(EVERYTHING);
  // Each tool answers only once all three have been asked, so a one-at-a-time doctor would hang.
  let asked = 0;
  let release = () => {};
  const allAsked = new Promise<void>((resolve) => (release = resolve));
  const barrier = async <T>(value: T) => {
    if (++asked === 3) release();
    await allAsked;
    return value;
  };
  const together = fakes(root, {
    run: (command) => barrier(command === "xcrun" ? SIMCTL_BOOTED : "Android Debug Bridge version 1.0.41\n"),
    fetch: (() => barrier(new Response("packager-status:running"))) as typeof fetch,
    adbServer: () => barrier("emulator-5554\tdevice\n"),
  });
  assert.equal((await runDoctor(root, together.deps)).ok, true);

  let hungSignal: AbortSignal | undefined;
  const hang = (signal: AbortSignal) => ((hungSignal = signal), new Promise<string>(() => {}));
  const hung = fakes(root, { run: (command, args, signal) => (command === "xcrun" && args[0] === "simctl" ? hang(signal) : Promise.resolve("adb 1\n")), simctlTimeoutMs: 50 });
  const report = await runDoctor(root, hung.deps);
  const simctl = byName(report)["xcrun simctl"]!;
  assert.deepEqual([simctl.ok, simctl.detail], [false, "timed out after 50 ms"]);
  assert.equal(hungSignal?.aborted, true, "the hung program is told to stop");
  assert.match(simctl.fix!, /Xcode/);
  assert.ok(report.checks.filter((check) => check.name !== "xcrun simctl").every((check) => check.ok));
});

const STUBS = fileURLToPath(new URL("./bin-doctor", import.meta.url));

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

test("hindwatch doctor prints the report, exits 1 when a required check fails, and starts nothing", async (t) => {
  const adbServer = createServer((socket) => {
    socket.once("data", () => {
      const payload = "emulator-5554\tdevice\n";
      socket.end(`OKAY${payload.length.toString(16).padStart(4, "0")}${payload}`);
    });
  });
  const metro = createHttpServer((_request, response) => response.end("packager-status:running"));
  const adbPort = await listen(adbServer);
  const metroPort = await listen(metro);
  t.after(() => {
    adbServer.close();
    metro.close();
  });
  const root = await project({ ...EVERYTHING, plugins: [{ module: REACT_NATIVE_PLUGIN, options: { port: metroPort } }] });
  const log = join(root, "calls.log");
  await writeFile(log, "");
  const env = { env: { ...bareEnv(), PATH: `${STUBS}${delimiter}${process.env.PATH ?? ""}`, ANDROID_ADB_SERVER_PORT: String(adbPort), DOCTOR_LOG: log } };

  const healthy = await runCli(root, ["doctor"], env);
  assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
  const report = JSON.parse(healthy.stdout) as Awaited<ReturnType<typeof runDoctor>>;
  assert.equal(report.ok, true);
  assert.match(byName(report).adb!.detail, /bin-doctor\/adb \(from PATH\): Android Debug Bridge version 1\.0\.41$/);
  assert.match(byName(report)["adb devices"]!.detail, new RegExp(`port ${adbPort}: emulator-5554 \\(device\\)`));
  assert.match(byName(report).metro!.detail, new RegExp(`localhost:${metroPort}/status`));
  if (process.platform === "darwin") assert.match(byName(report)["xcrun simctl"]!.detail, /Fake iPhone \(FAKE-UDID\)/);

  await new Promise<void>((resolve) => adbServer.close(() => resolve()));
  await new Promise<void>((resolve) => metro.close(() => resolve()));
  const broken = await runCli(root, ["doctor"], env);
  assert.equal(broken.code, 1, broken.stdout + broken.stderr);
  const failed = JSON.parse(broken.stdout) as Awaited<ReturnType<typeof runDoctor>>;
  assert.deepEqual(failed.checks.filter((check) => !check.ok).map((check) => check.name), ["adb devices", "metro"]);
  assert.match(byName(failed)["adb devices"]!.detail, /doctor doesn't start one/);

  const calls = (await readFile(log, "utf8")).trim().split("\n");
  const expected = ["adb version", ...(process.platform === "darwin" ? ["xcrun simctl list devices booted --json"] : [])];
  assert.deepEqual([...new Set(calls)].sort(), expected.sort(), "only adb version, which never reaches the server");
  assert.equal((JSON.parse((await runCli(root, ["status"], env)).stdout) as { running: boolean }).running, false);
});

test("a hung simctl times out at its own limit and its whole process group is killed", async () => {
  const root = await project({ sources: { "ios-sim": { bundleId: "com.example" } } });
  const pids = join(root, "hang-pids");
  const env = { ...bareEnv(), PATH: `${STUBS}${delimiter}${process.env.PATH ?? ""}`, DOCTOR_LOG: join(root, "calls.log"), DOCTOR_HANG_PIDS: pids };
  const deps: DoctorDeps = {
    ...defaultDoctorDeps(),
    platform: "darwin",
    env,
    run: (command, args, signal) => runProgram(command, args, signal, env),
    adbServer: async () => "",
    fetch: (async () => new Response("packager-status:running")) as typeof fetch,
    runtimeDir: join(root, "run"),
    simctlTimeoutMs: 300,
  };
  const report = await runDoctor(root, deps);
  const simctl = byName(report)["xcrun simctl"]!;
  assert.deepEqual([simctl.ok, simctl.required, simctl.detail, report.ok], [false, true, "timed out after 300 ms", false]);
  const [shell, child] = (await readFile(pids, "utf8")).trim().split(" ").map(Number);
  assert.ok(shell && child);
  await eventually(() => !alive(shell) && !alive(child), "the stub and its sleep to be killed");
});

test("doctor flags leftover hindwatch.noise.json without failing the overall report", async () => {
  const root = await project(EVERYTHING, {
    [NOISE_FILE]: JSON.stringify({ mute: [] }),
  });
  const { deps } = fakes(root);
  const report = await runDoctor(root, deps);
  assert.equal(report.ok, true);
  assert.equal(report.version, HINDWATCH_VERSION);
  const leftovers = byName(report)["rename leftovers"]!;
  assert.equal(leftovers.ok, false);
  assert.equal(leftovers.required, false);
  assert.match(leftovers.detail, /hindwatch\.noise\.json/);
  assert.match(leftovers.fix!, /move any mute|remove/);
});

test("xcrun simctl with no booted simulator fails with a boot fix", async () => {
  const root = await project(EVERYTHING);
  const empty = JSON.stringify({ devices: { "iOS 26": [] } });
  const { deps } = fakes(root, {
    run: async (command, args) => {
      if (command === "/sdk/bin/adb" && args[0] === "version") return "Android Debug Bridge version 1.0.41\n";
      if (command === "xcrun") return empty;
      throw new Error(`unexpected ${command}`);
    },
  });
  const report = await runDoctor(root, deps);
  const simctl = byName(report)["xcrun simctl"]!;
  assert.equal(simctl.ok, false);
  assert.match(simctl.detail, /no simulator booted/);
  assert.match(simctl.fix!, /boot a simulator/);
  assert.equal(report.ok, false);
});

test("with sources.ios, devicectl is checked for crash reports, and the iPhone check says whether the iPhone is attached and paired", async () => {
  const root = await project({ sources: { ios: { bundleId: "com.example" } } });
  const ask = async (devices: readonly FakeDevice[], paired: readonly string[]) => {
    const mux = await fakeUsbmuxd({ devices, paired: new Set(paired), installed: new Map(), deviceNow: Date.now, relay: Buffer.alloc(0) });
    try {
      return byName(await runDoctor(root, fakes(root, { usbmuxd: mux.path }).deps));
    } finally {
      await mux.close();
    }
  };
  const ready = await ask([{ udid: "IPHONE-1", connection: "USB" }], ["IPHONE-1"]);
  assert.deepEqual([ready["xcrun devicectl"]!.ok, ready["xcrun devicectl"]!.required, ready["xcrun devicectl"]!.detail], [true, false, "xcrun devicectl 651.13.5 works"]);
  assert.deepEqual([ready.iphone!.ok, ready.iphone!.required, ready.iphone!.detail], [true, false, "IPHONE-1 attached by USB and trusts this Mac"]);
  const unpaired = await ask([{ udid: "IPHONE-1", connection: "Network" }], []);
  assert.deepEqual([unpaired.iphone!.ok, unpaired.iphone!.detail], [false, "IPHONE-1 is not paired with this Mac"]);
  assert.equal(unpaired.iphone!.fix, "unlock it and tap Trust");
  const none = (await ask([], [])).iphone!;
  assert.deepEqual([none.detail, none.fix], ["no iPhone attached", "connect one by USB and unlock it"]);
  const noMux = byName(await runDoctor(root, fakes(root, { usbmuxd: join(root, "no-usbmuxd") }).deps));
  assert.match(noMux.iphone!.detail, /^usbmuxd is not running: nothing listens on .*no-usbmuxd$/);
  assert.match(noMux.iphone!.fix!, /launchctl kickstart -k system\/com\.apple\.usbmuxd/);
});
