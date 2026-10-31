/**
 * Gate 8, measured on daemons serving the replay fixture. Prints one PASS/FAIL line per check
 * with the numbers behind it, and exits 1 if any check fails. PERF_SECONDS shortens the windows.
 * With an adb device attached, idle CPU is also measured on it, following PERF_ANDROID_PACKAGE.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { call, CONFIG_FILE, daemonPaths, ensureDaemon, status } from "@hindwatch/core";
import { discardProject } from "../packages/core/test/helpers.js";
import { leftoversSince, ourProcesses } from "./processes.js";

const SECONDS = Number(process.env.PERF_SECONDS ?? 60);
const WARMUP_S = 5;
const MAX_RSS_MB = 150;
const MAX_STEADY_CPU = 10;
const MAX_IDLE_CPU = 0.5;
const GONE_WITHIN_MS = 5_000;
const ANDROID_PACKAGE = process.env.PERF_ANDROID_PACKAGE ?? "com.android.systemui";
const REAL_PATH = process.env.PATH;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURE_PLUGIN = here("../packages/plugin-fixture/src/index.ts");
const REPLAY = here("../fixtures/forced-crash.jsonl");
const FAKE_BIN = here("../packages/core/test/bin");
const exec = promisify(execFile);
const roots: string[] = [];
let failed = false;

function report(pass: boolean, name: string, numbers: string): void {
  failed ||= !pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${numbers}`);
}

/** RSS in MB and CPU seconds of one process, from ps. */
async function sample(pid: number): Promise<{ rssMb: number; cpuS: number }> {
  const { stdout } = await exec("ps", ["-o", "rss=,time=", "-p", String(pid)]);
  const [rss, time] = stdout.trim().split(/\s+/);
  const cpuS = time!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return { rssMb: Number(rss) / 1024, cpuS };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function within(ms: number, condition: () => boolean | Promise<boolean>): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start <= ms) {
    if (await condition()) return Date.now() - start;
    await sleep(50);
  }
  return null;
}

async function daemon(config: object): Promise<{ root: string; pid: number }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-perf-")));
  roots.push(root);
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(config));
  const { status: started } = await ensureDaemon(root);
  return { root, pid: started.pid };
}

const fixture = (rate?: { eventsPerSecond: number; seconds: number }) => ({
  plugins: [
    {
      module: FIXTURE_PLUGIN,
      options: { file: REPLAY, clockSkewMs: { "android-a": 0 }, rate },
    },
  ],
});

/** 1: a burst at 10k events/s, with the timeline kept for 5 s, must hold about 50k events and not grow RSS past the cap. */
async function memory(): Promise<void> {
  const rate = { eventsPerSecond: 10_000, seconds: WARMUP_S + SECONDS };
  const logTimeSpanS = 5;
  const { root, pid } = await daemon({ ...fixture(rate), logTimeSpan: logTimeSpanS * 1_000 });
  const startedAt = Date.now();
  let peak = 0;
  let held = 0;
  while (Date.now() - startedAt < rate.seconds * 1_000 + 1_000) {
    await sleep(1_000);
    const { rssMb } = await sample(pid);
    peak = Math.max(peak, rssMb);
    held = Math.max(held, (await status(root)).events);
  }
  const expected = rate.eventsPerSecond * logTimeSpanS;
  report(
    peak <= MAX_RSS_MB && held <= expected * 1.2,
    "memory, 10k/s burst over a 5s timeline",
    `peak RSS ${peak.toFixed(1)} MB (cap ${MAX_RSS_MB}); most events held ${held} (about ${expected} expected)`,
  );
  await call(root, "stop", { clientId: "perf", force: true });
}

/** 2: CPU at a steady 1k events/s, after a warm-up. */
async function steady(): Promise<void> {
  const rate = { eventsPerSecond: 1_000, seconds: WARMUP_S + SECONDS + 2 };
  const { root, pid } = await daemon(fixture(rate));
  await sleep(WARMUP_S * 1_000);
  const before = await sample(pid);
  const t0 = Date.now();
  await sleep(SECONDS * 1_000);
  const after = await sample(pid);
  const cpu = (100 * (after.cpuS - before.cpuS)) / ((Date.now() - t0) / 1_000);
  report(cpu <= MAX_STEADY_CPU, "cpu, steady 1k events/s", `${cpu.toFixed(2)}% of one core over ${SECONDS}s (cap ${MAX_STEADY_CPU}%), RSS ${after.rssMb.toFixed(1)} MB`);
  await call(root, "stop", { clientId: "perf", force: true });
}

/** CPU of a daemon over one window after the warm-up, and how many events arrived in it. */
async function idleWindow(root: string, pid: number): Promise<{ cpu: number; cpuS: number; events: number }> {
  await sleep(WARMUP_S * 1_000);
  const [before, eventsBefore] = [await sample(pid), (await status(root)).events];
  const t0 = Date.now();
  await sleep(SECONDS * 1_000);
  const [after, eventsAfter] = [await sample(pid), (await status(root)).events];
  const cpuS = after.cpuS - before.cpuS;
  return { cpu: (100 * cpuS) / ((Date.now() - t0) / 1_000), cpuS, events: eventsAfter - eventsBefore };
}

