import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS_ATTACHED, CONFIG_FILE, DaemonNotRunningError, INVALID_PATH, REACT_NATIVE_PLUGIN, call, daemonPaths, ensureDaemon, status } from "@hindwatch/core";
import { MAX_TOOL_DESCRIPTION_CHARS } from "../src/mcp.js";
import { CLI, CRASH_DETECTOR_PLUGIN, FEED_PLUGIN, IDLE_SOURCE_PLUGIN, bareEnv, discardProject, eventually, feedApp, runCli } from "./helpers.js";
import { omitEmpty } from "../src/util.js";
import { test } from "./timed.js";

interface Message {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

interface ToolResult {
  readonly content: { type: string; text: string }[];
  readonly isError?: boolean;
}

/** `hindwatch mcp` driven over raw JSON-RPC on stdio, as a 2025 client would. */
async function mcpClient(root: string, env: NodeJS.ProcessEnv = bareEnv()) {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "mcp", "--root", root], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const messages: Message[] = [];
  const waiting = new Map<number, (message: Message) => void>();
  let pending = "";
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      lines.push(line);
      const message = JSON.parse(line) as Message;
      messages.push(message);
      if (message.id !== undefined && message.method === undefined) waiting.get(message.id)?.(message);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let nextId = 0;
  const write = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = ++nextId;
    const answered = new Promise<Message>((resolve) => waiting.set(id, resolve));
    write({ id, method, params });
    return answered;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const result = reply.result as unknown as ToolResult;
    const text = result.content[0]!.text;
    return { isError: result.isError === true, text, value: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "0" },
  });
  write({ method: "notifications/initialized" });
  return {
    initialized,
    lines,
    messages,
    request,
    tool,
    exited,
    stderr: () => stderr,
    end: () => child.stdin!.end(),
    kill: () => child.kill(),
  };
}

const notified = (messages: readonly Message[], method: string, uri?: string) =>
  messages.some((m) => m.method === method && (uri === undefined || m.params?.uri === uri));

test("the server lists strict, described tools, the incident resource and both prompts without starting the daemon", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  assert.deepEqual((mcp.initialized.result!.capabilities as Record<string, unknown>).resources, { subscribe: true, listChanged: true });
  const tools = (await mcp.request("tools/list")).result!.tools as { name: string; description: string; inputSchema: Record<string, unknown> }[];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "doctor", "expect", "export", "incident", "incidents", "logs", "mark", "marks", "mute", "noise", "patterns", "status", "stop", "unmute", "wait_for",
  ]);
  for (const tool of tools) {
    assert.match(tool.description, /^Use /, tool.name);
    assert.match(tool.description, /Not for /, tool.name);
    assert.ok(tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  const templates = (await mcp.request("resources/templates/list")).result!.resourceTemplates as { uriTemplate: string }[];
  assert.deepEqual(templates.map((template) => template.uriTemplate), ["incident://{id}"]);
  const prompts = (await mcp.request("prompts/list")).result!.prompts as { name: string }[];
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["debug-this-crash", "verify-my-fix"]);

  await assert.rejects(status(root), DaemonNotRunningError);
});

test("the first tool call starts the daemon and says history begins; a stop and the next call relaunch it", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  const first = await mcp.tool("mark", { name: "fix" });
  assert.equal(first.isError, false);
  assert.deepEqual(first.value.daemon, { started: true, note: "daemon (re)started: history begins now" });
  const second = await mcp.tool("marks");
  assert.equal(second.value.daemon, undefined);
  assert.deepEqual((second.value.marks as { name: string }[]).map((mark) => mark.name), ["fix"]);

  const refused = await runCli(root, ["stop"]);
  assert.equal(JSON.parse(refused.stdout).code, CLIENTS_ATTACHED);

  const before = await status(root);
  const stopped = await mcp.tool("stop");
  assert.equal(stopped.isError, false);

  // status right after stop must restart across the draining peer's lock — not "no daemon running".
  const afterStop = await mcp.tool("status");
  assert.equal(afterStop.isError, false, JSON.stringify(afterStop.value));
  assert.equal(typeof afterStop.value.pid, "number");
  assert.notEqual(afterStop.value.pid, before.pid);
  assert.deepEqual(afterStop.value.daemon, { started: true, note: "daemon (re)started: history begins now" });

  const relaunched = await mcp.tool("marks");
  assert.equal(relaunched.value.daemon, undefined);
  assert.deepEqual(relaunched.value.marks, []);
  assert.notEqual((await status(root)).pid, before.pid);
  await eventually(() => notified(mcp.messages, "notifications/resources/list_changed"), "the resource list to change");
});

