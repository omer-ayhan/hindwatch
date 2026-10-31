import assert from "node:assert/strict";
import { after } from "node:test";
import { Marks, RpcError } from "@hindwatch/core";
import { bareEnv, discardProject, eventually, feedApp, runCli } from "./helpers.js";
import { test } from "./timed.js";

const roots: string[] = [];

after(async () => {
  for (const root of roots) await discardProject(root);
});

test("marks are per client, move when set again, and resolve to an arrival-order window", () => {
  const marks = new Marks();
  marks.set("agent-a", "repro", 10);
  marks.set("agent-b", "repro", 99);
  marks.set("agent-a", "fix", 20);
  assert.deepEqual(marks.resolve("agent-a", { sinceMark: "repro", untilMark: "fix", app: "x" }), {
    sinceId: 10,
    untilId: 20,
    app: "x",
  });
  assert.equal(marks.resolve("agent-b", { sinceMark: "repro" }).sinceId, 99);
  marks.set("agent-a", "repro", 15);
  assert.deepEqual(marks.list("agent-a").map((m) => [m.name, m.id]), [["repro", 15], ["fix", 20]]);
  assert.throws(() => marks.resolve("agent-b", { sinceMark: "fix" }), RpcError);
  assert.throws(() => marks.set("agent-a", "1", 1), /start with a letter/);
});

test("logs --since and --until take this client's marks; --source takes a comma list", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  const logs = async (...args: string[]) => JSON.parse((await runCli(root, ["logs", ...args])).stdout);
  await append({ msg: "before" });
  await eventually(async () => (await logs()).events.length === 1, "the first line");
  assert.equal((await runCli(root, ["mark", "repro"])).code, 0);
  await append({ msg: "during" }, { msg: "during, other source", source: "other" });
  await eventually(async () => (await logs()).events.length === 3, "the repro lines");
  await runCli(root, ["mark", "fix"]);
  await append({ msg: "after" });
  await eventually(async () => (await logs()).events.length === 4, "the last line");

  const msgs = async (...args: string[]) => (await logs(...args)).events.map((e: { msg: string }) => e.msg);
  assert.deepEqual(await msgs("--since", "repro", "--until", "fix"), ["during", "during, other source"]);
  assert.deepEqual(await msgs("--since", "fix"), ["after"]);
  assert.deepEqual(await msgs("--since", "repro", "--source", "other"), ["during, other source"]);
  assert.equal((await msgs("--source", "feed,other")).length, 4);
  const [first] = (await logs()).events;
  assert.deepEqual(await msgs("--until", new Date(first.ts).toISOString()), ["before"]);

  const other = await runCli(root, ["logs", "--since", "repro"], "another-agent");
  assert.equal(other.code, 1);
  assert.match(JSON.parse(other.stdout).error, /no mark repro for client another-agent/);
  assert.equal((await runCli(root, ["logs", "--since", "2026-13-45"])).code, 2);
});

test("with no client or session variable, separate processes share the root's default client", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  const bare = { env: bareEnv() };
  await append({ msg: "before" });
  assert.equal((await runCli(root, ["start"], bare)).code, 0);
  await eventually(async () => JSON.parse((await runCli(root, ["logs"], bare)).stdout).events.length === 1, "the first line");
  assert.equal((await runCli(root, ["mark", "before"], bare)).code, 0);
  await append({ msg: "after" });
  await eventually(async () => {
    const read = await runCli(root, ["logs", "--since", "before"], bare);
    assert.equal(read.code, 0, read.stdout);
    return JSON.parse(read.stdout).events.length === 1;
  }, "the line after the mark, read by another process");
  // HINDWATCH_CLIENT and terminal sessions still keep their own marks.
  assert.equal((await runCli(root, ["logs", "--since", "before"], "someone-else")).code, 1);
  const session = await runCli(root, ["logs", "--since", "before"], { env: { ...bareEnv(), TERM_SESSION_ID: "w0t0p0" } });
  assert.match(session.stdout, /no mark before for client w0t0p0/);
});
