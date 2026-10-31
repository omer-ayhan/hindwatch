import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { call, Clocks, ensureDaemon, mayLandInWindow, DaemonExitedError, daemonPaths, resolveRoot, runtimeDir, EventBuffer, expectEvents, Ingest, Redactor, SCHEMA_VERSION, waitFor, type DebugEvent, type MuteFilter } from "@hindwatch/core";
import { discardProject, eventually, FEED_PLUGIN, feedApp, runCli } from "./helpers.js";
import { test } from "./timed.js";

const roots: string[] = [];

after(async () => {
  for (const root of roots) await discardProject(root);
});

function timeline(maxEvents = 100) {
  const buffer = new EventBuffer({ maxEvents, maxEventsPerSource: maxEvents, maxAgeMs: 3_600_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const add = (msg: string) => ingest.ingest({ source: "s", deviceId: "d", app: "a", level: "info", msg });
  return { buffer, add };
}

test("wait-for sees only what arrives next, unless a since bound reaches back", async () => {
  const { buffer, add } = timeline();
  add("ready");
  const never = new AbortController().signal;
  const next = waitFor(buffer, { text: "ready" }, 60_000, never);
  add("noise");
  add("ready again");
  assert.equal((await next)?.msg, "ready again");
  assert.equal((await waitFor(buffer, { sinceId: 0, text: "ready" }, 60_000, never))?.msg, "ready");
});

test("wait-for skips muted events unless includeMuted", async () => {
  const { buffer, add } = timeline();
  const never = new AbortController().signal;
  const isMuted: MuteFilter = (e) => e.msg.startsWith("noise");
  const waiting = waitFor(buffer, { text: "noise" }, 60_000, never, isMuted);
  add("noise hush");
  add("noise hush again");
  add("ready signal");
  // Without includeMuted, muted matches are invisible — times out unless something unmuted arrives.
  const include = waitFor(buffer, { sinceId: 0, text: "noise", includeMuted: true }, 60_000, never, isMuted);
  assert.equal((await include)?.msg, "noise hush");
  const unmuted = waitFor(buffer, { sinceId: 0, text: "ready" }, 60_000, never, isMuted);
  assert.equal((await unmuted)?.msg, "ready signal");
  // The muted-only wait must not have resolved on the muted pushes.
  const raced = await Promise.race([
    waiting.then((event) => ({ kind: "matched" as const, event })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 20)),
  ]);
  assert.equal(raced.kind, "pending", "muted-only wait_for must not resolve");
});

test("wait-for --include-muted sees drop-at-ingest side-buffer, not the main ring", async () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 3_600_000 });
  const mutedBuffer = new EventBuffer({ maxEvents: 50, maxEventsPerSource: 50, maxAgeMs: 3_600_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const never = new AbortController().signal;
  const isMuted: MuteFilter = (e) => e.msg.startsWith("noise");
  // Simulate host drop-at-ingest: muted goes to side ring only.
  const dropMuted = (msg: string) => {
    const prepared = ingest.prepare({
      source: "s",
      deviceId: "d",
      app: "a",
      level: "info",
      msg,
    });
    if (isMuted(prepared)) {
      mutedBuffer.push(ingest.assignId(prepared));
      return;
    }
    ingest.commit(prepared);
  };
  const waiting = waitFor(buffer, { text: "noise" }, 60_000, never, isMuted, mutedBuffer);
  const include = waitFor(
    buffer,
    { sinceId: 0, text: "noise", includeMuted: true },
    60_000,
    never,
    isMuted,
    mutedBuffer,
  );
  dropMuted("noise hush");
  dropMuted("ready signal");
  assert.equal(buffer.size, 1);
  assert.equal(mutedBuffer.size, 1);
  assert.equal((await include)?.msg, "noise hush");
  assert.equal(
    (await waitFor(buffer, { sinceId: 0, text: "ready" }, 60_000, never, isMuted, mutedBuffer))?.msg,
    "ready signal",
  );
  const raced = await Promise.race([
    waiting.then((event) => ({ kind: "matched" as const, event })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 20)),
  ]);
  assert.equal(raced.kind, "pending", "without includeMuted, side-buffer muted must not match");
});

