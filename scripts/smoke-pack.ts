/**
 * Packs the `hindwatch` package, installs the tarball into a temp project outside the repo and
 * runs it through npx: --help, doctor (failing, then passing), a daemon that loads the bundled
 * react-native plugin and examples/crash-detector importing from `hindwatch`, and mcp over stdio
 * until EOF. The project also imports the plugin contract, values and types, from the tarball. Devices are stubbed: adb and xcrun come from
 * the doctor test stubs, the adb server port is a closed one, and Metro is a fake on a free port.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { daemonPaths } from "@hindwatch/core";

const repo = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const stubs = join(repo, "packages/core/test/bin-doctor");
const CONTRACT = ["Source", "SourceContext", "Enricher", "EventPatch", "Detector", "Incident", "PluginManifest", "PluginFactory", "RawEvent", "DebugEvent", "RedactedEvent", "ClockSample"];

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: (write: (line: string) => void, end: () => void, stdout: () => string) => void }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.input === undefined) child.stdin.end();
    else options.input((line) => child.stdin.write(`${line}\n`), () => child.stdin.end(), () => stdout);
  });
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const failures: string[] = [];
function expect(what: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}`);
  if (!ok) failures.push(what);
}

const temp = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-smoke-")));
let metro: Server | undefined;
let started = false;
let daemonPid: number | undefined;
const app = join(temp, "app");
const metroPort = await freePort();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${stubs}${delimiter}${process.env.PATH ?? ""}`,
  DOCTOR_LOG: join(temp, "stubs.log"),
  ANDROID_ADB_SERVER_PORT: String(await freePort()),
  ADB_SERVER_SOCKET: undefined,
  HINDWATCH_CLIENT: "smoke",
};
const npx = (args: readonly string[], input?: Parameters<typeof run>[2]["input"]) => run("npx", ["--no-install", "hindwatch", ...args], { cwd: app, env, input });

try {
  expect("temp dir is outside the repo", !temp.startsWith(`${repo}/`), temp);
  const packed = await run("npm", ["pack", "-w", "hindwatch", "--pack-destination", temp, "--json"], { cwd: repo });
  const info = (JSON.parse(packed.stdout) as { filename: string; size: number; unpackedSize: number; entryCount: number }[])[0]!;
  expect("npm pack", packed.code === 0, `${info.filename}, ${info.size} B packed, ${info.unpackedSize} B unpacked, ${info.entryCount} files`);

  await run("mkdir", [app], { cwd: temp });
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true }));
  await writeFile(
    join(app, "hindwatch.config.json"),
    JSON.stringify({ plugins: [{ module: "@hindwatch/plugin-react-native", options: { port: metroPort } }, { module: "./tools/crash-detector.js" }] }),
  );
  await mkdir(join(app, "tools"));
  await copyFile(join(repo, "examples/crash-detector/index.js"), join(app, "tools/crash-detector.js"));
  const installed = await run("npm", ["install", "--no-audit", "--no-fund", join(temp, info.filename)], { cwd: app });
  expect("npm install of the tarball", installed.code === 0, installed.stdout.trim().split("\n").at(-1) ?? "");

  const values = await run(process.execPath, ["--input-type=module", "-e", 'import * as api from "hindwatch"; console.log(JSON.stringify(api))'], { cwd: app });
  expect("the project imports the contract's only value from hindwatch", values.code === 0 && values.stdout.trim() === '{"PLUGIN_API_VERSION":"0.1"}', values.stdout.trim() || values.stderr.trim());
  await writeFile(
    join(app, "check.ts"),
    [
      `import { PLUGIN_API_VERSION, type ${CONTRACT.join(", type ")} } from "hindwatch";`,
      `export type Contract = [${CONTRACT.join(", ")}];`,
      `export const version: "0.1" = PLUGIN_API_VERSION;`,
      "// @ts-expect-error internals are not exported",
      `import type { EventBuffer } from "hindwatch";`,
      "",
    ].join("\n"),
  );
  const tsc = join(repo, "node_modules/typescript/bin/tsc");
  const types = await run(
    process.execPath,
    [tsc, "--noEmit", "--strict", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--typeRoots", join(repo, "node_modules/@types"), "--types", "node", "check.ts"],
    { cwd: app },
  );
  expect("the project typechecks against the contract's types from hindwatch", types.code === 0, types.code === 0 ? `${CONTRACT.length} types` : types.stdout.trim());

  const help = await npx(["--help"]);
  expect("npx hindwatch --help exits 0", help.code === 0, `${help.stdout.split("\n").length} lines`);
  expect("--help has the MCP setup", help.stdout.includes("npx -y hindwatch mcp"));

  const summary = (out: string) =>
    (JSON.parse(out) as { ok: boolean; checks: { name: string; ok: boolean; required: boolean }[] }).checks
      .map((check) => `${check.name}=${check.ok ? "ok" : check.required ? "FAIL" : "warn"}`)
      .join(" ");
  const down = await npx(["doctor"]);
  expect("doctor with Metro down exits 1", down.code === 1, summary(down.stdout));

  metro = createServer((request, response) => {
    if (request.url === "/status") response.end("packager-status:running");
    else if (request.url === "/json/list") response.end("[]");
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => metro!.listen(metroPort, "127.0.0.1", resolve));
  const up = await npx(["doctor"]);
  expect("doctor with Metro up exits 0", up.code === 0, summary(up.stdout));

  const start = await npx(["start"]);
  started = start.code === 0;
  const status = await npx(["status"]);
  daemonPid = (JSON.parse(status.stdout) as { pid?: number }).pid;
  expect("start exits 0", start.code === 0);
  console.log(status.stdout.trim());
  expect("the daemon loaded the bundled react-native plugin and the crash detector", status.code === 0 && status.stdout.includes('"plugins":["react-native","crash-detector"]'));
  const stop = await npx(["stop"]);
  started = stop.code !== 0;
  expect("stop exits 0", stop.code === 0);

  let mcpLines: string[] = [];
  const mcp = await npx(["mcp"], (write, end, stdout) => {
    write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }));
    write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const poll = setInterval(() => {
      if (stdout().split("\n").filter((line) => line.trim() !== "").length >= 2) {
        clearInterval(poll);
        end();
      }
    }, 20);
  });
  mcpLines = mcp.stdout.split("\n").filter((line) => line.trim() !== "");
  const messages = mcpLines.map((line) => {
    try {
      return JSON.parse(line) as { id?: number; result?: { serverInfo?: { name: string; version: string }; tools?: { name: string }[] } };
    } catch {
      return undefined;
    }
  });
  expect("mcp stdout is JSON-RPC only", messages.length > 0 && messages.every((message) => message !== undefined), `${mcpLines.length} lines`);
  const serverInfo = messages.find((message) => message?.id === 1)?.result?.serverInfo;
  const tools = messages.find((message) => message?.id === 2)?.result?.tools ?? [];
  expect("mcp initialize", serverInfo !== undefined, JSON.stringify(serverInfo));
  expect("mcp tools/list", tools.length > 0, `${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
  expect("mcp exits 0 on EOF", mcp.code === 0, mcp.stderr.trim() === "" ? "no stderr" : `stderr: ${mcp.stderr.trim().slice(0, 200)}`);
} finally {
  if (started) await npx(["stop", "--force"]);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let waited = 0; daemonPid !== undefined && alive(daemonPid) && waited < 5_000; waited += 50) await sleep(50);
  // stop keeps the daemon's log and child ledger for the next start; this project won't have one.
  await Promise.all(Object.values(daemonPaths(app)).map((path) => rm(path, { force: true })));
  await new Promise((resolve) => (metro === undefined ? resolve(undefined) : metro.close(resolve)));
  await rm(temp, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "smoke-pack: all ok" : `smoke-pack: ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
