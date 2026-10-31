import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { MAX_TOOL_DESCRIPTION_CHARS } from "../src/mcp.js";
import { CLI, bareEnv, discardProject, feedApp } from "./helpers.js";
import { test } from "./timed.js";

interface Message {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

async function listTools(root: string): Promise<{
  instructions: string;
  tools: { name: string; description: string }[];
  kill: () => void;
}> {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "mcp", "--root", root], {
    env: bareEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, (message: Message) => void>();
  let pending = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line) as Message;
      if (message.id !== undefined && message.method === undefined) waiting.get(message.id)?.(message);
    }
  });
  const write = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = ++nextId;
    const answered = new Promise<Message>((resolve) => waiting.set(id, resolve));
    write({ id, method, params });
    return answered;
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tool-description-quality", version: "0" },
  });
  write({ method: "notifications/initialized" });
  const listed = await request("tools/list");
  return {
    instructions: String(initialized.result?.instructions ?? ""),
    tools: (listed.result!.tools as { name: string; description: string }[]) ?? [],
    kill: () => child.kill(),
  };
}

test("MCP tool descriptions stay under the hard max and state when not to use them", async (t) => {
  const { root } = await feedApp();
  const mcp = await listTools(root);
  t.after(async () => {
    mcp.kill();
    await discardProject(root);
  });

  assert.equal(MAX_TOOL_DESCRIPTION_CHARS, 280);
  assert.ok(mcp.instructions.length > 0, "server instructions missing from initialize");
  assert.ok(mcp.instructions.length <= 400, `INSTRUCTIONS ${mcp.instructions.length} chars (soft max 400)`);
  assert.match(mcp.instructions, /mark[\s\S]*expect|mark → .*expect/i);
  assert.match(mcp.instructions, /incidents/i);
  assert.match(mcp.instructions, /[Nn]ever.*unfiltered logs/);

  assert.ok(mcp.tools.length >= 14);
  let worst = { name: "", len: 0 };
  for (const tool of mcp.tools) {
    assert.match(tool.description, /^Use /, tool.name);
    assert.match(tool.description, /Not for /, `${tool.name} missing when-not`);
    assert.ok(
      tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS,
      `${tool.name} description is ${tool.description.length} chars (max ${MAX_TOOL_DESCRIPTION_CHARS})`,
    );
    if (tool.description.length > worst.len) worst = { name: tool.name, len: tool.description.length };
  }
  console.log(JSON.stringify({ instructions: mcp.instructions.length, worst, max: MAX_TOOL_DESCRIPTION_CHARS }));
});