test("subscribing starts the daemon and attaches, like a tool call", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  const reply = await mcp.request("resources/subscribe", { uri: "incident://1" });
  assert.deepEqual(reply.result, {});
  assert.equal((await status(root)).attachedClients, 1);
});

test("a check that doesn't hold is a tool error that keeps its body, as the CLI exits 1", async (t) => {
  const { root, append } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  await mcp.tool("mark", { name: "fix" });
  await append({ level: "error", msg: "TypeError: boom" });
  await mcp.tool("wait_for", { text: "boom", since: "fix", timeoutMs: 5_000 });

  const regressed = await mcp.tool("expect", { expect: "absent", text: "boom", context: false });
  assert.equal(regressed.isError, true);
  assert.equal(regressed.value.ok, false);
  assert.equal(regressed.value.matched, 1);
  assert.deepEqual((regressed.value.events as { msg: string }[]).map((event) => event.msg), ["TypeError: boom"]);
  const cli = await runCli(root, ["expect", "--absent", "boom"]);
  assert.equal(cli.code, 1);
  assert.deepEqual(omitEmpty(JSON.parse(cli.stdout)), regressed.value);

  const missing = await mcp.tool("expect", { expect: "present", text: "never logged" });
  assert.equal(missing.isError, true);
  assert.equal(missing.value.matched, 0);
  const held = await mcp.tool("expect", { expect: "absent", text: "never logged" });
  assert.equal(held.isError, false);
  assert.equal(held.value.ok, true);

  const timedOut = await mcp.tool("wait_for", { text: "never logged", timeoutMs: 1 });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.value.matched, false);
  assert.equal(timedOut.value.event, undefined);
  assert.equal(typeof timedOut.value.waitedMs, "number");
});

test("patterns accepts text and folds only matching messages", async (t) => {
  const { root, append } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });
  await mcp.tool("status");
  await append(
    { pid: 1, msg: "poll 1 ok" },
    { pid: 1, msg: "poll 2 ok" },
    { pid: 1, level: "error", msg: "login failed 1" },
    { pid: 1, level: "error", msg: "login failed 2" },
  );
  await mcp.tool("wait_for", { text: "login failed 2", timeoutMs: 5_000 });
  const rejected = await mcp.tool("patterns", { text: "login failed", unknownKey: true });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.value.code, "INVALID_INPUT");
  assert.match(String(rejected.value.error), /unknownKey|Unrecognized key/i);
  const page = await mcp.tool("patterns", { text: "login failed" });
  assert.equal(page.isError, false, page.text);
  assert.equal(page.value.events, 2);
  assert.deepEqual(
    (page.value.patterns as { template: string }[]).map((p) => p.template),
    ["login failed {num}"],
  );
});