test("expect --include-muted merges muted side-buffer; absent still warns on mutedHits", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 3_600_000 });
  const mutedBuffer = new EventBuffer({ maxEvents: 50, maxEventsPerSource: 50, maxAgeMs: 3_600_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const isMuted: MuteFilter = (e) => e.msg.startsWith("noise");
  const push = (msg: string) => {
    const prepared = ingest.prepare({ source: "s", deviceId: "d", app: "a", level: "info", msg });
    if (isMuted(prepared)) mutedBuffer.push(ingest.assignId(prepared));
    else ingest.commit(prepared);
  };
  push("noise hush");
  push("crash boom");
  push("noise hush");
  assert.equal(buffer.size, 1);
  assert.equal(mutedBuffer.size, 2);

  const presentHidden = expectEvents(buffer, { text: "noise" }, "present", 8_000, isMuted, {}, mutedBuffer);
  assert.equal(presentHidden.ok, false);
  assert.equal(presentHidden.matched, 0);
  assert.equal(presentHidden.muted, 0); // page only sees main without includeMuted
  assert.equal(
    // matched mutedHits drive the absent warning (side-buffer scan)
    expectEvents(buffer, { text: "noise" }, "absent", 8_000, isMuted, {}, mutedBuffer).warning?.includes("muted matching"),
    true,
  );

  const presentShown = expectEvents(
    buffer,
    { text: "noise", includeMuted: true },
    "present",
    8_000,
    isMuted,
    {},
    mutedBuffer,
  );
  assert.equal(presentShown.ok, true);
  assert.equal(presentShown.matched, 2);
  assert.equal(presentShown.events.length, 2);
});

test("wait-for gives up on timeout or when its caller goes away", async () => {
  const { buffer } = timeline();
  let listening = 0;
  const onPush = buffer.onPush.bind(buffer);
  buffer.onPush = (listener) => {
    listening++;
    const unsubscribe = onPush(listener);
    return () => (listening--, unsubscribe());
  };
  assert.equal(await waitFor(buffer, { text: "never" }, 10, new AbortController().signal), undefined);
  const gone = new AbortController();
  const waiting = waitFor(buffer, { text: "never" }, 60_000, gone.signal);
  gone.abort();
  assert.equal(await waiting, undefined);
  assert.equal(listening, 0, "nothing is left listening");
});

test("expect checks the window now and says when eviction took part of it", () => {
  const { buffer, add } = timeline(3);
  add("crash");
  add("ok");
  assert.equal(expectEvents(buffer, { text: "crash" }, "present", 8_000).ok, true);
  assert.equal(expectEvents(buffer, { text: "crash", sinceId: 1 }, "absent", 8_000).ok, true);
  const present = expectEvents(buffer, { text: "crash" }, "absent", 8_000);
  assert.deepEqual([present.ok, present.matched, present.events.length], [false, 1, 1]);
  assert.ok(present.warning?.includes("entire buffer"), "unbound expect warns");
  assert.equal(present.window.fromId, 1);
  assert.ok(present.window.toId >= 1);
  const bound = expectEvents(buffer, { text: "crash", sinceId: 1 }, "absent", 8_000);
  assert.equal(bound.warning, undefined);
  assert.ok(bound.window.fromId > 1 || bound.matched === 0);
  for (let i = 0; i < 3; i++) add("ok");
  const evicted = expectEvents(buffer, { text: "crash" }, "absent", 8_000);
  assert.equal(evicted.ok, true);
  assert.deepEqual(evicted.gap, { reason: "evicted", fromId: 1, toId: 2, toTs: evicted.gap!.toTs });
});

test("expect absent fails while events still wait for enrichers; present does not care", () => {
  const { buffer, add } = timeline(10);
  add("ok");
  const absent = expectEvents(buffer, { text: "crash", sinceId: 0 }, "absent", 8_000, undefined, {}, undefined, 2);
  assert.deepEqual([absent.ok, absent.pending], [false, 2]);
  assert.match(absent.warning ?? "", /2 event\(s\) were still being enriched/);
  const present = expectEvents(buffer, { text: "ok", sinceId: 0 }, "present", 8_000, undefined, {}, undefined, 2);
  assert.deepEqual([present.ok, present.pending], [true, 2]);
  const settled = expectEvents(buffer, { text: "crash", sinceId: 0 }, "absent", 8_000);
  assert.deepEqual([settled.ok, settled.pending], [true, undefined]);
});

test("a pending event may land in a window only if the window has no end and its filters match", () => {
  const pending = { schemaVersion: SCHEMA_VERSION, ts: 5, deviceTs: 5, hostTs: 5, estimated: false, source: "react-native", deviceId: "d", app: "a", sessionId: "s", pid: null, level: "error" as const, msg: "TypeError: boom", attrs: {} };
  assert.equal(mayLandInWindow(pending, { text: "typeerror", sinceId: 99 }), true);
  assert.equal(mayLandInWindow(pending, { text: "typeerror", untilId: 99 }), false);
  assert.equal(mayLandInWindow(pending, { text: "typeerror", sources: ["android"] }), false);
  assert.equal(mayLandInWindow(pending, { text: "other" }), false);
  assert.equal(mayLandInWindow(pending, { minLevel: "fatal" }), false);
});

