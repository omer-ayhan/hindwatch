import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { promisify } from "node:util";
import { CONFIG_FILE } from "@hindwatch/core";
import { CLI, CRASH_DETECTOR_PLUGIN, discardProject, FIXTURE_PLUGIN, FORCED_CRASH_LOG, processesMatching, runCli } from "./helpers.js";
import { test } from "./timed.js";

const run = promisify(execFile);
const roots: string[] = [];

after(async () => {
  for (const root of roots) await discardProject(root);
});

/** The fixture app: a feed polling in a loop, a failed request, then a forced crash that repeats once. */
async function crashingApp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-cli-")));
  roots.push(root);
  const config = {
    plugins: [{ module: FIXTURE_PLUGIN, options: { file: FORCED_CRASH_LOG, clockSkewMs: { "android-a": 0 } } }, { module: CRASH_DETECTOR_PLUGIN }],
  };
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(config));
  return root;
}

/** Runs the CLI and returns its stdout, unparsed, so its size can be held to the budget. */
async function cli(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, ...args, "--root", root], {
    env: { ...process.env, HINDWATCH_CLIENT: "cli-test" },
  });
  return stdout.trimEnd();
}

test("done when: a forced crash in the fixture app is a single incident that fits the budget", async () => {
  const root = await crashingApp();
  const listed = JSON.parse(await cli(root, "incidents"));
  assert.equal(listed.incidents.length, 1);
  const [incident] = listed.incidents;
  assert.equal(incident.kind, "crash");
  assert.equal(incident.title, "TypeError: Cannot read property 'name' of undefined");
  assert.equal(incident.count, 2);
  for (const budget of [1_000, 2_000, 8_000]) {
    const out = await cli(root, "incident", String(incident.id), "--budget", String(budget));
    assert.ok(out.length <= budget, `--budget ${budget} printed ${out.length} chars`);
    const detail = JSON.parse(out);
    assert.equal(detail.id, incident.id);
    assert.equal(detail.title, incident.title);
  }
  const detail = JSON.parse(await cli(root, "incident", String(incident.id)));
  assert.deepEqual(detail.stack.frames, ["onPress (/app/src/screens/Profile.tsx:42:19)"]);
  assert.equal(detail.code.line, 42);
  assert.equal(detail.firstError.msg, "profile request failed: 500 Internal Server Error");
  assert.equal(detail.context.patterns[0].template, "GET /api/feed?page={num} {num} in {num}ms");
  assert.equal(detail.context.patterns[0].count, 300);
  const stack = JSON.parse(await cli(root, "incident", String(incident.id), "--part", "stack", "--budget", "1000"));
  assert.ok(stack.frames.length > 1 && stack.omitted > 0);
});

test("patterns collapse the feed, a mute hides it from logs and patterns, and unmute brings it back", async () => {
  const root = await crashingApp();
  const patterns = JSON.parse(await cli(root, "patterns"));
  const [feed] = patterns.patterns;
  assert.equal(feed.count, 300);
  assert.equal(feed.template, "GET /api/feed?page={num} {num} in {num}ms");
  const only = JSON.parse(await cli(root, "logs", "--pattern", feed.id, "--budget", "100000"));
  assert.equal(only.events.length, 300);

  const muted = JSON.parse(await cli(root, "mute", feed.id));
  assert.equal(muted.muted.id, feed.id);
  assert.equal(muted.rules, undefined);
  const config = JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8"));
  assert.deepEqual(config.mute, [{ template: feed.template, source: "fixture" }]);
  const quiet = JSON.parse(await cli(root, "logs", "--budget", "100000"));
  assert.equal(quiet.muted, 300);
  assert.ok(quiet.events.every((e: { msg: string }) => !e.msg.startsWith("GET /api/feed")));
  assert.ok(quiet.events.some((e: { attrs?: { incident?: unknown } }) => e.attrs?.incident !== undefined), "noise never hides an incident");
  assert.equal(JSON.parse(await cli(root, "patterns")).muted, 300);
  assert.equal(JSON.parse(await cli(root, "logs", "--include-muted", "--budget", "100000")).muted, 0);

  const unmuted = JSON.parse(await cli(root, "unmute", muted.muted.id));
  assert.equal(unmuted.unmuted, muted.muted.id);
  assert.equal(unmuted.rules, undefined);
  assert.equal(JSON.parse(await cli(root, "logs", "--budget", "100000")).muted, 0);
  assert.deepEqual(JSON.parse(await cli(root, "noise")).rules, []);
});

test("every read stays within --budget on stdout, the restart note included", async () => {
  const root = await crashingApp();
  for (const args of [["logs"], ["patterns"], ["incidents"]]) {
    const out = await cli(root, ...args, "--budget", "1200");
    assert.ok(out.length <= 1_200, `${args.join(" ")} printed ${out.length} chars`);
  }
});