test("mute batches patternIds and omits the full rules list; a logs cursor rejects changed filters", async (t) => {
  const { root, append } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  await mcp.tool("status");
  await append(
    { pid: 1, msg: "poll 1 ok" },
    { pid: 1, msg: "poll 2 ok" },
    { pid: 1, level: "error", msg: "login failed 1" },
    { pid: 1, level: "error", msg: "login failed 2" },
    { pid: 1, msg: "unrelated hello" },
  );
  await mcp.tool("wait_for", { text: "unrelated hello", timeoutMs: 5_000 });
  const patterns = await mcp.tool("patterns", { budget: 100_000 });
  assert.equal(patterns.isError, false, patterns.text);
  const ids = (patterns.value.patterns as { id: string; template: string }[]).map((p) => p.id);
  assert.ok(ids.length >= 2);

  const neither = await mcp.tool("mute", {});
  assert.equal(neither.isError, true);
  assert.equal(neither.value.code, "INVALID_INPUT");

  const batched = await mcp.tool("mute", { patternIds: ids.slice(0, 2) });
  assert.equal(batched.isError, false, batched.text);
  assert.ok(Array.isArray(batched.value.muted));
  assert.equal((batched.value.muted as unknown[]).length, 2);
  assert.equal(batched.value.rules, undefined);

  const one = await mcp.tool("mute", { patternId: ids[2] ?? ids[0]! });
  assert.equal(one.isError, false, one.text);
  assert.equal(typeof one.value.muted, "object");
  assert.equal(Array.isArray(one.value.muted), false);
  assert.equal(one.value.rules, undefined);

  const listed = await mcp.tool("noise");
  assert.equal(listed.isError, false, listed.text);
  assert.ok(((listed.value.rules as unknown[]) ?? []).length >= 2);

  // Fill enough events so logs paginate under a tiny budget.
  await append(...Array.from({ length: 40 }, (_, i) => ({ pid: 1, msg: `page line ${i}` })));
  await mcp.tool("wait_for", { text: "page line 39", timeoutMs: 5_000 });
  const page = await mcp.tool("logs", { text: "page line", budget: 900 });
  assert.equal(page.isError, false, page.text);
  assert.ok(page.value.next, "expected a next cursor");
  const mismatched = await mcp.tool("logs", { text: "other", budget: 900, cursor: page.value.next });
  assert.equal(mismatched.isError, true);
  assert.match(String(mismatched.value.error), /cursor was minted with different filters/);
  const continued = await mcp.tool("logs", { text: "page line", budget: 2_000, cursor: page.value.next });
  assert.equal(continued.isError, false, continued.text);
});

test("mute accepts subsystem+category and refuses category alone", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });
  await mcp.tool("status");

  const alone = await mcp.tool("mute", { category: "BackgroundTask" });
  assert.equal(alone.isError, true);
  assert.equal(alone.value.code, "INVALID_INPUT");
  assert.match(String(alone.value.error), /category requires subsystem/);

  const scoped = await mcp.tool("mute", {
    subsystem: "com.apple.UIKit",
    category: "BackgroundTask",
    source: "ios-sim",
  });
  assert.equal(scoped.isError, false, scoped.text);
  assert.equal(typeof scoped.value.muted, "object");
  assert.equal((scoped.value.muted as { subsystem?: string }).subsystem, "com.apple.UIKit");
  assert.equal((scoped.value.muted as { category?: string }).category, "BackgroundTask");

  const listed = await mcp.tool("noise");
  assert.equal(listed.isError, false, listed.text);
  const rules = listed.value.rules as { subsystem?: string; category?: string }[];
  assert.ok(rules.some((r) => r.subsystem === "com.apple.UIKit" && r.category === "BackgroundTask"));
});

