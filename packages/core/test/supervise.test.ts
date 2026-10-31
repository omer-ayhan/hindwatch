import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { promisify } from "node:util";
import { call, CONFIG_FILE, daemonPaths, status } from "@hindwatch/core";
import { alive, CLI, discardProject, eventually, processesMatching } from "./helpers.js";
import { test } from "./timed.js";

const run = promisify(execFile);
const FAKE_BIN = fileURLToPath(new URL("./bin", import.meta.url));
const HALF_STOPPED = fileURLToPath(new URL("./scripts/half-stopped.ts", import.meta.url));
type Mode = "busy" | "idle" | "exit-once";
interface Project {
  readonly root: string;
  readonly mode: Mode;
  /** In the fake child's command line, so ps finds every process that is ours. */
  readonly tag: string;
}
const projects: Project[] = [];

after(async () => {
  for (const { root, tag } of projects) {
    await call(root, "stop", { clientId: "cleanup", force: true }).catch(() => {});
    await eventually(async () => (await processesMatching(tag)).length === 0, `children of ${root} gone`).catch(() => {});
    await discardProject(root);
  }
});

/** A project whose only source is ios-sim, served by the fake xcrun. */
async function simProject(mode: Mode, extra: Record<string, unknown> = {}): Promise<Project> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-supervise-")));
  const tag = `FakeApp${process.pid}${Math.random().toString(36).slice(2)}`;
  const project = { root, mode, tag };
  projects.push(project);
  const config = { sources: { "ios-sim": { bundleId: "com.hindwatch.fake", process: tag, device: "FAKE-UDID" } }, ...extra };
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(config));
  return project;
}

async function cli({ root, mode }: Project, ...args: string[]) {
  const env = { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, FAKE_XCRUN_MODE: mode, FAKE_XCRUN_PIDS: join(root, "starts") };
  const { stdout } = await run(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, ...args, "--root", root], { env });
  return JSON.parse(stdout);
}

/** Each start of the fake child: its pid and its supervisor's. */
async function starts({ root }: Project): Promise<{ child: number; supervisor: number }[]> {
  const text = await readFile(join(root, "starts"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [child, supervisor] = l.split(" ").map(Number);
      return { child: child!, supervisor: supervisor! };
    });
}

async function daemonsOf({ root }: Project): Promise<string[]> {
  return (await processesMatching(`__daemon --root ${root}`)).filter((l) => !l.includes(" ps "));
}

async function messages(project: Project): Promise<string[]> {
  const result = await cli(project, "logs", "--budget", "100000");
  return result.events.map((e: { msg: string }) => e.msg);
}

async function killDaemonHard(project: Project): Promise<{ child: number; supervisor: number }> {
  const [first] = await starts(project);
  assert.ok(first, "the child started");
  const { pid } = await status(project.root);
  process.kill(pid, "SIGKILL");
  const killedAt = Date.now();
  await eventually(() => !alive(first.child) && !alive(first.supervisor), "the child and its supervisor gone");
  await eventually(async () => (await processesMatching(project.tag)).length === 0, "nothing of ours left");
  assert.ok(Date.now() - killedAt <= 5_000);
  return first;
}

/** After kill -9: any command works, leaves exactly one daemon, and the old child stays gone. */
async function recover(project: Project, first: { child: number; supervisor: number }): Promise<void> {
  const paths = daemonPaths(project.root);
  await access(paths.lock);
  await access(paths.socket);
  const listed = await cli(project, "incidents");
  assert.deepEqual(listed.incidents, []);
  assert.equal((await daemonsOf(project)).length, 1);
  await eventually(async () => (await starts(project)).length === 2, "the new daemon's child");
  const [, second] = await starts(project);
  assert.ok(alive(second!.child) && !alive(first.child));
  assert.equal((await status(project.root)).pid, Number((await readFile(paths.lock, "utf8")).trim()));
  const recorded = async (): Promise<number[]> =>
    JSON.parse(await readFile(paths.children, "utf8").catch(() => "[]")).map((entry: { pid: number }) => entry.pid);
  await eventually(async () => (await recorded()).length === 1, "the new child recorded");
  const pids = await recorded();
  assert.ok(!pids.includes(first.supervisor) && !pids.includes(first.child), "the dead daemon's entries swept");
}

