import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  CLIENTS_ATTACHED,
  CONFIG_FILE,
  DaemonNotRunningError,
  MAX_LOG_BYTES,
  SocketCollisionError,
  attach,
  call,
  daemonPaths,
  ensureDaemon,
  ensureRuntimeDir,
  runtimeDir,
  socketPath,
  status,
  RpcError,
  type QueryResult,
  type RpcNotice,
} from "@hindwatch/core";
import { alive, bareEnv, CLI, CRASH_DETECTOR_PLUGIN, discardProject, eventually, FEED_PLUGIN, feedApp, FIXTURE_PLUGIN, processesMatching, runCli, SKEW, SKEWED_LOG, TRUE_ORDER } from "./helpers.js";
import { test } from "./timed.js";

const roots: string[] = [];

async function project(extra: Record<string, unknown> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-test-")));
  roots.push(root);
  const config = {
    plugins: [{ module: FIXTURE_PLUGIN, options: { file: SKEWED_LOG, clockSkewMs: SKEW } }],
    ...extra,
  };
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(config));
  return root;
}

async function waitUntilStopped(root: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await status(root);
    } catch (error) {
      if (error instanceof DaemonNotRunningError) return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error("daemon did not stop");
    await delay(50);
  }
}

async function waitForExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not exit`);
    await delay(25);
  }
}

const query = (root: string, clientId: string, sinceLast = false) =>
  call(root, "query", { clientId, sinceLast, query: {} }) as Promise<QueryResult>;

after(async () => {
  for (const root of roots) await discardProject(root);
});

test("concurrent starts leave exactly one daemon", async () => {
  const root = await project();
  const starts = await Promise.all(Array.from({ length: 4 }, () => ensureDaemon(root)));
  const pids = new Set(starts.map((s) => s.status.pid));
  assert.equal(pids.size, 1);
  const again = await ensureDaemon(root);
  assert.equal(again.started, false);
  assert.ok(pids.has(again.status.pid));
});

test("the daemon serves the normalized timeline, and since-last is per client", async () => {
  const root = await project();
  await ensureDaemon(root);
  const first = await query(root, "agent-a", true);
  assert.deepEqual(first.events.filter((e) => !e.estimated).map((e) => e.msg), TRUE_ORDER);
  assert.equal((await query(root, "agent-a", true)).events.length, 0);
  assert.equal((await query(root, "agent-b", true)).events.length, first.events.length);
});

test("sinceLast advances past returned ids even when the page is truncated", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  await ensureDaemon(root);
  // Fat msgs so a tight budget returns one event with next set (the E2E stuck-cursor case).
  const fat = "x".repeat(400);
  await append(
    { level: "error", msg: `err-a ${fat}` },
    { level: "error", msg: `err-b ${fat}` },
    { level: "error", msg: `err-c ${fat}` },
  );
  await eventually(async () => {
    const page = (await call(root, "query", {
      clientId: "probe",
      sinceLast: false,
      query: { minLevel: "error", budgetChars: 1000 },
    })) as QueryResult;
    return page.events.length >= 1 && page.truncated === true;
  }, "fat errors to fill a truncated page");

  const first = (await call(root, "query", {
    clientId: "poller",
    sinceLast: true,
    query: { minLevel: "error", budgetChars: 1000 },
  })) as QueryResult;
  assert.ok(first.events.length >= 1, "first sinceLast returns something");
  assert.equal(first.truncated, true);
  const firstIds = first.events.map((e) => e.id);

  const second = (await call(root, "query", {
    clientId: "poller",
    sinceLast: true,
    query: { minLevel: "error", budgetChars: 1000 },
  })) as QueryResult;
  const secondIds = second.events.map((e) => e.id);
  assert.ok(secondIds.every((id) => !firstIds.includes(id)), `two polls must not repeat ids: first=${firstIds} second=${secondIds}`);

  // Drain with sinceLast until empty — every error id appears exactly once across polls.
  const seen = new Set<number>([...firstIds, ...secondIds]);
  for (let i = 0; i < 10; i++) {
    const page = (await call(root, "query", {
      clientId: "poller",
      sinceLast: true,
      query: { minLevel: "error", budgetChars: 1000 },
    })) as QueryResult;
    for (const event of page.events) {
      assert.equal(seen.has(event.id), false, `id ${event.id} repeated across sinceLast polls`);
      seen.add(event.id);
    }
    if (page.events.length === 0) break;
  }
  assert.ok(seen.size >= 3, `expected all three errors across polls, saw ${seen.size}`);
});

test("sinceLast with order desc is rejected so unread events are not skipped", async () => {
  const { root, append } = await feedApp();
  roots.push(root);
  await ensureDaemon(root);
  await append({ level: "error", msg: "a" }, { level: "error", msg: "b" }, { level: "error", msg: "c" });
  await eventually(async () => {
    const page = (await call(root, "query", {
      clientId: "probe",
      sinceLast: false,
      query: { minLevel: "error" },
    })) as QueryResult;
    return page.events.length >= 3;
  }, "three errors");

  await assert.rejects(
    call(root, "query", {
      clientId: "desc-poller",
      sinceLast: true,
      query: { minLevel: "error", order: "desc", budgetChars: 500 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RpcError);
      assert.match(error.message, /sinceLast cannot be used with order "desc"/);
      return true;
    },
  );
  // Asc sinceLast still works and does not leave the cursor advanced from the rejected call.
  const page = (await call(root, "query", {
    clientId: "desc-poller",
    sinceLast: true,
    query: { minLevel: "error", order: "asc" },
  })) as QueryResult;
  assert.ok(page.events.length >= 1, "asc sinceLast still returns events after a rejected desc");
});

test("status lists sourceActivity for attached sources", async () => {
  const root = await project();
  const { status: st } = await ensureDaemon(root);
  assert.ok(Array.isArray(st.sourceActivity));
  assert.ok((st.sourceActivity?.length ?? 0) >= 1);
  for (const act of st.sourceActivity ?? []) {
    assert.equal(typeof act.name, "string");
    assert.equal(typeof act.events, "number");
    assert.equal(typeof act.attachedAt, "number");
  }
  // Fixture emits on start — no silent warnings on a healthy project.
  assert.equal(st.warnings, undefined);
});

test("a filter naming a source the daemon does not run is refused, not answered empty", async () => {
  const root = await project();
  const { status: st } = await ensureDaemon(root);
  const running = (st.sourceActivity ?? []).map((act) => act.name);
  const missing = `${running.join("-")}-missing`;
  for (const method of ["query", "expect"]) {
    await assert.rejects(
      call(root, method, { clientId: "cli-1", expect: "absent", query: { sources: [running[0], missing] } }),
      (error: unknown) => {
        assert.ok(error instanceof RpcError);
        assert.match(error.message, new RegExp(`unknown source\\(s\\): ${missing};.*${running[0]}`));
        return true;
      },
    );
  }
  const page = (await call(root, "query", { clientId: "cli-1", query: { sources: running } })) as QueryResult;
  assert.ok(Array.isArray(page.events));
});

test("wait_for accepts a source nothing has emitted under yet, and says so if it never does", async () => {
  const { root, append } = await feedApp();
  try {
    await ensureDaemon(root);
    const waiting = call(root, "waitFor", { clientId: "cli-1", timeoutMs: 5_000, query: { sources: ["feed-extra"], sinceId: 0 } }, 10_000) as Promise<{ matched: boolean; warning?: string }>;
    await delay(100);
    await append({ source: "feed-extra", level: "error", msg: "first under its name" });
    const first = await waiting;
    assert.deepEqual([first.matched, first.warning], [true, undefined]);
    const typo = (await call(root, "waitFor", { clientId: "cli-1", timeoutMs: 50, query: { sources: ["feed-extar"] } })) as { matched: boolean; warning?: string };
    assert.equal(typo.matched, false);
    assert.match(typo.warning ?? "", /unknown source\(s\): feed-extar; known: .*feed-extra/);
  } finally {
    await discardProject(root);
  }
});

test("ensureDaemon recovers when stop and ensure race", async () => {
  const root = await project();
  const { status: before } = await ensureDaemon(root);
  const stopping = call(root, "stop", { clientId: "cli-1" });
  // Overlap ensure with shutdown: the peer may still answer, or the lock may still be held.
  const ensuring = ensureDaemon(root);
  await stopping;
  const again = await ensuring;
  assert.equal(typeof again.status.pid, "number");
  if (again.started) assert.notEqual(again.status.pid, before.pid);
  await waitUntilStopped(root).catch(() => {});
  const settled = await ensureDaemon(root);
  assert.equal(typeof settled.status.pid, "number");
});

test("ensureDaemon kill -9 reclaim leaves exactly one daemon", async () => {
  const root = await project();
  const { status: before } = await ensureDaemon(root);
  process.kill(before.pid, "SIGKILL");
  await eventually(() => !alive(before.pid), "killed daemon to exit");
  const next = await ensureDaemon(root);
  assert.equal(next.started, true);
  assert.notEqual(next.status.pid, before.pid);
  assert.equal((await processesMatching(`__daemon --root ${root}`)).length, 1);
  await call(root, "stop", { clientId: "cli-1" });
  await waitUntilStopped(root);
  assert.deepEqual(await processesMatching(`__daemon --root ${root}`), []);
});

test("stop needs --force only when another client is attached, and the next command relaunches", async () => {
  const root = await project();
  const { status: before } = await ensureDaemon(root);
  const mcp = await attach(root, "mcp-1", "mcp");

  await assert.rejects(call(root, "stop", { clientId: "cli-1" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, CLIENTS_ATTACHED);
    return true;
  });
  // The attached client itself can stop without --force.
  await call(root, "stop", { clientId: "mcp-1" });
  await mcp.closed;
  await waitUntilStopped(root);

  const relaunched = await ensureDaemon(root);
  assert.equal(relaunched.started, true);
  assert.notEqual(relaunched.status.pid, before.pid);
  // History restarted: a fresh daemon has no memory of earlier cursors.
  assert.ok((await query(root, "agent-a", true)).events.length > 0);

  const other = await attach(root, "mcp-2", "mcp");
  await call(root, "stop", { clientId: "cli-1", force: true });
  assert.deepEqual(await other.closed, { stopping: true });
  await waitUntilStopped(root);
});

test("attached sessions are told about every raised incident", async () => {
  const { root, append } = await feedApp({
    plugins: [{ module: FEED_PLUGIN, options: { file: "feed.jsonl" } }, { module: CRASH_DETECTOR_PLUGIN }],
  });
  try {
    await ensureDaemon(root);
    const notices: RpcNotice[] = [];
    const mcp = await attach(root, "mcp-1", "mcp", (notice) => notices.push(notice));
    const crash = (msg: string) => ({ level: "error" as const, msg, attrs: { exception: true } });
    await append(crash("TypeError: a"), crash("TypeError: a"), crash("TypeError: a"), crash("RangeError: b"));
    await eventually(() => notices.some((n) => n.notice === "incident" && n.id === 2), "a notice for incident 2");
    const ids = notices.flatMap((n) => (n.notice === "incident" ? [n.id] : []));
    assert.deepEqual([...new Set(ids)].sort(), [1, 2]);
    mcp.close();
    await mcp.closed;
  } finally {
    await discardProject(root);
  }
});

test("an idle daemon with no attached clients stops itself", async () => {
  const root = await project({ idleMs: 300 });
  await ensureDaemon(root);
  await waitUntilStopped(root, 3_000);
});

test("an attached client keeps the daemon from idling out", async () => {
  const root = await project({ idleMs: 300 });
  await ensureDaemon(root);
  const mcp = await attach(root, "mcp-1", "mcp");
  await delay(900);
  assert.equal((await status(root)).attachedClients, 1);
  mcp.close();
  await waitUntilStopped(root, 3_000);
});

/** Runs a second daemon process by hand and resolves with its exit code. */
function runSecondDaemon(root: string): Promise<number | null> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "__daemon", "--root", root], {
    stdio: "ignore",
  });
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

test("a dead daemon's lock and socket are taken over", async () => {
  const root = await project();
  const paths = daemonPaths(root);
  const { status: old } = await ensureDaemon(root);
  await call(root, "stop", { clientId: "t", force: true });
  await waitUntilStopped(root);
  await waitForExit(old.pid); // a crashed daemon is gone, not draining
  // Leave behind what a crashed daemon would: a lock naming a dead pid and a socket file.
  await writeFile(paths.lock, "999999");
  await writeFile(paths.socket, "");
  const { started, status: fresh } = await ensureDaemon(root);
  assert.equal(started, true);
  assert.equal((await stat(paths.lock)).isFile(), true);
  assert.notEqual(fresh.pid, old.pid);
});

/** A source that throws, or rejects, once its trigger file says so. */
const CRASHER = `import { readFileSync } from "node:fs";
export default ({ trigger }) => {
  let timer;
  const check = () => {
    let how;
    try { how = readFileSync(trigger, "utf8"); } catch { return; }
    clearInterval(timer);
    if (how === "reject") void Promise.reject(new Error("rejected on trigger"));
    else throw new Error("thrown on trigger");
  };
  return { name: "crasher", apiVersion: "0.1", sources: [{ name: "crasher", start: async () => { timer = setInterval(check, 20); }, stop: async () => clearInterval(timer) }] };
};
`;

test("a symlink in place of the daemon stderr file is refused, and nothing is written through it", async () => {
  const root = await project();
  const paths = daemonPaths(root);
  await ensureRuntimeDir();
  await mkdir(dirname(paths.stderr), { recursive: true });
  const victim = join(root, "victim.txt");
  await writeFile(victim, "keep");
  await symlink(victim, paths.stderr);
  await assert.rejects(ensureDaemon(root), /refusing to open .*\.stderr: it is a symlink/);
  assert.equal(await readFile(victim, "utf8"), "keep");
  await assert.rejects(status(root), DaemonNotRunningError);
});

test("a daemon crash after the log rotated is written to the current log, and stderr is emptied at each start", async () => {
  const root = await project();
  const paths = daemonPaths(root);
  const trigger = join(root, "trigger");
  await writeFile(join(root, "crasher.js"), CRASHER);
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: [{ module: "./crasher.js", options: { trigger } }] }));
  // Just under the cap, so the start keeps it and the daemon's first line rotates it.
  const filler = "x".repeat(MAX_LOG_BYTES - 1);
  await writeFile(paths.log, filler);
  await writeFile(paths.stderr, "from the last start\n");

  const { status: first } = await ensureDaemon(root);
  assert.equal(await readFile(`${paths.log}.1`, "utf8"), filler);
  assert.equal(await readFile(paths.stderr, "utf8"), "");
  await writeFile(trigger, "throw");
  await waitForExit(first.pid);
  assert.match(await readFile(paths.log, "utf8"), /uncaughtException: Error: thrown on trigger\n\s+at /);
  assert.equal(await readFile(`${paths.log}.1`, "utf8"), filler);

  await rm(trigger);
  const { status: second } = await ensureDaemon(root);
  await writeFile(trigger, "reject");
  await waitForExit(second.pid);
  assert.match(await readFile(paths.log, "utf8"), /unhandledRejection: Error: rejected on trigger\n\s+at /);
  assert.equal(await readFile(paths.stderr, "utf8"), "");
});

test("a starter that wins the lock still backs off when a daemon answers on the socket", async () => {
  const root = await project();
  const paths = daemonPaths(root);
  const { status: first } = await ensureDaemon(root);
  // Simulate the race where a slow starter removed the live lock.
  await rm(paths.lock);
  assert.equal(await runSecondDaemon(root), 0);
  assert.equal((await status(root)).pid, first.pid);
  await assert.rejects(access(paths.lock));
});

test("shells with different temp and runtime dirs share one daemon per root", async () => {
  const root = await project();
  const shell = async (name: string) => {
    const dir = await mkdtemp(join(tmpdir(), `hindwatch-shell-${name}-`));
    roots.push(dir);
    return { env: { ...bareEnv(), TMPDIR: dir, XDG_RUNTIME_DIR: dir, HINDWATCH_CLIENT: name } };
  };
  const [a, b] = await Promise.all([shell("a"), shell("b")]);
  const started = await Promise.all([runCli(root, ["start"], a), runCli(root, ["start"], b)]);
  assert.deepEqual(started.map((run) => run.code), [0, 0]);
  const pids = await Promise.all([a, b].map(async (env) => JSON.parse((await runCli(root, ["status"], env)).stdout).pid));
  assert.equal(pids[0], pids[1]);
  assert.equal((await processesMatching(`__daemon --root ${root}`)).length, 1);
});

test("a root named through a symlink, as /var is /private/var on macOS, reaches the same daemon", async () => {
  const root = await project();
  const holder = await mkdtemp(join(tmpdir(), "hindwatch-link-"));
  roots.push(holder);
  const link = join(holder, "project");
  await symlink(root, link);
  // tmpdir() is the unresolved /var/folders/... on macOS, while project() keeps /private/var/...
  const unresolved = join(tmpdir(), basename(root));
  const viaLink = await ensureDaemon(link);
  const viaTmpdir = await ensureDaemon(unresolved);
  const direct = await status(root);
  const viaCli = JSON.parse((await runCli(link, ["status"])).stdout);
  assert.deepEqual([viaTmpdir.status.pid, direct.pid, viaCli.pid], [viaLink.status.pid, viaLink.status.pid, viaLink.status.pid]);
  assert.equal(viaLink.status.root, root);
  assert.equal(daemonPaths(link).socket, daemonPaths(root).socket);
  assert.equal((await processesMatching("__daemon --root")).filter((line) => line.includes(basename(root))).length, 1);
});

test("a daemon greeting with another root is a socket collision, and is sent nothing", async () => {
  const root = await project();
  await ensureRuntimeDir();
  const received: string[] = [];
  const fake = createServer((socket) => {
    socket.on("data", (chunk) => received.push(String(chunk)));
    socket.write(`${JSON.stringify({ hello: { root: "/some/other/root" } })}\n`);
  });
  await new Promise<void>((resolve) => fake.listen(daemonPaths(root).socket, resolve));
  try {
    await assert.rejects(call(root, "status"), SocketCollisionError);
    await assert.rejects(attach(root, "collision-test", "mcp"), /socket collision/);
    await assert.rejects(ensureDaemon(root), SocketCollisionError);
    assert.deepEqual(received, []);
    assert.deepEqual(await processesMatching(`__daemon --root ${root}`), []);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("the socket path stays under the 104-byte macOS limit for any root", async () => {
  const holder = await mkdtemp(join(tmpdir(), "hindwatch-deep-"));
  roots.push(holder);
  const deep = join(holder, ..."abcd".split("").map((letter) => letter.repeat(125)));
  await mkdir(deep, { recursive: true });
  assert.ok(Buffer.byteLength(daemonPaths(deep).socket) < 104);
});

test("a socket name is shortened to fit the 104-byte limit, and a folder with no room for one is refused", () => {
  const hash = "0123456789abcdef";
  assert.equal(socketPath("/Users/me/.hindwatch/run", hash), `/Users/me/.hindwatch/run/${hash}.sock`);
  const deep = `/${"d".repeat(85)}`;
  const shortened = socketPath(deep, hash);
  assert.equal(Buffer.byteLength(shortened), 103);
  assert.ok(shortened.startsWith(`${deep}/01234567`));
  assert.throws(() => socketPath(`/${"d".repeat(95)}`, hash), /too long a path for a Unix socket/);
});

/** A scratch home for the runtime folder, removed after the test. */
async function scratchHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-home-")));
  roots.push(home);
  return home;
}

const REFUSED = /refusing to start: .* must be a directory, not a symlink, owned by the current user with mode 0700/;

test("the runtime folder and its parent are created owner-only", async () => {
  const dir = join(await scratchHome(), ".hindwatch", "run");
  assert.equal(await ensureRuntimeDir(dir), dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, ".."))).mode & 0o777, 0o700);
});

test("a pre-made runtime folder that others can reach is refused, not repaired or replaced", async () => {
  const dir = join(await scratchHome(), "run");
  await mkdir(dir);
  await chmod(dir, 0o755);
  await assert.rejects(ensureRuntimeDir(dir), REFUSED);
  assert.equal((await stat(dir)).mode & 0o777, 0o755);
});

test("a symlink in place of the runtime folder is refused, even to an owner-only folder", async () => {
  const home = await scratchHome();
  const target = join(home, "elsewhere");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(home, "run"));
  await assert.rejects(ensureRuntimeDir(join(home, "run")), REFUSED);
  await symlink(join(home, "missing"), join(home, "dangling"));
  await assert.rejects(ensureRuntimeDir(join(home, "dangling")), REFUSED);
});

test("the runtime folder and the socket, lock and log in it are private to the user", async () => {
  const root = await project();
  await ensureDaemon(root);
  assert.equal((await stat(runtimeDir())).mode & 0o777, 0o700);
  const { socket, lock, log } = daemonPaths(root);
  for (const file of [socket, lock, log]) assert.equal((await stat(file)).mode & 0o077, 0, file);
});

test("sinceLast truncated pages advance by timeline end so a lower id after the page is not skipped", async () => {
  // Arrival: high-ts first (low id), then low-ts (high id). Timeline asc shows high-id first.
  // Old sinceLast jumped to max id and skipped the low-id later-ts event; timeline `after` keeps it.
  const { root, append } = await feedApp();
  roots.push(root);
  await ensureDaemon(root);
  const fat = "x".repeat(400);
  await append(
    { level: "error", msg: `later-on-timeline ${fat}`, deviceId: "d-a", deviceTs: 2_000 },
    { level: "error", msg: `earlier-on-timeline ${fat}`, deviceId: "d-b", deviceTs: 1_000 },
  );
  await eventually(async () => {
    const page = (await call(root, "query", {
      clientId: "probe",
      sinceLast: false,
      query: { minLevel: "error", budgetChars: 1000 },
    })) as QueryResult;
    return page.events.length >= 1 && page.truncated === true;
  }, "skewed fat errors to fill a truncated page");

  const first = (await call(root, "query", {
    clientId: "skew-poller",
    sinceLast: true,
    query: { minLevel: "error", budgetChars: 1000 },
  })) as QueryResult;
  assert.equal(first.truncated, true);
  assert.equal(first.events.length, 1);
  assert.ok(
    first.events[0]!.msg.startsWith("earlier-on-timeline"),
    `expected earlier-on-timeline first, got ${first.events[0]!.msg.slice(0, 40)}`,
  );
  const firstId = first.events[0]!.id;

  const second = (await call(root, "query", {
    clientId: "skew-poller",
    sinceLast: true,
    query: { minLevel: "error", budgetChars: 1000 },
  })) as QueryResult;
  assert.equal(second.events.length, 1, JSON.stringify(second));
  assert.ok(
    second.events[0]!.msg.startsWith("later-on-timeline"),
    "lower-id later-ts event must appear on the next sinceLast page",
  );
  assert.ok(second.events[0]!.id < firstId, "prove: recovered id is lower than the prior page's id");
});