test("the daemon's expect waits for events still being enriched, up to timeoutMs", async () => {
  const { root, append } = await feedApp({ plugins: [{ module: FEED_PLUGIN, options: { file: "feed.jsonl", enrichDelayMs: 400 } }] });
  try {
    await ensureDaemon(root);
    const expect = (expectation: string, timeoutMs?: number) =>
      call(root, "expect", { clientId: "cli-1", expect: expectation, ...(timeoutMs === undefined ? {} : { timeoutMs }), query: { text: "TypeError", sinceId: 0 } }, 10_000) as Promise<{ ok: boolean; matched: number; pending?: number }>;
    const emitted = async () =>
      ((await call(root, "status")) as { sourceActivity?: { name: string; events: number }[] }).sourceActivity?.find((act) => act.name === "feed")?.events ?? 0;
    await append({ level: "error", msg: "TypeError: boom", attrs: { slow: true } });
    await eventually(async () => (await emitted()) === 1, "the slow event to be emitted");
    const early = await expect("absent", 0);
    assert.deepEqual([early.ok, early.matched, early.pending], [false, 0, 1]);
    const waited = await expect("absent");
    assert.deepEqual([waited.ok, waited.matched, waited.pending], [false, 1, undefined]);

    await append({ level: "info", msg: "unrelated chatter", attrs: { slow: true } });
    await eventually(async () => (await emitted()) === 2, "the unrelated slow event to be emitted");
    const unrelated = await expect("absent", 0);
    assert.deepEqual([unrelated.ok, unrelated.matched, unrelated.pending], [false, 1, undefined], "only the stored TypeError counts");
    const elsewhere = (await call(root, "expect", { clientId: "cli-1", expect: "absent", timeoutMs: 0, query: { text: "chatter", sinceId: 0, untilId: 1 } })) as { ok: boolean; pending?: number };
    assert.deepEqual([elsewhere.ok, elsewhere.pending], [true, undefined], "a window that ended before it can't hold it");
  } finally {
    await discardProject(root);
  }
});

test("the daemon's expect --present answers at once when a match is stored, whatever is still enriching", async () => {
  const { root, append } = await feedApp({ plugins: [{ module: FEED_PLUGIN, options: { file: "feed.jsonl", enrichDelayMs: 3_000 } }] });
  try {
    await ensureDaemon(root);
    const emitted = async () =>
      ((await call(root, "status")) as { sourceActivity?: { name: string; events: number }[] }).sourceActivity?.find((act) => act.name === "feed")?.events ?? 0;
    await append({ level: "info", msg: "Upload done" });
    await append({ level: "info", msg: "Upload done later", attrs: { slow: true } });
    await eventually(async () => (await emitted()) === 2, "both events to be emitted");
    const startedAt = Date.now();
    const present = (await call(root, "expect", { clientId: "cli-1", expect: "present", query: { text: "Upload done", sinceId: 0 } }, 10_000)) as { ok: boolean; matched: number; pending?: number };
    assert.ok(Date.now() - startedAt < 1_500, `took ${Date.now() - startedAt} ms`);
    assert.deepEqual([present.ok, present.matched, present.pending], [true, 1, undefined]);
  } finally {
    await discardProject(root);
  }
});

test("expect matched and ok honor mute unless includeMuted", () => {
  const { buffer, add } = timeline();
  add("noise hush");
  add("crash boom");
  add("noise hush");
  const isMuted: MuteFilter = (e) => e.msg.startsWith("noise");
  // Muted-only present fails; absent passes — muted hits must not fake a present/absent.
  const presentHidden = expectEvents(buffer, { text: "noise" }, "present", 8_000, isMuted);
  assert.equal(presentHidden.ok, false);
  assert.equal(presentHidden.matched, 0);
  assert.equal(presentHidden.events.length, 0);
  assert.equal(presentHidden.muted, 2);
  const absentHidden = expectEvents(buffer, { text: "noise" }, "absent", 8_000, isMuted);
  assert.equal(absentHidden.ok, true);
  assert.equal(absentHidden.matched, 0);
  assert.equal(absentHidden.muted, 2);
  assert.ok(absentHidden.warning?.includes("muted matching"), `absent with muted hits must warn: ${absentHidden.warning}`);
  // includeMuted restores counting (and the page).
  const presentShown = expectEvents(buffer, { text: "noise", includeMuted: true }, "present", 8_000, isMuted);
  assert.equal(presentShown.ok, true);
  assert.equal(presentShown.matched, 2);
  assert.equal(presentShown.events.length, 2);
  assert.equal(presentShown.muted, 0);
  const absentShown = expectEvents(buffer, { text: "noise", includeMuted: true }, "absent", 8_000, isMuted);
  assert.equal(absentShown.ok, false);
  assert.equal(absentShown.matched, 2);
});

