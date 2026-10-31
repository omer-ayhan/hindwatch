import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { adbCandidates, resolveAdb } from "./adb-path.js";
import { BUILTIN_SOURCE_NAMES, CONFIG_FILE, NotStartableError, capturingPlugins, PackageJsonError, REACT_NATIVE_PLUGIN, parseConfig, startConfig, type Config } from "./config.js";
import { NOISE_FILE } from "./noise.js";
import { checkRuntimeDir, resolveRoot, runtimeDir } from "./paths.js";
import { pickDevice } from "./sources/ios.js";
import { DeviceError, listDevices, Lockdown, readPairRecord, USBMUXD_SOCKET } from "./sources/usbmux.js";
import { errorMessage, isErrnoException, isPlainObject } from "./util.js";
import { HINDWATCH_VERSION } from "./version.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Whether this check decides doctor's result: the project's config needs what it checks. */
  readonly required: boolean;
  readonly detail: string;
  /** One line on how to fix it, when it isn't ok. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  /** The project folder the checks were run for. */
  readonly root: string;
  /** Package version (hindwatch@…). */
  readonly version: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorDeps {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly env: NodeJS.ProcessEnv;
  /** Runs a program and returns its stdout; rejects on a non-zero exit. On abort it kills all the program started. */
  readonly run: (command: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
  readonly fetch: typeof fetch;
  /** Sends one request to the adb server on this local port and returns its payload. Never starts the server. */
  readonly adbServer: (port: number, request: string, signal: AbortSignal) => Promise<string>;
  readonly isExecutable: (path: string) => Promise<boolean>;
  /** usbmuxd's socket, which lists the iPhones attached to this Mac. */
  readonly usbmuxd: string;
  readonly homedir: string;
  readonly runtimeDir: string;
  /** Per check, so one hung tool can't hold up the report. */
  readonly checkTimeoutMs: number;
  /** simctl alone: its first call after boot can take seconds while CoreSimulator starts. */
  readonly simctlTimeoutMs: number;
}

export const MIN_NODE_MAJOR = 22;
export const DEFAULT_METRO_PORT = 8081;
const DEFAULT_ADB_PORT = 5037;
const DEFAULT_CHECK_TIMEOUT_MS = 8_000;
const DEFAULT_SIMCTL_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 300;

/**
 * Talks the adb server's own wire protocol on localhost. `adb devices` would start a server that
 * isn't running, and doctor must leave the server exactly as it found it.
 */
export function askAdbServer(port: number, request: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, signal });
    let reply = Buffer.alloc(0);
    socket.on("connect", () => socket.write(`${request.length.toString(16).padStart(4, "0")}${request}`));
    socket.on("data", (data) => (reply = Buffer.concat([reply, data])));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = reply.subarray(0, 4).toString();
      const length = Number.parseInt(reply.subarray(4, 8).toString(), 16);
      const payload = reply.subarray(8, 8 + length).toString();
      if (status === "OKAY" && payload.length === length) resolve(payload);
      else if (status === "FAIL") reject(new Error(`the adb server refused ${request}: ${payload}`));
      else reject(new Error(`the adb server sent an unreadable reply to ${request}`));
    });
  });
}

/**
 * Runs the program in its own process group, so an abort kills whatever it started too, not just
 * the program itself.
 */
export function runProgram(command: string, args: readonly string[], signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)));
    const abort = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => (signal.removeEventListener("abort", abort), reject(error)));
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
    });
  });
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env: process.env,
    run: (command, args, signal) => runProgram(command, args, signal),
    fetch,
    adbServer: askAdbServer,
    isExecutable: (path) => access(path, constants.X_OK).then(() => true, () => false),
    usbmuxd: USBMUXD_SOCKET,
    homedir: userInfo().homedir,
    runtimeDir: runtimeDir(),
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    simctlTimeoutMs: DEFAULT_SIMCTL_TIMEOUT_MS,
  };
}

type Outcome = Omit<DoctorCheck, "name" | "required">;