test("bad tool input gets the CLI's {error, code} shape before any daemon starts, unknown tools stay a JSON-RPC error, and the server keeps serving", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  const invalid = async (name: string, args: Record<string, unknown>, mentions: RegExp) => {
    const result = await mcp.tool(name, args);
    assert.equal(result.isError, true, name);
    assert.deepEqual(Object.keys(result.value).sort(), ["code", "error"], result.text);
    assert.equal(result.value.code, "INVALID_INPUT");
    assert.match(String(result.value.error), mentions);
  };
  await invalid("marks", { everything: true }, /invalid input for marks: .*everything/);
  await invalid("incident", { id: "seven" }, /invalid input for incident: id: /);
  await invalid("expect", { text: "boom" }, /expect: /);
  await invalid("logs", { level: "loud" }, /level: /);
  await invalid("logs", { budget: -5 }, /budget: /);
  await invalid("mark", { name: "9 lives" }, /invalid input for mark: name: mark names start with a letter/);

  const refused = async (name: string, args: Record<string, unknown>, mentions: RegExp) => {
    const result = await mcp.tool(name, args);
    assert.equal(result.isError, true, name);
    assert.match(String(result.value.error), mentions);
  };
  await refused("logs", { since: "not a time!" }, /mark name, epoch ms or an ISO time/);
  await refused("logs", { cursor: "nope" }, /invalid cursor: nope/);
  await refused("patterns", { cursor: "1:2:3" }, /invalid cursor: 1:2:3/);
  await refused("incidents", { cursor: "x" }, /invalid cursor: x/);
  await refused("incident", { id: 1, part: "context", cursor: "x" }, /invalid cursor: x/);
  await refused("export", { out: "/tmp/x.jsonl" }, /inside the project root/);
  await refused("export", { out: "missing/x.jsonl" }, /its folder doesn't exist/);
  await assert.rejects(status(root), DaemonNotRunningError);

  const unknown = await mcp.request("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknown.error?.code, -32602);

  const fine = await mcp.tool("noise");
  assert.equal(fine.isError, false);
});

test("the export tool writes owner-only under the root and refuses paths out of it that the CLI may still take", async (t) => {
  const { root } = await feedApp();
  const outside = await mkdtemp(join(tmpdir(), "hindwatch-outside-"));
  await symlink(outside, join(root, "linked"));
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
    await rm(outside, { recursive: true, force: true });
  });

  const written = await mcp.tool("export", { out: "window.jsonl" });
  assert.equal(written.isError, false, written.text);
  assert.equal(written.value.out, join(root, "window.jsonl"));
  assert.equal((await stat(join(root, "window.jsonl"))).mode & 0o777, 0o600);

  for (const [out, reason] of [
    ["linked/escape.jsonl", /its folder resolves outside the project root/],
    [join(outside, "abs.jsonl"), /inside the project root, without "\.\."/],
    ["../escape.jsonl", /without "\.\."/],
    ["missing/x.jsonl", /its folder doesn't exist/],
  ] as const) {
    const refused = await mcp.tool("export", { out });
    assert.equal(refused.isError, true, out);
    assert.deepEqual(Object.keys(refused.value).sort(), ["code", "error"], refused.text);
    assert.equal(refused.value.code, INVALID_PATH);
    assert.match(String(refused.value.error), reason);
  }
  assert.deepEqual(await readdir(outside), []);

  const cli = await runCli(root, ["export", "--out", join(outside, "abs.jsonl")]);
  assert.equal(cli.code, 0, cli.stdout);
  assert.equal(JSON.parse(cli.stdout).out, join(outside, "abs.jsonl"));
  assert.equal((await stat(join(outside, "abs.jsonl"))).mode & 0o777, 0o600);
});

test("stdout carries only JSON-RPC, whatever the daemon writes to its log", async (t) => {
  const { root, append } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  await mcp.tool("status");
  await appendFile(daemonPaths(root).log, "junk that is not JSON\n{\"half\":\n");
  await append({ msg: "hello from the app" });
  await mcp.tool("wait_for", { text: "hello from the app", timeoutMs: 5_000 });
  await appendFile(daemonPaths(root).log, "more junk\n");
  await mcp.tool("logs");

  assert.ok(mcp.lines.length > 0);
  for (const line of mcp.lines) {
    const message = JSON.parse(line) as Message;
    assert.equal(message.jsonrpc, "2.0", line);
  }
});