test("done when: a fix-verification loop works on the fixture app, across a reload", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  const cli = async (...args: string[]) => {
    const run = await runCli(root, args);
    return { code: run.code, out: JSON.parse(run.stdout) };
  };
  assert.equal((await cli("start")).code, 0);
  assert.equal((await cli("mark", "repro")).code, 0);
  await append({ pid: 100, msg: "loading profile" }, { pid: 100, level: "error", msg: "TypeError: Cannot read property 'name' of undefined" });
  const crashed = await cli("wait-for", "TypeError", "--since", "repro", "--level", "error", "--timeout", "20000");
  assert.equal(crashed.code, 0);
  assert.equal(crashed.out.event.msg, "TypeError: Cannot read property 'name' of undefined");
  assert.equal((await cli("expect", "--present", "TypeError", "--since", "repro")).code, 0);

  // The fix: mark, reload (a new pid) and run the repro again.
  await cli("mark", "fix");
  const reloaded = cli("wait-for", "profile loaded", "--since", "fix", "--timeout", "20000");
  await append({ pid: 101, msg: "loading profile" }, { pid: 101, msg: "profile loaded" });
  assert.equal((await reloaded).code, 0);
  assert.equal((await reloaded).out.event.pid, 101);
  const fixed = await cli("expect", "--absent", "TypeError", "--since", "fix");
  assert.equal(fixed.code, 0);
  assert.deepEqual([fixed.out.ok, fixed.out.matched], [true, 0]);
  const before = await cli("expect", "--absent", "TypeError", "--since", "repro");
  assert.deepEqual([before.code, before.out.matched], [1, 1]);

  const timedOut = await cli("wait-for", "TypeError", "--since", "fix", "--timeout", "50");
  assert.deepEqual([timedOut.code, timedOut.out.matched, timedOut.out.event], [1, false, null]);
  assert.equal((await runCli(root, ["expect", "TypeError"])).code, 2);
});

test("wait-for ends with exit 1 and 'daemon exited' when the daemon is killed mid-wait", async () => {
  const { root } = await feedApp();
  roots.push(root);
  assert.equal((await runCli(root, ["start"])).code, 0);
  const waiting = runCli(root, ["wait-for", "never", "--timeout", "60000"]).then((run) => ({ ...run, at: Date.now() }));
  const status = async () => (await call(root, "status")) as { pid: number; pendingCalls: number };
  await eventually(async () => (await status()).pendingCalls === 1, "the wait to reach the daemon");
  const { pid } = await status();
  process.kill(pid, "SIGKILL");
  const killedAt = Date.now();
  const run = await waiting;
  assert.equal(run.code, 1);
  assert.match(JSON.parse(run.stdout).error, /daemon exited before answering/);
  assert.ok(run.at - killedAt < 1_000, `the client took ${run.at - killedAt} ms to notice`);
});

test("expect, like any call, fails with 'daemon exited' when the connection closes unanswered", async () => {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-gone-"));
  await mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  const { socket } = daemonPaths(root);
  const server = createServer((connection) => {
    connection.write(`${JSON.stringify({ hello: { root: resolveRoot(root) } })}\n`);
    connection.once("data", () => connection.destroy());
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await assert.rejects(call(root, "expect", { expect: "absent" }, 60_000), DaemonExitedError);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("expect window fromTs/toTs bound every searched row across skewed clocks", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 3_600_000 }, () => 10_000);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    deviceTs: null as null,
    estimated: true as const,
    source: "s",
    deviceId: "d",
    app: "a",
    sessionId: "x",
    pid: null as null,
    level: "error" as const,
    msg: "boom",
    attrs: {},
  };
  // Arrival order: fresh banner, then older timeline ts (cross-source skew).
  buffer.push({ ...base, id: 1, ts: 9_000, hostTs: 9_000, msg: "banner" });
  buffer.push({ ...base, id: 2, ts: 1_000, hostTs: 9_100, msg: "older" });
  buffer.push({ ...base, id: 3, ts: 8_000, hostTs: 9_200, msg: "mid" });
  const result = expectEvents(buffer, { sinceId: 0 }, "present", 8_000);
  assert.equal(result.window.fromTs, 1_000);
  assert.equal(result.window.toTs, 9_000);
  assert.equal(result.window.fromId, 1);
  assert.equal(result.window.toId, 3);
});
