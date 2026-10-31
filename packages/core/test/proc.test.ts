import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { ChildLedger, supervisedRunner } from "@hindwatch/core";
import { alive, eventually, processesMatching } from "./helpers.js";
import { test } from "./timed.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hindwatch-proc-"));
  dirs.push(dir);
  return dir;
}

const exists = (path: string) => access(path).then(() => true, () => false);

const marker = () => `hindwatch-proc-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

test("a streamed child's stdout reaches the daemon, its stderr and exit code explain a failure, and nothing stays behind", async () => {
  const tag = marker();
  const lines: string[] = [];
  const script = `echo one; echo two; echo "it broke" >&2; exit 3 # ${tag}`;
  await assert.rejects(
    supervisedRunner().stream("/bin/sh", ["-c", script], (line) => lines.push(line), new AbortController().signal),
    /\/bin\/sh exited with code 3: it broke/,
  );
  assert.deepEqual(lines, ["one", "two"]);
  await eventually(async () => (await processesMatching(tag)).length === 0, "no supervisor left");
  assert.equal(await supervisedRunner().run("/bin/sh", ["-c", `echo ok # ${tag}`]), "ok\n");
});

test("aborting a stream kills the child's whole process group", async () => {
  const tag = marker();
  const abort = new AbortController();
  const streaming = supervisedRunner().stream("/bin/sh", ["-c", `echo up; sleep 300 & wait # ${tag}`], () => abort.abort(), abort.signal);
  await streaming;
  await eventually(async () => (await processesMatching(tag)).length === 0, "the child and its own children gone");
});

test("a read whose consumer throws rejects with that error and kills the child's group", async () => {
  const tag = marker();
  const reading = supervisedRunner().read("/bin/sh", ["-c", `echo up; sleep 300 & wait # ${tag}`], () => {
    throw new Error("not binary entries");
  }, new AbortController().signal);
  await assert.rejects(reading, /not binary entries/);
  await eventually(async () => (await processesMatching(tag)).length === 0, "the child and its own children gone");
});

test("a byte run returns stdout exactly as written, NUL and invalid UTF-8 included", async () => {
  const bytes = await supervisedRunner().runBytes("/usr/bin/printf", ["a\\000\\377\\r\\nb"]);
  assert.deepEqual([...bytes], [0x61, 0x00, 0xff, 0x0d, 0x0a, 0x62]);
});

test("the ledger records a running stream and forgets it when the stream ends", async () => {
  const file = join(await scratch(), "children.json");
  const ledger = new ChildLedger(file);
  const abort = new AbortController();
  let up!: () => void;
  const started = new Promise<void>((resolve) => (up = resolve));
  const streaming = supervisedRunner(ledger).stream("/bin/sh", ["-c", `echo up; exec sleep 300 # ${marker()}`], () => up(), abort.signal);
  await started;
  await eventually(async () => JSON.parse(await readFile(file, "utf8").catch(() => "[]")).length === 1, "the entry");
  const [entry] = JSON.parse(await readFile(file, "utf8"));
  assert.match(entry.identity, /hindwatch-child/);
  abort.abort();
  await streaming;
  await eventually(async () => !(await exists(file)), "the entry removed, and with the last one the file");
});

test("an aborted stream whose children miss SIGTERM still ends, by SIGKILL to the group", async () => {
  const tag = marker();
  const abort = new AbortController();
  // Ignoring TERM stands in for a child forked just as the signal reached the group.
  const command = `trap '' TERM; echo up; sleep 300 & wait # ${tag}`;
  await supervisedRunner().stream("/bin/sh", ["-c", command], () => abort.abort(), abort.signal);
  await eventually(async () => (await processesMatching(tag)).length === 0, "the group gone within 5 s");
});

/** A detached group like a supervisor's: a leader with a child of its own. */
function orphanGroup(tag: string) {
  const leader = spawn("/bin/sh", ["-c", `sleep 300 & wait # ${tag}`], { detached: true, stdio: "ignore" });
  leader.unref();
  return leader.pid!;
}

test("a sweep kills a recorded group whose leader is still ours, and the group of a dead leader", async () => {
  const file = join(await scratch(), "children.json");
  const tags = [marker(), marker()];
  const ledger = new ChildLedger(file);
  const pids = tags.map(orphanGroup);
  for (const pid of pids) await ledger.add(pid);
  // The second leader dies alone, leaving its sleep running in the group.
  process.kill(pids[1]!, "SIGKILL");
  await eventually(() => !alive(pids[1]!), "the leader gone");
  const logs: string[] = [];
  await new ChildLedger(file).sweep((m) => logs.push(m));
  for (const tag of tags) await eventually(async () => (await processesMatching(tag)).length === 0, `group ${tag} gone`);
  assert.equal(logs.length, 2);
  assert.equal(await exists(file), false);
});