test("a subscribed client is told about incidents and can read them as resources", async (t) => {
  const { root, append } = await feedApp({
    plugins: [{ module: FEED_PLUGIN, options: { file: "feed.jsonl" } }, { module: CRASH_DETECTOR_PLUGIN }],
  });
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  await mcp.request("resources/subscribe", { uri: "incident://1" });
  await mcp.request("resources/subscribe", { uri: "incident://2" });
  await append({ level: "error", msg: "TypeError: boom", attrs: { exception: true } });
  await eventually(() => notified(mcp.messages, "notifications/resources/updated", "incident://1"), "incident 1 to be pushed");
  assert.ok(notified(mcp.messages, "notifications/resources/list_changed"));

  const listed = (await mcp.request("resources/list")).result!.resources as { uri: string }[];
  assert.deepEqual(listed.map((resource) => resource.uri), ["incident://1"]);
  const read = (await mcp.request("resources/read", { uri: "incident://1" })).result!.contents as { text: string }[];
  const detail = JSON.parse(read[0]!.text) as { id: number; kind: string };
  assert.equal(detail.id, 1);
  assert.equal(detail.kind, "crash");

  await mcp.request("resources/unsubscribe", { uri: "incident://1" });
  const seen = mcp.messages.length;
  await append({ level: "error", msg: "TypeError: boom", attrs: { exception: true } });
  await eventually(async () => ((await mcp.tool("incident", { id: 1 })).value.count as number) === 2, "incident 1 to repeat");
  await append({ level: "error", msg: "RangeError: another one", attrs: { exception: true } });
  await eventually(() => notified(mcp.messages.slice(seen), "notifications/resources/updated", "incident://2"), "incident 2, still subscribed, to be pushed");
  assert.equal(notified(mcp.messages.slice(seen), "notifications/resources/updated", "incident://1"), false);
});

test("the prompts chain mark, reproduce, then expect", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  const text = async (name: string, args: Record<string, string>) => {
    const result = (await mcp.request("prompts/get", { name, arguments: args })).result!;
    return (result.messages as { content: { text: string } }[])[0]!.content.text;
  };
  const debug = await text("debug-this-crash", { symptom: "red screen on login" });
  assert.match(debug, /red screen on login/);
  assert.ok(debug.indexOf("mark") < debug.indexOf("reproduce") && debug.indexOf("reproduce") < debug.indexOf("incident on"));
  const verify = await text("verify-my-fix", { error: "TypeError: boom" });
  assert.ok(verify.indexOf("mark") < verify.indexOf("repeat") && verify.indexOf("repeat") < verify.indexOf("expect"));
  assert.match(verify, /expect "absent", text "TypeError: boom" and since "fix"/);

  const bad = await mcp.request("prompts/get", { name: "verify-my-fix", arguments: {} });
  assert.notEqual(bad.error, undefined);
  await assert.rejects(status(root), DaemonNotRunningError);
});

test("stdin EOF ends the MCP process and leaves the daemon up under its idle rules", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(() => discardProject(root));

  await mcp.tool("status");
  assert.equal((await status(root)).attachedClients, 1);
  mcp.end();
  assert.equal(await mcp.exited, 0);
  assert.equal(mcp.stderr(), "");

  await eventually(async () => (await status(root)).attachedClients === 0, "the attachment to close");
  await call(root, "status");
  const ensured = await ensureDaemon(root);
  assert.equal(ensured.started, false);
});

test("a request still running at stdin EOF is answered before the process exits", async (t) => {
  const { root } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(() => discardProject(root));

  const exported = mcp.request("tools/call", { name: "export", arguments: { out: "window.jsonl" } });
  mcp.end();
  const reply = await exported;
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  const result = reply.result as unknown as ToolResult;
  assert.equal(result.isError, undefined, result.content[0]!.text);
  const summary = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal(summary.out, join(root, "window.jsonl"));
  assert.deepEqual(summary.daemon, { started: true, note: "daemon (re)started: history begins now" });
  assert.equal(await mcp.exited, 0);
  assert.equal(mcp.stderr(), "");
  assert.equal((await stat(join(root, "window.jsonl"))).mode & 0o777, 0o600);
});