const pass = (detail: string): Outcome => ({ ok: true, detail });
const fail = (detail: string, fix: string): Outcome => ({ ok: false, detail, fix });

interface Check {
  readonly name: string;
  readonly required: boolean;
  /** For a failure the check itself didn't foresee, a timeout included. */
  readonly fix: string;
  readonly timeoutMs: number;
  /** Everything the check starts listens to signal, which aborts at the timeout. */
  readonly run: (signal: AbortSignal) => Promise<Outcome>;
}

function settle({ fix, timeoutMs, run }: Check): Promise<Outcome> {
  const timedOut = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut.abort(new Error(`timed out after ${timeoutMs} ms`));
      resolve(fail(`timed out after ${timeoutMs} ms`, fix));
    }, timeoutMs);
  });
  const checked = run(timedOut.signal).catch((error: unknown) => fail(errorMessage(error), fix));
  return Promise.race([checked, timeout]).finally(() => clearTimeout(timer));
}

function nodeCheck(version: string): Outcome {
  const major = Number.parseInt(version, 10);
  return major >= MIN_NODE_MAJOR
    ? pass(`node ${version}`)
    : fail(`node ${version} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer (nvm install ${MIN_NODE_MAJOR})`);
}

async function runtimeDirCheck(dir: string): Promise<Outcome> {
  try {
    await checkRuntimeDir(dir);
    return pass(`${dir} is private to this user (0700)`);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return pass(`${dir} doesn't exist yet; the first start creates it 0700`);
    return fail(errorMessage(error), `chmod 700 ${dir}, or remove it and let hindwatch recreate it`);
  }
}

async function adbCheck(deps: DoctorDeps, signal: AbortSignal): Promise<Outcome> {
  const found = await resolveAdb(deps);
  if (found === undefined) {
    const looked = adbCandidates(deps).filter((candidate) => candidate.from !== "PATH").map((candidate) => candidate.path);
    return fail(
      `adb is not on PATH${looked.length > 0 ? ` or at ${looked.join(", ")}` : ""}`,
      "install Android platform-tools (Android Studio's SDK Manager, or brew install --cask android-platform-tools)",
    );
  }
  const version = (await deps.run(found.path, ["version"], signal)).split("\n")[0]?.trim();
  return pass(`${found.path} (from ${found.from}): ${version}`);
}

async function adbDevicesCheck(deps: DoctorDeps, serial: string | undefined, signal: AbortSignal): Promise<Outcome> {
  const socket = deps.env.ADB_SERVER_SOCKET;
  if (socket !== undefined && socket !== "") {
    return fail(
      `ADB_SERVER_SOCKET=${socket} is set, which doctor doesn't support; the device list was skipped`,
      "unset ADB_SERVER_SOCKET to use a local adb server, or run adb devices yourself",
    );
  }
  const port = Number(deps.env.ANDROID_ADB_SERVER_PORT ?? DEFAULT_ADB_PORT);
  let list: string;
  try {
    list = await deps.adbServer(port, "host:devices", signal);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ECONNREFUSED") {
      return fail(`no adb server on port ${port}; doctor doesn't start one`, "connect a device or start an emulator, or run adb start-server");
    }
    throw error;
  }
  const devices = list
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [id = "", state = ""] = line.split("\t");
      return { id, state };
    });
  const ready = devices.filter((device) => device.state === "device");
  const listed = devices.map((device) => `${device.id} (${device.state})`).join(", ");
  if (serial !== undefined && !ready.some((device) => device.id === serial)) {
    return fail(`configured serial ${serial} isn't ready; adb sees ${listed || "no devices"}`, `boot or attach ${serial}`);
  }
  return ready.length > 0
    ? pass(`adb server on port ${port}: ${listed}`)
    : fail(`adb server on port ${port} sees ${listed || "no devices"}`, "connect a device with USB debugging on, or start an emulator");
}