test("a sweep never kills a process that only reuses a recorded pid", async () => {
  const file = join(await scratch(), "children.json");
  const tag = marker();
  const pid = orphanGroup(tag);
  try {
    await writeFile(file, JSON.stringify([{ pid, identity: "Mon Jan  1 00:00:00 2024 /bin/sh -c something else" }]));
    await new ChildLedger(file).sweep(() => {});
    assert.ok(alive(pid));
    assert.equal(await exists(file), false);
  } finally {
    process.kill(-pid, "SIGKILL");
  }
});

test("a sweep kills the groups in a dead daemon's hand-off file and deletes it", async () => {
  const dir = await scratch();
  const file = join(dir, "children.json");
  const exited = spawn("true");
  await new Promise((resolve) => exited.on("exit", resolve));
  const tag = marker();
  await new ChildLedger(file).add(orphanGroup(tag));
  await rename(file, `${file}.${exited.pid}.stopping`);
  const logs: string[] = [];
  await new ChildLedger(file).sweep((m) => logs.push(m));
  await eventually(async () => (await processesMatching(tag)).length === 0, "the group gone");
  assert.equal(logs.length, 1);
  assert.deepEqual(await readdir(dir), []);
});

test("a sweep deletes ledger writes whose writer died, and keeps a live writer's and other files", async () => {
  const dir = await scratch();
  const file = join(dir, "children.json");
  const exited = spawn("true");
  await new Promise((resolve) => exited.on("exit", resolve));
  const running = spawn("sleep", ["30"]);
  try {
    const live = [`children.json.${running.pid}.tmp`, `children.json.${running.pid}.stopping`];
    await Promise.all([`children.json.${exited.pid}.tmp`, ...live, "children.json.notes"].map((name) => writeFile(join(dir, name), "")));
    await new ChildLedger(file).sweep(() => {});
    assert.deepEqual((await readdir(dir)).sort(), ["children.json.notes", ...live].sort());
  } finally {
    running.kill("SIGKILL");
  }
});

test("a hand-off moves the ledger to this process's file and writes the ledger no more; the drain deletes it once the group is gone", async () => {
  const file = join(await scratch(), "children.json");
  const handOff = `${file}.${process.pid}.stopping`;
  const ledger = new ChildLedger(file);
  const tag = marker();
  const pid = orphanGroup(tag);
  try {
    await ledger.add(pid);
    await ledger.handOff();
    assert.equal(await exists(file), false);
    assert.deepEqual(JSON.parse(await readFile(handOff, "utf8")).map((entry: { pid: number }) => entry.pid), [pid]);
    await assert.rejects(ledger.add(process.pid), /the daemon is stopping/);
    await ledger.remove(pid);
    assert.equal(await exists(file), false);
    // The leader goes first and its sleep stays in the group, so the drain must not stop at the leader.
    process.kill(pid, "SIGKILL");
    const drained = ledger.drain();
    await eventually(() => !alive(pid), "the leader gone");
    assert.equal(await exists(handOff), true);
    process.kill(-pid, "SIGTERM");
    await drained;
    assert.equal(await exists(handOff), false);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

test("a drain kills a group that outlives the grace period, then deletes the hand-off file", async () => {
  const file = join(await scratch(), "children.json");
  const ledger = new ChildLedger(file);
  const tag = marker();
  await ledger.add(orphanGroup(tag));
  await ledger.handOff();
  await ledger.drain();
  assert.deepEqual(await processesMatching(tag), []);
  assert.equal(await exists(`${file}.${process.pid}.stopping`), false);
});

test("once a stop has begun the runner starts no child, and a stream started just before it is in the hand-off file", async () => {
  const dir = await scratch();
  const file = join(dir, "children.json");
  const ledger = new ChildLedger(file);
  const runner = supervisedRunner(ledger);
  const abort = new AbortController();
  const tag = marker();
  const streaming = runner.stream("/bin/sh", ["-c", `exec sleep 300 # ${tag}`], () => {}, abort.signal);
  try {
    await ledger.handOff();
    const [entry] = JSON.parse(await readFile(`${file}.${process.pid}.stopping`, "utf8"));
    assert.match(entry.identity, new RegExp(tag));

    const late = join(dir, "late");
    await assert.rejects(runner.stream("/bin/sh", ["-c", `touch ${late}`], () => {}, new AbortController().signal), /not starting \/bin\/sh: the daemon is stopping/);
    await assert.rejects(runner.run("/bin/sh", ["-c", `touch ${late}`]), /not starting \/bin\/sh: the daemon is stopping/);
    assert.equal(await exists(late), false);
  } finally {
    abort.abort();
    await streaming;
  }
  await ledger.drain();
  assert.deepEqual(await processesMatching(tag), []);
  assert.equal(await exists(`${file}.${process.pid}.stopping`), false);
});
