import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  call,
  Clocks,
  CONFIG_FILE,
  EventBuffer,
  Ingest,
  PLUGIN_API_VERSION,
  PluginHost,
  Redactor,
  type PluginHostDeps,
  type PluginManifest,
  type RawEvent,
  type SourceContext,
} from "@hindwatch/core";

/** A plugin file with one source that does nothing, for tests that need a startable config but no events. */
export const IDLE_SOURCE_PLUGIN = `export default () => ({ name: "idle", apiVersion: "0.1", sources: [{ name: "idle", start: async () => {}, stop: async () => {} }] });\n`;

export const FIXTURE_PLUGIN = fileURLToPath(new URL("../../plugin-fixture/src/index.ts", import.meta.url));
export const SKEWED_LOG = fileURLToPath(new URL("../../../fixtures/skewed-clock.jsonl", import.meta.url));
/** device minus host, matching how skewed-clock.jsonl was recorded */
export const SKEW = { "android-a": 5_000, "ios-b": -3_000 } as const;
/** A recorded logcat, as the entries logcat -B would write. */
export const LOGCAT_LOG = fileURLToPath(new URL("../../../fixtures/logcat-epoch.json", import.meta.url));
/** Bytes logcat -B wrote on an emulator: `am crash <pid>`, and an input timeout on a stopped app. */
export const JAVA_CRASH_LOG = fileURLToPath(new URL("../../../fixtures/logcat-java-crash.bin", import.meta.url));
export const ANR_LOG = fileURLToPath(new URL("../../../fixtures/logcat-anr.bin", import.meta.url));
export const SIMCTL_LOG = fileURLToPath(new URL("../../../fixtures/simctl-ndjson.jsonl", import.meta.url));
/** os_trace_relay's reply, then three entries, recorded from an iPhone: two of an app's and one of locationd's. */
export const OS_TRACE_LOG = fileURLToPath(new URL("../../../fixtures/os-trace-relay.bin", import.meta.url));
export interface TestIdentity {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/** A self-signed certificate and its key, made by openssl for this run and never kept. */
export async function testIdentity(name: string): Promise<TestIdentity> {
  const dir = await mkdtemp(join(tmpdir(), "hindwatch-tls-"));
  try {
    const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", `/CN=hindwatch-test-${name}`, "-days", "1"]);
    return { key: await readFile(key), cert: await readFile(cert) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The frames of recorded os_trace_relay output, each with its 5-byte header: the reply, then entries. */
export function relayFrames(recorded: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < recorded.length; ) {
    const length = recorded[at] === 1 ? recorded.readUInt32BE(at + 1) : recorded.readUInt32LE(at + 1);
    frames.push(recorded.subarray(at, at + 5 + length));
    at += 5 + length;
  }
  return frames;
}
export const FORCED_CRASH_LOG = fileURLToPath(new URL("../../../fixtures/forced-crash.jsonl", import.meta.url));
export const CRASH_DETECTOR_PLUGIN = fileURLToPath(new URL("../../../examples/crash-detector/index.js", import.meta.url));
export const FEED_PLUGIN = fileURLToPath(new URL("./plugins/feed.ts", import.meta.url));
export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
export const TRUE_ORDER = ["step 1", "step 2", "step 3", "step 4", "step 5", "step 6"];

export interface LogcatRecord {
  readonly sec: number;
  readonly nsec: number;
  readonly pid: number;
  readonly tid: number;
  readonly priority: number;
  readonly tag: string;
  readonly msg: string;
}

/** The size of the header an emulator's logcat -B writes. */
const FRAME_HEADER_SIZE = 28;

/** One entry as logcat -B writes it: liblog's header, then priority, tag and message, each NUL-ended. */
export function logcatFrame(record: LogcatRecord): Buffer {
  const payload = Buffer.concat([Buffer.from([record.priority]), Buffer.from(`${record.tag}\0${record.msg}\0`)]);
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt16LE(payload.length, 0);
  header.writeUInt16LE(FRAME_HEADER_SIZE, 2);
  header.writeInt32LE(record.pid, 4);
  header.writeUInt32LE(record.tid, 8);
  header.writeUInt32LE(record.sec, 12);
  header.writeUInt32LE(record.nsec, 16);
  return Buffer.concat([header, payload]);
}

/** A host wired to a fresh buffer, as the daemon wires it. */
export function pipeline(
  log: (message: string) => void = () => {},
  limits: Pick<
    PluginHostDeps,
    "enrichTimeoutMs" | "maxQueuedPerSource" | "now" | "silentAfterMs" | "isMuted" | "mutedBuffer"
  > = {},
) {
  const clocks = new Clocks();
  const buffer = new EventBuffer({ maxEvents: 10_000, maxEventsPerSource: 10_000, maxAgeMs: 3_600_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks, buffer });
  const host = new PluginHost({ root: "/", ingest, clocks, log, ...limits });
  return { clocks, buffer, host, ingest };
}

/** Polls until the condition holds, for sources that run in the background. */
export async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Like until, for conditions that are slow to check: polls every 100 ms, 5 s by default (gate 8). */
export async function eventually(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pid and command line of every process whose command line contains text. */
export async function processesMatching(text: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,command="]);
  return stdout.split("\n").filter((line) => line.includes(text));
}

/** Resolves when the signal aborts, like a live log stream that only ends when stopped. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
}

/** A plugin whose source emits whatever the test hands it once the host has started. */
export function emitter(extra: Omit<PluginManifest, "name" | "apiVersion" | "sources"> = {}) {
  let ctx: SourceContext | undefined;
  const manifest: PluginManifest = {
    name: "probe",
    apiVersion: PLUGIN_API_VERSION,
    sources: [{ name: "probe", start: async (c) => void (ctx = c), stop: async () => {} }],
    ...extra,
  };
  return { manifest, emit: (event: RawEvent) => ctx!.emit(event) };
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Only what a fresh `sh -c` from a non-terminal caller has: no client or session variables. */
export function bareEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, HINDWATCH_RUNTIME_DIR } = process.env;
  return Object.fromEntries(Object.entries({ PATH, HOME, HINDWATCH_RUNTIME_DIR }).filter(([, v]) => v !== undefined));
}

/**
 * Runs the CLI as one client, or with exactly the given environment. A non-zero exit is a result
 * here, not a throw.
 */
export function runCli(root: string, args: readonly string[], client: string | { env: NodeJS.ProcessEnv } = "cli-test"): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), CLI, ...args, "--root", root],
      { env: typeof client === "string" ? { ...process.env, HINDWATCH_CLIENT: client } : client.env },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
      },
    );
  });
}

/** A project whose app is the feed plugin: what a test appends to feed.jsonl is the live app. */
export async function feedApp(config: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-feed-")));
  const feed = join(root, "feed.jsonl");
  await writeFile(feed, "");
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: [{ module: FEED_PLUGIN, options: { file: "feed.jsonl" } }], ...config }));
  const append = (...events: ReadonlyArray<Partial<RawEvent>>) =>
    appendFile(feed, events.map((event) => `${JSON.stringify({ level: "info", msg: "", ...event })}\n`).join(""));
  return { root, append };
}

/**
 * Stops the root's daemon, waits for it to exit, then deletes the root. A daemon that is already
 * dead gets what the next `stop` would do for it. The runtime folder is left as the daemon left
 * it, for the leftover check to inspect.
 */
export async function discardProject(root: string): Promise<void> {
  const pid = await call(root, "status").then((s) => (s as { pid: number }).pid, () => null);
  if (pid === null) {
    await runCli(root, ["stop", "--force"]);
  } else {
    await call(root, "stop", { clientId: "cleanup", force: true }).catch(() => {});
    await eventually(() => !alive(pid), `daemon ${pid} to exit`);
  }
  await rm(root, { recursive: true, force: true });
}