test("start refuses a root it can't serve, says why, and leaves no daemon; status still names the root", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-home-")));
  roots.push(home);
  const env = { env: { ...process.env, HOME: home, HINDWATCH_CLIENT: "cli-test" } };
  const refused = await runCli(home, ["start"], env);
  assert.deepEqual([refused.code, JSON.parse(refused.stdout).error], [1, `${home} is your home folder, with no ${CONFIG_FILE} or package.json; run hindwatch from your project folder or pass --root <dir>`]);

  await writeFile(join(home, "package.json"), "{ nope");
  const broken = await runCli(home, ["start"], env);
  assert.equal(broken.code, 1);
  assert.match(JSON.parse(broken.stdout).error, new RegExp(`^${join(home, "package.json")} doesn't parse: `));

  await writeFile(join(home, "package.json"), "{}");
  const nothing = await runCli(home, ["start"], env);
  assert.equal(nothing.code, 1);
  assert.match(JSON.parse(nothing.stdout).error, /^nothing to capture in .*; add a source to hindwatch\.config\.json$/);

  await writeFile(join(home, CONFIG_FILE), JSON.stringify({ plugins: [CRASH_DETECTOR_PLUGIN] }));
  const detectorOnly = await runCli(home, ["start"], env);
  assert.equal(detectorOnly.code, 1);
  assert.match(JSON.parse(detectorOnly.stdout).error, /^nothing to capture in .* has no source, only plugins without one \(crash-detector\); add a source to hindwatch\.config\.json$/);

  assert.deepEqual(JSON.parse((await runCli(home, ["status"], env)).stdout), { running: false, root: home });
  assert.deepEqual(await processesMatching(`__daemon --root ${home}`), []);
});

test("the README's MCP setup lines are the ones --help prints", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-test-")));
  roots.push(root);
  const help = (await runCli(root, ["--help"])).stdout;
  const text = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
  const jsonBlocks = [...text.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((block) => JSON.stringify(JSON.parse(block[1]!)));
  const readme = [...text.split("\n"), ...jsonBlocks];
  const setup = (client: string, prefix = "") => new RegExp(`^  ${client} +${prefix}(.+)$`, "m").exec(help)?.[1];
  const lines = [setup("Cursor", "\\.cursor/mcp\\.json: "), setup("Claude Code"), setup("Codex")];
  for (const line of lines) {
    assert.ok(line !== undefined, "--help has an mcp setup line per client");
    assert.ok(readme.includes(line), `README.md has the line ${line}`);
  }
  assert.match(lines[0]!, /"--root","\$\{workspaceFolder\}"/);
});

test("<command> -h prints that command's own options, filters and output flags, and a command with none prints the command list", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-test-")));
  roots.push(root);
  const help = async (...args: string[]) => {
    const run = await runCli(root, args);
    assert.equal(run.code, 0, `${args.join(" ")} exits 0`);
    return run.stdout;
  };
  const [logs, patterns, incident, exported, status, stop, exit, top] = await Promise.all([
    help("logs", "-h"),
    help("patterns", "--help"),
    help("incident", "-h"),
    help("export", "-h"),
    help("status", "-h"),
    help("stop", "-h"),
    help("exit", "-h"),
    help("-h"),
  ]);
  const flags = (text: string) => [...text.matchAll(/^ {2}(--[a-z-]+)/gm)].map((match) => match[1]);
  const filters = ["--since-id", "--since", "--until", "--source", "--level", "--order", "--app", "--include-muted", "--stale"];
  const global = ["--root", "--client"];
  assert.match(logs, /^usage: hindwatch logs \[filters\] \[options\]\n\nread the unified timeline\n/);
  assert.deepEqual(flags(logs), ["--since-last", "--pattern", "--cursor", ...filters, "--budget", "--pretty", ...global]);
  assert.deepEqual(flags(patterns), ["--cursor", ...filters, "--budget", "--pretty", ...global]);
  assert.deepEqual(flags(incident), ["--part", "--cursor", "--budget", "--pretty", ...global]);
  assert.match(incident, /--part <trigger\|stack\|code\|context>/);
  assert.deepEqual(flags(exported), ["--out", "--format", "--follow", ...filters, "--pretty", ...global], "export prints a summary, not a budgeted answer");
  assert.equal(exit, stop, "exit is stop");
  assert.equal(status, top);
  assert.deepEqual(await processesMatching(`__daemon --root ${root}`), []);
});

test("--help and -h print the command list without starting a daemon", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hindwatch-test-")));
  roots.push(root);
  for (const flag of ["--help", "-h"]) {
    const run = await runCli(root, [flag]);
    assert.equal(run.code, 0);
    for (const command of ["start", "status", "logs", "incidents", "export", "wait-for"]) assert.match(run.stdout, new RegExp(`^  ${command}\\b`, "m"));
    for (const client of ["Cursor", "Claude Code", "Codex"]) assert.match(run.stdout, new RegExp(`^  ${client} .*npx.*-y.*hindwatch.*mcp`, "m"));
  }
  assert.deepEqual(await processesMatching(`__daemon --root ${root}`), []);
});