async function simctlCheck(deps: DoctorDeps, signal: AbortSignal): Promise<Outcome> {
  const out = await deps.run("xcrun", ["simctl", "list", "devices", "booted", "--json"], signal);
  const parsed: unknown = JSON.parse(out);
  const runtimes = isPlainObject(parsed) && isPlainObject(parsed.devices) ? Object.values(parsed.devices) : [];
  const booted = runtimes
    .flatMap((devices) => (Array.isArray(devices) ? devices : []))
    .filter(isPlainObject)
    .filter((device) => device.state === undefined || device.state === "Booted");
  const names = booted.map((device) => `${String(device.name)} (${String(device.udid)})`);
  if (names.length === 0) {
    return fail(
      "xcrun simctl works; no simulator booted",
      "boot a simulator (open -a Simulator, or xcrun simctl boot <udid>)",
    );
  }
  return pass(`xcrun simctl works; booted: ${names.join(", ")}`);
}

async function devicectlCheck(deps: DoctorDeps, signal: AbortSignal): Promise<Outcome> {
  const version = (await deps.run("xcrun", ["devicectl", "--version"], signal)).trim();
  return pass(`xcrun devicectl ${version} works`);
}

/** The iPhone the ios source would stream: attached, and signing in with this Mac's pairing, as the source does. */
async function iphoneCheck(deps: DoctorDeps, udid: string | undefined, signal: AbortSignal): Promise<Outcome> {
  try {
    const device = pickDevice(await listDevices(deps.usbmuxd, signal), udid);
    const session = await Lockdown.open(deps.usbmuxd, device, await readPairRecord(deps.usbmuxd, device.udid, signal), signal);
    session.close();
    return pass(`${device.udid} attached by ${device.connection} and trusts this Mac`);
  } catch (error) {
    if (error instanceof DeviceError) return fail(error.fact, error.fix);
    throw error;
  }
}

async function metroCheck(deps: DoctorDeps, port: number, signal: AbortSignal): Promise<Outcome> {
  const url = `http://localhost:${port}/status`;
  const fix = `start Metro on port ${port} (npx expo start or npx react-native start)`;
  let response: Response;
  try {
    response = await deps.fetch(url, { signal });
  } catch (error) {
    return fail(`nothing answered at ${url}: ${errorMessage(error)}`, fix);
  }
  const body = (await response.text()).trim();
  return response.ok && body === "packager-status:running"
    ? pass(`Metro is running at ${url}`)
    : fail(`${url} answered ${response.status} ${JSON.stringify(body.slice(0, 80))}, not Metro`, fix);
}

function metroPort(config: Config): { port: number; configured: boolean } {
  const ref = config.plugins.find((plugin) => plugin.module === REACT_NATIVE_PLUGIN);
  const port = ref?.options.port;
  return { port: typeof port === "number" && Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_METRO_PORT, configured: ref !== undefined };
}

function configSource(config: Config): string {
  if (config.detected !== undefined) return `zero-config: ${config.detected.kind} (from ${config.detected.packageJson})`;
  return config.file ?? CONFIG_FILE;
}

function configSummary(config: Config): string {
  const states = BUILTIN_SOURCE_NAMES.map((name) => `${name} ${config.sources[name] === undefined ? "off" : "on"}`);
  const summary = `${states.join(", ")}, ${config.plugins.length} plugin(s)`;
  const native = BUILTIN_SOURCE_NAMES.some((name) => config.sources[name] !== undefined);
  return config.detected !== undefined && !native ? `${summary}; add ${BUILTIN_SOURCE_NAMES.join(" or ")} to ${CONFIG_FILE} for native logs` : summary;
}

function configFix(error: unknown): string {
  if (error instanceof PackageJsonError) return `fix ${error.path}, or add ${CONFIG_FILE}`;
  if (error instanceof NotStartableError) return `add a source to ${CONFIG_FILE}`;
  return `fix ${CONFIG_FILE}`;
}


/** Standalone noise file left after mute moved into CONFIG_FILE (Wave S). */
async function leftoverRenameCheck(root: string): Promise<Outcome> {
  try {
    await access(join(root, NOISE_FILE), constants.F_OK);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return pass(`no leftover ${NOISE_FILE} beside ${CONFIG_FILE}`);
    }
    throw error;
  }
  return fail(
    `leftover ${NOISE_FILE} beside ${CONFIG_FILE}; mute now lives in ${CONFIG_FILE}`,
    `move any mute[] into ${CONFIG_FILE} then remove ${NOISE_FILE}`,
  );
}

