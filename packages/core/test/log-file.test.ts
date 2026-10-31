import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { CappedLog, MAX_LOG_BYTES, pruneStaleLogs, rotateIfFull, STALE_LOG_MS } from "@hindwatch/core";
import { test } from "./timed.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hindwatch-log-"));
  dirs.push(dir);
  return dir;
}

test("the daemon log is capped at 1 MB", () => {
  assert.equal(MAX_LOG_BYTES, 1024 * 1024);
});

test("a capped log keeps one rotation, each file under the cap, the newest lines in the log itself", async () => {
  const dir = await scratch();
  const path = join(dir, "a.log");
  const log = new CappedLog(path, 100);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")}\n`);
  for (const line of lines) log.write(line);
  log.close();
  assert.deepEqual((await readdir(dir)).sort(), ["a.log", "a.log.1"]);
  for (const file of ["a.log", "a.log.1"]) assert.ok((await stat(join(dir, file))).size <= 100, `${file} over the cap`);
  const current = await readFile(path, "utf8");
  const previous = await readFile(`${path}.1`, "utf8");
  assert.ok(current.endsWith(lines.at(-1)!));
  assert.ok(lines.join("").endsWith(previous + current), "whole lines, in order, nothing in between lost");
});

test("a capped log follows a rotation someone else made instead of writing into the old file", async () => {
  const dir = await scratch();
  const path = join(dir, "a.log");
  const log = new CappedLog(path, 1_000);
  log.write("before\n");
  rotateIfFull(path, 1);
  log.write("after\n");
  log.close();
  assert.equal(await readFile(`${path}.1`, "utf8"), "before\n");
  assert.equal(await readFile(path, "utf8"), "after\n");
});

test("a daemon start rotates a full log once and leaves a smaller one or none alone", async () => {
  const dir = await scratch();
  const path = join(dir, "a.log");
  rotateIfFull(path, 10);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path, "short\n");
  rotateIfFull(path, 10);
  assert.deepEqual(await readdir(dir), ["a.log"]);
  await writeFile(`${path}.1`, "oldest\n");
  await writeFile(path, "full enough\n");
  rotateIfFull(path, 10);
  assert.deepEqual((await readdir(dir)).sort(), ["a.log.1"]);
  assert.equal(await readFile(`${path}.1`, "utf8"), "full enough\n");
});

test("pruning removes old logs of roots with no lock or socket, and keeps live and recent ones", async () => {
  const dir = await scratch();
  const old = Date.now() - STALE_LOG_MS - 1000;
  const files = ["aaaa.log", "aaaa.log.1", "aaaa.stderr", "bbbb.log", "bbbb.lock", "cccc1234.log", "cccc.sock", "dddd.log", "eeee.log", "notes.txt"];
  for (const name of files) await writeFile(join(dir, name), "x");
  for (const name of files.filter((name) => name !== "dddd.log")) await utimes(join(dir, name), old / 1000, old / 1000);

  const removed = await pruneStaleLogs(dir);
  assert.deepEqual(removed.sort(), ["aaaa.log", "aaaa.log.1", "aaaa.stderr", "eeee.log"]);
  assert.deepEqual((await readdir(dir)).sort(), ["bbbb.lock", "bbbb.log", "cccc.sock", "cccc1234.log", "dddd.log", "notes.txt"]);
});
