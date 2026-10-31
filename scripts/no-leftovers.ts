/**
 * Runs a command against a fresh runtime folder of its own (HINDWATCH_RUNTIME_DIR), then fails if
 * it left any process of ours behind (a daemon, a supervisor, or a `log stream` / `adb logcat`),
 * anything in that folder but daemon logs, or hindwatch-* entries in the temp dir. The folder is
 * read as the command left it, then deleted. Processes and temp entries that were already there
 * are not counted. Leftover processes, such as a hung test's daemon, are reported and then killed.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesAddedSince, ourFiles } from "./files.js";
import { killLeftovers, leftoversSince, ourProcesses } from "./processes.js";

/** One log per root, its single rotation and the last start's stderr are all a stopped daemon keeps. */
const KEPT = /^[0-9a-f]{16}\.(log(\.1)?|stderr)$/;

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: no-leftovers <command> [args...]");
  process.exit(2);
}
const runtime = await mkdtemp(join(tmpdir(), "hindwatch-run-"));
process.env.HINDWATCH_RUNTIME_DIR = runtime;
const before = await ourProcesses();
const filesBefore = await ourFiles();
const code = await new Promise<number>((resolve) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", () => resolve(127));
  child.on("close", (status) => resolve(status ?? 1));
});
const left = await leftoversSince(before);
if (left.length > 0) {
  console.error(`leftover processes (${left.length}), now killed:\n${left.join("\n")}`);
  const stubborn = await killLeftovers(before, left);
  if (stubborn.length > 0) console.error(`needed SIGKILL after SIGTERM (${stubborn.length}):\n${stubborn.join("\n")}`);
}
const kept = (await readdir(runtime)).filter((name) => KEPT.test(name));
const added = (await filesAddedSince(filesBefore)).filter((path) => !kept.some((name) => path === join(runtime, name)));
await rm(runtime, { recursive: true, force: true });
if (added.length > 0) console.error(`leftover files (${added.length}):\n${added.join("\n")}`);
if (left.length === 0 && added.length === 0) console.error(`no leftover processes or files (${kept.length} daemon log and stderr file(s) kept)`);
process.exitCode = left.length > 0 || added.length > 0 ? 1 : code;