/**
 * Checks, in parallel and read-only, that what the project's config needs is installed and
 * reachable. Starts nothing: not the daemon, not the adb server, not a simulator.
 */
export async function runDoctor(root: string, deps: DoctorDeps = defaultDoctorDeps()): Promise<DoctorReport> {
  let config = parseConfig({});
  let configOutcome: Outcome;
  try {
    root = resolveRoot(root);
    config = await startConfig(root, deps.homedir);
    await capturingPlugins(root, config);
    configOutcome = pass(`${configSource(config)}, ${configSummary(config)}`);
  } catch (error) {
    configOutcome = fail(errorMessage(error), configFix(error));
  }
  const android = config.sources.android;
  const ios = config.sources.ios;
  const metro = metroPort(config);
  const darwin = deps.platform === "darwin";
  const timeoutMs = deps.checkTimeoutMs;
  const checks: Check[] = [
    { name: "node", required: true, fix: `install Node ${MIN_NODE_MAJOR} or newer`, timeoutMs, run: async () => nodeCheck(deps.nodeVersion) },
    { name: "config", required: true, fix: `fix ${CONFIG_FILE}`, timeoutMs, run: async () => configOutcome },
    { name: "runtime dir", required: true, fix: `check ${deps.runtimeDir} is a 0700 folder you own`, timeoutMs, run: () => runtimeDirCheck(deps.runtimeDir) },
    { name: "adb", required: android !== undefined, fix: "check that adb version runs", timeoutMs, run: (signal) => adbCheck(deps, signal) },
    // A missing device is often a moment away, and the daemon waits for one, so this only informs.
    {
      name: "adb devices",
      required: false,
      fix: "check the adb server with adb devices",
      timeoutMs,
      run: (signal) => adbDevicesCheck(deps, android?.serial, signal),
    },
    {
      name: "xcrun simctl",
      required: darwin && config.sources["ios-sim"] !== undefined,
      fix: "install Xcode, then sudo xcode-select -s /Applications/Xcode.app",
      timeoutMs: deps.simctlTimeoutMs,
      run: async (signal) => (darwin ? simctlCheck(deps, signal) : pass(`skipped: the iOS simulator needs macOS, this is ${deps.platform}`)),
    },
    // An iPhone's log streams without devicectl; only its crash reports need it.
    {
      name: "xcrun devicectl",
      required: false,
      fix: "for iPhone crash reports, install Xcode 15 or newer, then sudo xcode-select -s /Applications/Xcode.app",
      timeoutMs,
      run: async (signal) =>
        !darwin ? pass(`skipped: iPhones need macOS, this is ${deps.platform}`) : ios === undefined ? pass("skipped: sources.ios is off") : devicectlCheck(deps, signal),
    },
    // Like a missing Android device, a missing iPhone is often a moment away, and the daemon waits for it.
    {
      name: "iphone",
      required: false,
      fix: "check the iPhone is connected by USB and unlocked",
      timeoutMs,
      run: async (signal) =>
        !darwin ? pass(`skipped: iPhones need macOS, this is ${deps.platform}`) : ios === undefined ? pass("skipped: sources.ios is off") : iphoneCheck(deps, ios.device, signal),
    },
    { name: "metro", required: metro.configured, fix: `start Metro on port ${metro.port}`, timeoutMs, run: (signal) => metroCheck(deps, metro.port, signal) },
    {
      name: "rename leftovers",
      required: false,
      fix: `remove leftover ${NOISE_FILE} from ${root}`,
      timeoutMs,
      run: async () => leftoverRenameCheck(root),
    },
  ];
  const results = await Promise.all(
    checks.map(async (check): Promise<DoctorCheck> => ({ name: check.name, required: check.required, ...(await settle(check)) })),
  );
  return { ok: results.every((check) => check.ok || !check.required), root, version: HINDWATCH_VERSION, checks: results };
}
