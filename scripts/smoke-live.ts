/**
 * Live smoke test against the tools on this Mac: a booted iOS simulator, an adb device and a
 * running Metro. Each missing piece is skipped. Only counts are printed, never log content.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  androidSource,
  bootedUdid,
  Clocks,
  EventBuffer,
  Ingest,
  iosSimSource,
  parseConfig,
  PluginHost,
  Redactor,
  supervisedRunner,
  type DebugEvent,
  type PluginManifest,
} from "@hindwatch/core";
import createReactNativePlugin from "@hindwatch/plugin-react-native";

const SECONDS = Number(process.env.SMOKE_SECONDS ?? 6);
const IOS_BUNDLE = process.env.SMOKE_IOS_BUNDLE;
const ANDROID_PACKAGE = process.env.SMOKE_ANDROID_PACKAGE ?? "system_server";
const METRO_PORT = Number(process.env.SMOKE_METRO_PORT ?? 8081);
const runner = supervisedRunner();

type Check = () => Promise<string | undefined>;

function tally(events: readonly DebugEvent[], key: (event: DebugEvent) => string): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(key(event), (counts.get(key(event)) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}=${n}`).join(" ");
}

async function tool(command: string, args: string[]): Promise<string | undefined> {
  try {
    return await runner.run(command, args);
  } catch {
    return undefined;
  }
}

const iosReady: Check = async () => {
  if (process.platform !== "darwin") return "not macOS";
  const list = await tool("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (list === undefined) return "xcrun simctl not available";
  return bootedUdid(list) === undefined ? "no booted simulator" : undefined;
};

const androidReady: Check = async () => {
  const devices = await tool("adb", ["devices"]);
  if (devices === undefined) return "adb not available";
  return /\tdevice$/m.test(devices) ? undefined : "no adb device";
};

async function metro(path: string): Promise<string> {
  const response = await fetch(`http://localhost:${METRO_PORT}${path}`, { signal: AbortSignal.timeout(2_000) });
  return response.text();
}

const metroReady: Check = async () => {
  try {
    if (!(await metro("/status")).includes("packager-status:running")) return "Metro not running";
  } catch {
    return `nothing on port ${METRO_PORT}`;
  }
  try {
    const pages: unknown = JSON.parse(await metro("/json/list"));
    if (Array.isArray(pages) && pages.length > 0) return undefined;
  } catch {
    // an unreadable page list is treated like an empty one
  }
  return "Metro is up but lists no debuggable pages at /json/list; is the app running and connected?";
};

const sources = parseConfig({
  sources: {
    // SpringBoard is always running on a booted simulator, so it needs no app of ours.
    "ios-sim": IOS_BUNDLE === undefined ? { bundleId: "com.apple.springboard", process: "SpringBoard" } : { bundleId: IOS_BUNDLE },
    android: { package: ANDROID_PACKAGE },
  },
}).sources;

const smokes: { name: string; ready: Check; manifest: () => PluginManifest | Promise<PluginManifest> }[] = [
  { name: "ios-sim", ready: iosReady, manifest: () => ({ name: "builtin", apiVersion: "0.1", sources: [iosSimSource(sources["ios-sim"]!)] }) },
  { name: "android", ready: androidReady, manifest: () => ({ name: "builtin", apiVersion: "0.1", sources: [androidSource(sources.android!)] }) },
  { name: "react-native", ready: metroReady, manifest: () => createReactNativePlugin({ port: METRO_PORT }) },
];

let failed = false;
for (const smoke of smokes) {
  const skip = await smoke.ready();
  if (skip !== undefined) {
    console.log(`${smoke.name}: skipped (${skip})`);
    continue;
  }
  const clocks = new Clocks();
  const buffer = new EventBuffer({ maxEvents: 100_000, maxAgeMs: 3_600_000 });
  const logs: string[] = [];
  const host = new PluginHost({ root: process.cwd(), ingest: new Ingest({ redactor: new Redactor(), clocks, buffer }), clocks, log: (m) => logs.push(m) });
  host.add(await smoke.manifest());
  await host.startAll();
  await sleep(SECONDS * 1_000);
  await host.stopAll();
  await host.settled();
  const events = buffer.snapshot();
  console.log(
    `${smoke.name}: ${events.length} events in ${SECONDS}s | levels ${tally(events, (e) => e.level)} | ` +
      `devices ${new Set(events.map((e) => e.deviceId)).size} pids ${new Set(events.map((e) => e.pid)).size} | ` +
      `clock ${tally(events, (e) => (e.estimated ? "estimated" : "measured"))} | ` +
      `incidents ${events.filter((e) => e.attrs.incident !== undefined).length} | host log lines ${logs.length}`,
  );
  if (events.length === 0) {
    failed = true;
    console.log(`${smoke.name}: FAIL, no events. Host log: ${logs.join(" / ")}`);
  }
}
process.exitCode = failed ? 1 : 0;