/**
 * 3 and 4: idle with the fixture, an ios-sim stream and an android logcat attached (fake xcrun
 * and adb children that stay quiet), then kill -9, recovery, and a graceful stop.
 */
async function idleAndCleanup(): Promise<void> {
  const starts = join(tmpdir(), `hindwatch-perf-starts-${process.pid}`);
  const adbCalls = join(tmpdir(), `hindwatch-perf-adb-${process.pid}`);
  await Promise.all([rm(starts, { force: true }), rm(adbCalls, { force: true })]);
  Object.assign(process.env, { PATH: `${FAKE_BIN}:${REAL_PATH}`, FAKE_XCRUN_MODE: "idle", FAKE_XCRUN_PIDS: starts, FAKE_ADB_CALLS: adbCalls });
  const config = {
    ...fixture(),
    sources: { "ios-sim": { bundleId: "com.hindwatch.fake", process: "PerfApp", device: "PERF-UDID" }, android: { package: "com.hindwatch.perf" } },
  };
  const { root, pid } = await daemon(config);
  const pidofCalls = async () => (await readFile(adbCalls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const callsBefore = await pidofCalls();
  const idle = await idleWindow(root, pid);
  const pidofs = (await pidofCalls()) - callsBefore;
  report(
    idle.cpu <= MAX_IDLE_CPU,
    "cpu, idle with sources attached",
    `${idle.cpu.toFixed(3)}% of one core over ${SECONDS}s (cap ${MAX_IDLE_CPU}%), ${idle.cpuS.toFixed(2)} CPU s; ` +
      `${pidofs} adb pidof checks in the window`,
  );

  /** [child, supervisor] pids, one pair per stream the fake xcrun served. */
  const children = async () =>
    (await readFile(starts, "utf8")).trim().split("\n").map((line) => line.split(" ").map(Number) as [number, number]);
  const [child, supervisor] = (await children())[0]!;
  process.kill(pid, "SIGKILL");
  const goneMs = await within(GONE_WITHIN_MS, () => !alive(child) && !alive(supervisor));
  const paths = daemonPaths(root);
  const { status: next } = await ensureDaemon(root);
  const daemons = [...(await ourProcesses()).values()].filter((c) => c.includes(`__daemon --root ${root}`)).length;
  report(
    goneMs !== null && daemons === 1 && next.pid !== pid,
    "kill -9",
    `child and supervisor gone in ${goneMs ?? `>${GONE_WITHIN_MS}`} ms; next command reclaimed lock and socket, ${daemons} daemon running`,
  );

  const [child2, supervisor2] = (await children()).at(-1)!;
  await call(root, "stop", { clientId: "perf" });
  const stopMs = await within(GONE_WITHIN_MS, async () => {
    const files = await Promise.allSettled([paths.lock, paths.socket, paths.children, `${paths.children}.${next.pid}.stopping`].map((file) => access(file)));
    return !alive(next.pid) && !alive(child2) && !alive(supervisor2) && files.every((f) => f.status === "rejected");
  });
  report(stopMs !== null, "graceful stop", `daemon, child and supervisor gone, no lock, socket, ledger or ledger hand-off file, in ${stopMs ?? `>${GONE_WITHIN_MS}`} ms`);
  await Promise.all([rm(starts, { force: true }), rm(adbCalls, { force: true })]);
}

/** 3 on a real adb device, after the fake-adb runs so the real adb is the one on PATH. */
async function idleOnDevice(): Promise<void> {
  process.env.PATH = REAL_PATH;
  const devices = await exec("adb", ["devices"]).then(({ stdout }) => stdout, () => "");
  if (!/\tdevice$/m.test(devices)) {
    console.log("SKIP cpu, idle on a real android device: no adb device attached");
    return;
  }
  const { root, pid } = await daemon({ sources: { android: { package: ANDROID_PACKAGE } } });
  const idle = await idleWindow(root, pid);
  report(
    idle.cpu <= MAX_IDLE_CPU,
    "cpu, idle on a real android device",
    `${idle.cpu.toFixed(3)}% of one core over ${SECONDS}s (cap ${MAX_IDLE_CPU}%) following ${ANDROID_PACKAGE}, ` +
      `${(idle.events / SECONDS).toFixed(1)} events/s arrived`,
  );
  await call(root, "stop", { clientId: "perf", force: true });
}

const before = await ourProcesses();
console.log(`perf: ${SECONDS}s windows, the three daemons run side by side`);
try {
  await Promise.all([memory(), steady(), idleAndCleanup()]);
  await idleOnDevice();
} finally {
  for (const root of roots) await discardProject(root);
}
const left = await leftoversSince(before);
report(left.length === 0, "no leftover processes", left.length === 0 ? "none (ps)" : left.join("; "));
process.exitCode = failed ? 1 : 0;