test("kill -9 of the daemon while its child streams leaves no child within 5 s, and the next command takes over", async () => {
  const project = await simProject("busy");
  await eventually(async () => (await messages(project)).includes("tick"), "streamed lines");
  await recover(project, await killDaemonHard(project));
});

test("kill -9 of the daemon while its child is idle leaves no child within 5 s, and the next command takes over", async () => {
  const project = await simProject("idle");
  await eventually(async () => (await messages(project)).includes("attached"), "the child attached");
  await recover(project, await killDaemonHard(project));
});

test("a child that exits on its own leaves no supervisor behind, and the source reattaches", async () => {
  const project = await simProject("exit-once");
  await eventually(async () => (await messages(project)).includes("start 2"), "the reattached child", 10_000);
  const [first, second] = await starts(project);
  assert.ok(!alive(first!.child) && !alive(first!.supervisor));
  assert.ok(alive(second!.child) && alive(second!.supervisor));
  const daemonLog = await readFile(daemonPaths(project.root).log, "utf8");
  assert.match(daemonLog, /xcrun exited with code 1: simulator went away/);
  const stopped = await call(project.root, "stop", { clientId: "supervise-test" });
  assert.deepEqual(stopped, { stopping: true, bufferDropped: (stopped as { bufferDropped: number }).bufferDropped });
  await eventually(() => !alive(second!.child) && !alive(second!.supervisor), "the child gone after stop");
  const paths = daemonPaths(project.root);
  const kept = [paths.lock, paths.socket, paths.children];
  await eventually(async () => (await Promise.allSettled(kept.map((file) => access(file)))).every((r) => r.status === "rejected"), "no lock, socket or ledger after a graceful stop");
});

test("stop after kill -9 reclaims the dead daemon's lock, socket and ledger instead of starting one", async () => {
  const project = await simProject("idle");
  await eventually(async () => (await messages(project)).includes("attached"), "the child attached");
  await killDaemonHard(project);
  assert.deepEqual(await cli(project, "stop"), { stopping: false, running: false, cleared: ["lock", "socket"] });
  const paths = daemonPaths(project.root);
  for (const file of [paths.lock, paths.socket, paths.children]) await assert.rejects(access(file));
  assert.deepEqual(await daemonsOf(project), []);
});

test("kill -9 after the children stopped but before the hand-off file was deleted leaves it for the next start to sweep", async () => {
  const project = await simProject("idle");
  const paths = daemonPaths(project.root);
  const stopper = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), HALF_STOPPED, project.root, project.tag], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => stopper.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    stopper.stdout.setEncoding("utf8").on("data", (chunk: string) => chunk.includes("ready") && resolve());
    void exited.then(() => reject(new Error("half-stopped exited before it was ready")));
  });
  const handOff = `${paths.children}.${stopper.pid}.stopping`;
  try {
    await access(handOff);
    await assert.rejects(access(paths.children));
    assert.deepEqual(await processesMatching(`sleep 300 # ${project.tag}`), []);
  } finally {
    stopper.kill("SIGKILL");
  }
  await exited;
  await access(handOff);
  await cli(project, "start");
  await assert.rejects(access(handOff));
});

for (const how of ["exit", "idle shutdown"] as const) {
  test(`${how} takes the child down within 5 s and leaves no lock, socket or ledger`, async () => {
    const project = await simProject("busy", how === "exit" ? {} : { idleMs: 1_000 });
    await eventually(async () => (await messages(project)).includes("tick"), "streamed lines");
    const [first] = await starts(project);
    if (how === "exit") assert.equal((await cli(project, "exit")).stopping, true);
    await eventually(async () => (await daemonsOf(project)).length === 0, "the daemon gone");
    await eventually(() => !alive(first!.child) && !alive(first!.supervisor), "the child gone");
    assert.deepEqual(await processesMatching(project.tag), []);
    const paths = daemonPaths(project.root);
    for (const file of [paths.lock, paths.socket, paths.children]) await assert.rejects(access(file));
    const handOffs = (await readdir(dirname(paths.children))).filter((name) => name.startsWith(basename(paths.children)));
    assert.deepEqual(handOffs, []);
  });
}
