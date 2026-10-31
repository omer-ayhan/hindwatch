import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after } from "node:test";
import { Clocks, compactQueryPage, EventBuffer, INVALID_PATH, Ingest, Redactor, streamExport, type DebugEvent } from "@hindwatch/core";
import { CLI, discardProject, eventually, feedApp, runCli } from "./helpers.js";
import { test } from "./timed.js";

const roots: string[] = [];

after(async () => {
  for (const root of roots) await discardProject(root);
});

const EVENT_KEYS = ["schemaVersion", "id", "ts", "deviceTs", "hostTs", "estimated", "source", "deviceId", "app", "sessionId", "pid", "level", "msg", "attrs"];

function timeline(maxEvents: number) {
  const buffer = new EventBuffer({ maxEvents, maxEventsPerSource: maxEvents, maxAgeMs: 3_600_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const add = (count: number) => {
    for (let i = 0; i < count; i++) ingest.ingest({ source: "s", deviceId: "d", app: "a", level: "info", msg: `line ${buffer.lastId + 1}` });
  };
  return { buffer, add };
}

const parse = (text: string) => text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

/** After EVENT_KEYS checks, JSONL event rows are full DebugEvents (export keeps the on-disk schema). */
function asDebugEvents(rows: readonly Record<string, unknown>[]): DebugEvent[] {
  for (const event of rows) {
    assert.deepEqual(Object.keys(event), EVENT_KEYS);
    assert.equal(event.schemaVersion, 1);
  }
  return rows as unknown as DebugEvent[];
}

test("a bounded export streams the window, then an end line, and ignores later events", async () => {
  const { buffer, add } = timeline(100);
  add(10);
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const ended = streamExport(out, buffer, { sinceId: 3 }, false);
  add(5);
  assert.deepEqual(await ended, { reason: "done", events: 7, gaps: 0 });
  const lines = parse(chunks.join(""));
  assert.deepEqual(lines.slice(0, -1).map((e) => e.id), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(lines.at(-1), { end: { events: 7, gaps: 0 } });
});

test("a follow export never blocks on a slow reader: what it missed meanwhile is a gap line", async () => {
  const { buffer, add } = timeline(10);
  add(5);
  const written: string[] = [];
  let release: (() => void) | undefined;
  // Holds every write until the test releases it, like a reader that stopped reading.
  const slow = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      release = done;
    },
  });
  const ended = streamExport(slow, buffer, {}, true);
  assert.equal(written.length, 1, "the first batch is written, and the socket is full");
  add(50);
  assert.equal(buffer.size, 10, "the buffer kept evicting while the reader was stuck");
  release!();
  await eventually(() => written.join("").includes('"id":55'), "the export to catch up");
  const lines = parse(written.join(""));
  assert.deepEqual(lines.slice(0, 5).map((e) => e.id), [1, 2, 3, 4, 5]);
  const gap = lines[5]!.gap as Record<string, unknown>;
  assert.deepEqual([gap.reason, gap.fromId, gap.toId], ["behind", 6, 45]);
  assert.deepEqual(lines.slice(6).map((e) => e.id), Array.from({ length: 10 }, (_, i) => 46 + i));
  slow.destroy();
  assert.deepEqual(await ended, { reason: "closed", events: 15, gaps: 1 });
});

test("done when: an export between two marks round-trips with the schema intact, redacted, owner-only", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  const logs = async (...args: string[]) => JSON.parse((await runCli(root, ["logs", ...args])).stdout).events as Record<string, unknown>[];
  await append({ msg: "before" });
  await eventually(async () => (await logs()).length === 1, "the first line");
  await runCli(root, ["mark", "repro"]);
  await append(
    { pid: 7, level: "warn", msg: "login with Authorization: Bearer abc.def.ghi", attrs: { screen: "Login" } },
    { pid: 7, level: "error", msg: "TypeError: x is undefined\n    at onPress (App.tsx:3:1)" },
  );
  await eventually(async () => (await logs()).length === 3, "the repro lines");
  await runCli(root, ["mark", "fix"]);
  await append({ msg: "after" });
  await eventually(async () => (await logs()).length === 4, "the last line");

  const out = join(root, "repro.jsonl");
  const run = await runCli(root, ["export", "--since", "repro", "--until", "fix", "--out", out]);
  assert.equal(run.code, 0, run.stdout);
  assert.equal(run.stderr, "", "no gap, no warning");
  assert.deepEqual(JSON.parse(run.stdout), { out, format: "jsonl", events: 2, gaps: 0, end: "done" });
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  const exported = asDebugEvents(parse(await readFile(out, "utf8")));
  // Export keeps the full on-disk schema; logs returns the compact agent view of the same window.
  const logged = await logs("--since", "repro", "--until", "fix");
  assert.deepEqual(logged, compactQueryPage(exported).events);
  assert.equal(exported[0]!.msg, "login with Authorization: Bearer [REDACTED:bearer]");

  const text = join(root, "repro.txt");
  assert.equal((await runCli(root, ["export", "--since", "repro", "--until", "fix", "--out", text, "--format", "text"])).code, 0);
  const lines = (await readFile(text, "utf8")).trimEnd().split("\n");
  assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z feed WARN com\.hindwatch\.feed\[7\] login with Authorization: Bearer \[REDACTED:bearer\]$/);
  assert.match(lines[1]!, / feed ERROR com\.hindwatch\.feed\[7\] TypeError: x is undefined$/);
  assert.equal(lines[2], "\t    at onPress (App.tsx:3:1)");
  assert.equal((await runCli(root, ["export", "--out", text, "--format", "csv"])).code, 2);
  assert.equal((await runCli(root, ["export", "--follow", "--until", "fix", "--out", text])).code, 2);
});