test("wait_for/expect/mute/unmute/noise append a context companion by default, honor context:false, and stay in budget", async (t) => {
  const { root, append } = await feedApp();
  const mcp = await mcpClient(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  await mcp.tool("status");
  await mcp.tool("mark", { name: "before" });
  await append(
    { pid: 1, level: "error", msg: "login failed A" },
    { pid: 1, level: "error", msg: "login failed B" },
    { pid: 1, msg: "ready for companion" },
  );
  // since=mark so a second wait_for can still see the buffered match (no since = tip-only).
  const waited = await mcp.tool("wait_for", { text: "ready for companion", since: "before", timeoutMs: 5_000 });
  assert.equal(waited.isError, false, waited.text);
  assert.equal(typeof (waited.value.context as { events?: number } | undefined)?.events, "number");
  assert.ok(waited.text.length <= 8_000, `default wait_for over budget: ${waited.text.length}`);

  const opted = await mcp.tool("wait_for", { text: "ready for companion", since: "before", timeoutMs: 5_000, context: false });
  assert.equal(opted.isError, false, opted.text);
  assert.equal(opted.value.context, undefined);

  const held = await mcp.tool("expect", { expect: "present", text: "ready for companion", budget: 2_000 });
  assert.equal(held.isError, false, held.text);
  assert.equal(typeof (held.value.context as { events?: number } | undefined)?.events, "number");
  assert.ok(held.text.length <= 2_000, `expect over budget: ${held.text.length}`);

  const expectOff = await mcp.tool("expect", { expect: "present", text: "ready for companion", context: false });
  assert.equal(expectOff.value.context, undefined);

  const patterns = await mcp.tool("patterns", { budget: 100_000 });
  const ids = (patterns.value.patterns as { id: string }[]).map((p) => p.id);
  assert.ok(ids.length >= 2, "need two patterns to mute/unmute");
  const muted = await mcp.tool("mute", { patternIds: ids.slice(0, 2) });
  assert.equal(muted.isError, false, muted.text);
  assert.equal(typeof (muted.value.context as { events?: number } | undefined)?.events, "number");
  const top = (muted.value.context as { top?: { id: string; count: number }[] }).top;
  assert.ok(Array.isArray(top) && top.length >= 1, "noise-kind companion should carry top patterns");
  assert.ok(muted.text.length <= 8_000);

  const listed = await mcp.tool("noise");
  assert.equal(listed.isError, false, listed.text);
  assert.equal(typeof (listed.value.context as { events?: number } | undefined)?.events, "number");
  assert.ok(((listed.value.context as { top?: unknown[] }).top ?? []).length >= 1);
  const ruleIds = (listed.value.rules as { id: string }[]).map((r) => r.id);
  assert.ok(ruleIds.length >= 2);

  const noiseOff = await mcp.tool("noise", { context: false });
  assert.equal(noiseOff.value.context, undefined);

  const unmuted = await mcp.tool("unmute", { ruleId: ruleIds[0]! });
  assert.equal(unmuted.isError, false, unmuted.text);
  assert.equal(typeof (unmuted.value.context as { events?: number } | undefined)?.events, "number");
  const unmuteOff = await mcp.tool("unmute", { ruleId: ruleIds[1]!, context: false });
  assert.equal(unmuteOff.isError, false, unmuteOff.text);
  assert.equal(unmuteOff.value.context, undefined);
});

test("the doctor tool is the CLI's doctor: the same report, an error when the CLI exits 1, and no daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-doctor-mcp-"));
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as { port: number };
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const env = {
    ...bareEnv(),
    PATH: `${fileURLToPath(new URL("./bin-doctor", import.meta.url))}${delimiter}${process.env.PATH ?? ""}`,
    ANDROID_ADB_SERVER_PORT: String(port),
    DOCTOR_LOG: join(root, "calls.log"),
  };
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: [{ module: REACT_NATIVE_PLUGIN, options: { port } }] }));
  const mcp = await mcpClient(root, env);
  t.after(async () => {
    mcp.kill();
    await rm(root, { recursive: true, force: true });
  });

  const shape = (report: Record<string, unknown>) => (report.checks as { name: string; ok: boolean; required: boolean }[]).map((c) => [c.name, c.ok, c.required]);
  const failing = await mcp.tool("doctor");
  const cli = await runCli(root, ["doctor"], { env });
  assert.deepEqual([failing.isError, failing.value.ok, cli.code], [true, false, 1]);
  assert.deepEqual(shape(failing.value), shape(JSON.parse(cli.stdout) as Record<string, unknown>));

  await writeFile(join(root, "a-source.js"), IDLE_SOURCE_PLUGIN);
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: ["./a-source.js"] }));
  const passing = await mcp.tool("doctor");
  assert.deepEqual([passing.isError, passing.value.ok], [false, true]);
  await assert.rejects(status(root), DaemonNotRunningError);
});
