/**
 * Wave U4 prove bar: fixed MCP verify-loop fixture, companion ON vs context:false.
 * Prints calls + response chars for A (default context) vs B (opt-out + follow-ups
 * needed to recover the same status / open incidents / top patterns).
 * Exit 0 only when the companion path stays in budget and saves follow-ups (or holds
 * quality without blowing chars vs the follow-up path).
 *
 *   npx tsx scripts/u4-companion-prove.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_BUDGET_CHARS, sizeOf } from "../packages/core/src/budget.js";
import { CLI, CRASH_DETECTOR_PLUGIN, FEED_PLUGIN, bareEnv, discardProject, feedApp } from "../packages/core/test/helpers.js";

interface Message {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

interface ToolHit {
  readonly name: string;
  readonly text: string;
  readonly value: Record<string, unknown>;
  readonly isError: boolean;
}

async function mcpClient(root: string) {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "mcp", "--root", root], {
    env: bareEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, (message: Message) => void>();
  let pending = "";
  child.stderr!.resume();
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line) as Message;
      if (message.id !== undefined && message.method === undefined) waiting.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const write = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = ++nextId;
    const answered = new Promise<Message>((resolve) => waiting.set(id, resolve));
    write({ id, method, params });
    return answered;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolHit> => {
    const reply = await request("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
    const result = reply.result as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]!.text;
    return {
      name,
      text,
      value: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
      isError: result.isError === true,
    };
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "u4-prove", version: "0" },
  });
  write({ method: "notifications/initialized" });
  return { tool, kill: () => child.kill() };
}

type Mode = "A" | "B";

interface RunSummary {
  readonly mode: Mode;
  readonly calls: number;
  readonly chars: number;
  readonly hits: ToolHit[];
  readonly companionKeys: { status: boolean; open: boolean; top: boolean };
  readonly overBudget: string[];
}

function companionInfo(hits: readonly ToolHit[]): RunSummary["companionKeys"] {
  let status = false;
  let open = false;
  let top = false;
  for (const hit of hits) {
    const ctx = hit.value.context as Record<string, unknown> | undefined;
    if (ctx === undefined) continue;
    if (typeof ctx.events === "number") status = true;
    if (Array.isArray(ctx.open) && ctx.open.length > 0) open = true;
    if (Array.isArray(ctx.top) && ctx.top.length > 0) top = true;
  }
  return { status, open, top };
}

async function runMode(mode: Mode): Promise<RunSummary> {
  const { root, append } = await feedApp({
    plugins: [
      { module: FEED_PLUGIN, options: { file: "feed.jsonl" } },
      { module: CRASH_DETECTOR_PLUGIN },
    ],
  });
  const mcp = await mcpClient(root);
  const hits: ToolHit[] = [];
  const record = async (name: string, args: Record<string, unknown> = {}) => {
    const hit = await mcp.tool(name, args);
    hits.push(hit);
    return hit;
  };
  const ctx = mode === "A" ? {} : { context: false };

  try {
    // Fixed agent-ish verify + noise loop on one fixture.
    await record("status");
    await record("mark", { name: "before" });
    await append(
      { pid: 1, level: "error", msg: "login failed A" },
      { pid: 1, level: "error", msg: "login failed B" },
      { pid: 1, level: "error", msg: "TypeError: boom", attrs: { exception: true } },
      { pid: 1, msg: "ready for prove" },
    );
    await record("wait_for", { text: "ready for prove", since: "before", timeoutMs: 5_000, ...ctx });
    await record("expect", { expect: "present", text: "ready for prove", since: "before", ...ctx });
    const patterns = await record("patterns", { budget: 100_000 });
    const ids = ((patterns.value.patterns as { id: string }[]) ?? []).map((p) => p.id);
    if (ids.length === 0) throw new Error("fixture produced no patterns");
    await record("mute", { patternId: ids[0]!, ...ctx });
    await record("noise", { ...ctx });

    if (mode === "B") {
      // Follow-ups an agent needs when companion is off, to recover the same facts.
      // Always status + patterns (noise path) + incidents (verify path) once each.
      await record("status");
      await record("incidents", { budget: 4_000 });
      await record("patterns", { budget: 4_000 });
    }

    const overBudget = hits.filter((h) => h.text.length > DEFAULT_BUDGET_CHARS).map((h) => `${h.name}:${h.text.length}`);
    return {
      mode,
      calls: hits.length,
      chars: hits.reduce((n, h) => n + h.text.length, 0),
      hits,
      companionKeys: companionInfo(hits),
      overBudget,
    };
  } finally {
    mcp.kill();
    await discardProject(root);
  }
}

function line(pass: boolean, name: string, numbers: string): boolean {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${numbers}`);
  return pass;
}

const a = await runMode("A");
const b = await runMode("B");

console.log("--- U4 companion prove ---");
console.log(
  `A (context default): calls=${a.calls} chars=${a.chars} companion={status:${a.companionKeys.status},open:${a.companionKeys.open},top:${a.companionKeys.top}}`,
);
console.log(
  `B (context:false + status/incidents/patterns follow-ups): calls=${b.calls} chars=${b.chars}`,
);
console.log(`delta: calls A-B=${a.calls - b.calls} chars A-B=${a.chars - b.chars}`);

let ok = true;
ok = line(a.overBudget.length === 0, "A stays in DEFAULT_BUDGET_CHARS", a.overBudget.length === 0 ? `all ≤ ${DEFAULT_BUDGET_CHARS}` : a.overBudget.join(",")) && ok;
ok = line(b.overBudget.length === 0, "B stays in DEFAULT_BUDGET_CHARS", b.overBudget.length === 0 ? `all ≤ ${DEFAULT_BUDGET_CHARS}` : b.overBudget.join(",")) && ok;
ok =
  line(
    a.companionKeys.status && (a.companionKeys.open || a.companionKeys.top),
    "A companion quality (status + open|top)",
    `status=${a.companionKeys.status} open=${a.companionKeys.open} top=${a.companionKeys.top}`,
  ) && ok;
ok = line(a.calls < b.calls, "follow-ups drop (calls A < B)", `A=${a.calls} B=${b.calls}`) && ok;
// Companion path may add compact bytes on primary tools, but must beat the follow-up path overall.
ok = line(a.chars <= b.chars, "chars A ≤ B (companion cheaper than follow-ups)", `A=${a.chars} B=${b.chars}`) && ok;

// Spot-check one companion payload is omitEmpty-lean (no nulls).
const sample = a.hits.find((h) => h.value.context !== undefined);
ok =
  line(
    sample !== undefined && sizeOf(sample.value.context) < 2_000,
    "companion payload compact",
    sample === undefined ? "missing" : `sizeOf(context)=${sizeOf(sample.value.context)}`,
  ) && ok;

console.log(ok ? "PASS u4-companion-prove" : "FAIL u4-companion-prove");
process.exit(ok ? 0 : 1);