test("export refuses a symlink at the target, dangling or not, and writes nothing through it", async () => {
  const { root } = await feedApp();
  roots.push(root);
  const victim = join(root, "victim.txt");
  await writeFile(victim, "keep");
  const link = join(root, "out.jsonl");
  await symlink(victim, link);
  const run = await runCli(root, ["export", "--out", link]);
  assert.equal(run.code, 1);
  assert.match(JSON.parse(run.stdout).error, /refusing to export to .*out\.jsonl: it is a symlink/);
  assert.equal(JSON.parse(run.stdout).code, INVALID_PATH);
  assert.equal(await readFile(victim, "utf8"), "keep");

  const dangling = join(root, "dangling.jsonl");
  const missing = join(root, "missing.txt");
  await symlink(missing, dangling);
  assert.equal((await runCli(root, ["export", "--out", dangling])).code, 1);
  await assert.rejects(stat(missing), { code: "ENOENT" });
  assert.ok((await lstat(dangling)).isSymbolicLink());
});

test("done when: an export reports a gap after eviction, as its first line and a warning", async () => {
  const { root, append } = await feedApp({ logTimeSpan: 2_000 });
  roots.push(root);
  await runCli(root, ["start"]);
  const held = async () => JSON.parse((await runCli(root, ["status"])).stdout).events;
  await append(...Array.from({ length: 5 }, (_, i) => ({ msg: `line ${i + 1}` })));
  await eventually(async () => (await held()) === 5, "the lines to arrive");
  await eventually(async () => (await held()) === 0, "the lines to expire", 10_000);
  await append(...Array.from({ length: 3 }, (_, i) => ({ msg: `line ${i + 6}` })));
  await eventually(async () => (await held()) === 3, "the new lines to arrive");
  const out = join(root, "all.jsonl");
  const run = await runCli(root, ["export", "--out", out]);
  assert.equal(run.code, 0);
  assert.match(run.stderr, /^hindwatch: warning: gap: events 1-5 were evicted from the buffer before the export reached them/);
  assert.equal(JSON.parse(run.stdout).gaps, 1);
  const [gap, ...events] = parse(await readFile(out, "utf8"));
  assert.deepEqual(Object.keys(gap!), ["gap"]);
  assert.deepEqual([(gap!.gap as { fromId: number }).fromId, (gap!.gap as { toId: number }).toId], [1, 5]);
  assert.deepEqual(events.map((e) => e.msg), ["line 6", "line 7", "line 8"]);
});

test("export --follow keeps appending until Ctrl-C, then ends cleanly", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  await runCli(root, ["start"]);
  await runCli(root, ["mark", "start"]);
  const out = join(root, "follow.jsonl");
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "export", "--follow", "--since", "start", "--out", out, "--root", root], {
    env: { ...process.env, HINDWATCH_CLIENT: "cli-test" },
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const lines = async () => (await readFile(out, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").length;
  await append({ msg: "one" });
  await eventually(async () => (await lines()) === 1, "the first line in the file");
  assert.equal(JSON.parse((await runCli(root, ["status"])).stdout).attachedClients, 1, "a follow export counts as attached");
  await append({ msg: "two" }, { msg: "three" });
  await eventually(async () => (await lines()) === 3, "the later lines in the file");
  child.kill("SIGINT");
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(stdout), { out, format: "jsonl", events: 3, gaps: 0, end: "interrupted" });
  await eventually(async () => JSON.parse((await runCli(root, ["status"])).stdout).attachedClients === 0, "the daemon to let it go");
});
