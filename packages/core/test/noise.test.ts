import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import {
  Clocks,
  CONFIG_FILE,
  EventBuffer,
  Ingest,
  MUTE_REFRESH_MS,
  NOISE_FILE,
  NoiseFile,
  patternId,
  Redactor,
  ruleId,
} from "@hindwatch/core";
import { test } from "./timed.js";

const roots: string[] = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-noise-"));
  roots.push(root);
  // Mute lives in config; give every project a startable-looking config shell.
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify({ plugins: [] }, null, 2)}\n`);
  return root;
}

function events() {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  for (const [source, msg] of [["js", "poll 1"], ["android", "poll 2"], ["js", "tap"]] as const) {
    ingest.ingest({ source, deviceId: "d", app: "a", level: "info", msg });
  }
  return buffer.snapshot();
}

test("no mute rules mutes nothing", async () => {
  const noise = new NoiseFile(await project());
  assert.deepEqual(await noise.rules(), []);
  assert.equal(events().filter(await noise.filter()).length, 0);
});

test("a rule mutes its template from one source, or from every source without one", async () => {
  const root = await project();
  const noise = new NoiseFile(root);
  await noise.mute({ template: "poll {num}", source: "js" });
  assert.deepEqual(events().filter(await noise.filter()).map((e) => e.msg), ["poll 1"]);
  await noise.mute({ template: "poll {num}" });
  await noise.mute({ template: "poll {num}" });
  assert.deepEqual(events().filter(await noise.filter()).map((e) => e.msg), ["poll 1", "poll 2"]);
  const config = JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8"));
  assert.deepEqual(config.mute, [{ template: "poll {num}", source: "js" }, { template: "poll {num}" }]);
  assert.deepEqual(config.plugins, []);
  await noise.unmute(patternId("js", "poll {num}"));
  assert.deepEqual(await noise.rules(), [{ template: "poll {num}" }]);
});

test("a broken mute section is reported on rules, but peek keeps last good", async () => {
  const root = await project();
  const logs: string[] = [];
  let now = Date.now();
  const noise = new NoiseFile(root, { log: (m) => logs.push(m), now: () => now });
  const path = join(root, CONFIG_FILE);
  await noise.mute({ template: "tap" });
  assert.equal(noise.peekFilter()({ source: "js", msg: "tap" }), true);

  // Half-written config: peek keeps last-good, never throws; rules() still errors clearly.
  await writeFile(path, '{"plugins":[],"mute":[');
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  now += MUTE_REFRESH_MS + 1;
  assert.equal(noise.peekFilter()({ source: "js", msg: "tap" }), true);
  assert.equal(noise.peekFilter()({ source: "js", msg: "other" }), false);
  assert.match(noise.warning() ?? "", /mute rules invalid, using last good/);
  await assert.rejects(noise.rules(), /hindwatch\.config\.json|JSON|mute/);
  assert.equal(logs.filter((l) => /mute rules invalid/.test(l)).length, 1, "log once, not per event");

  // Another peek while still bad must not re-log.
  now += MUTE_REFRESH_MS + 1;
  assert.equal(noise.peekFilter()({ source: "js", msg: "tap" }), true);
  assert.equal(logs.filter((l) => /mute rules invalid/.test(l)).length, 1);

  await writeFile(path, JSON.stringify({ plugins: [], mute: [{ template: "" }] }, null, 2));
  await utimes(path, new Date(), new Date(Date.now() + 10_000));
  now += MUTE_REFRESH_MS + 1;
  await assert.rejects(noise.rules(), /mute\[0\].*non-empty string/);
  assert.equal(noise.peekFilter()({ source: "js", msg: "tap" }), true);
});

test("concurrent mutes are all kept", async () => {
  const noise = new NoiseFile(await project());
  await Promise.all(["a", "b", "c", "d"].map((template) => noise.mute({ template })));
  assert.deepEqual((await noise.rules()).map((r) => r.template).sort(), ["a", "b", "c", "d"]);
});

test("muteMany keeps each rule once in one write", async () => {
  const root = await project();
  const noise = new NoiseFile(root);
  const rules = await noise.muteMany([
    { template: "a", source: "js" },
    { template: "b" },
    { template: "a", source: "js" },
  ]);
  assert.deepEqual(rules, [{ template: "a", source: "js" }, { template: "b" }]);
  assert.deepEqual(JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8")).mute, [
    { template: "a", source: "js" },
    { template: "b" },
  ]);
});

test("subsystem and category rules mute at filter and refresh peekFilter", async () => {
  const root = await project();
  const noise = new NoiseFile(root);
  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.apple.UIKit" } }), false);
  await noise.mute({ subsystem: "com.apple.UIKit" });
  await noise.mute({ category: "BackgroundTask", source: "ios-sim" });
  const filter = noise.peekFilter();
  assert.equal(filter({ source: "ios-sim", msg: "Ending background task", attrs: { subsystem: "com.apple.UIKit", category: "foo" } }), true);
  assert.equal(filter({ source: "ios-sim", msg: "task", attrs: { category: "BackgroundTask" } }), true);
  assert.equal(filter({ source: "android", msg: "task", attrs: { category: "BackgroundTask" } }), false);
  assert.equal(filter({ source: "ios-sim", msg: "other", attrs: { subsystem: "other" } }), false);
  const sub = (await noise.rules()).find((r) => r.subsystem !== undefined)!;
  await noise.unmute(ruleId(sub));
  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.apple.UIKit" } }), false);
  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "task", attrs: { category: "BackgroundTask" } }), true);
});

test("subsystem+category rule ANDs both attrs", async () => {
  const root = await project();
  const noise = new NoiseFile(root);
  await noise.mute({ subsystem: "com.apple.UIKit", category: "BackgroundTask" });
  const filter = noise.peekFilter();
  assert.equal(
    filter({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.apple.UIKit", category: "BackgroundTask" } }),
    true,
  );
  assert.equal(
    filter({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.apple.UIKit", category: "other" } }),
    false,
    "subsystem alone must not match a scoped rule",
  );
  assert.equal(
    filter({ source: "ios-sim", msg: "x", attrs: { category: "BackgroundTask" } }),
    false,
  );
  const rule = (await noise.rules())[0]!;
  assert.deepEqual(rule, { subsystem: "com.apple.UIKit", category: "BackgroundTask" });
  assert.equal(typeof ruleId(rule), "string");
  assert.ok(ruleId(rule).length > 0);
});

test("hand-edit of config mute refreshes peekFilter without calling rules", async () => {
  const root = await project();
  let now = Date.now();
  const noise = new NoiseFile(root, { now: () => now });
  const path = join(root, CONFIG_FILE);
  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.hand.Edit" } }), false);

  const doc = JSON.parse(await readFile(path, "utf8"));
  doc.mute = [{ subsystem: "com.hand.Edit" }];
  await writeFile(path, JSON.stringify(doc, null, 2));
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  now += MUTE_REFRESH_MS + 1;

  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.hand.Edit" } }), true);
  assert.equal(noise.peekFilter()({ source: "ios-sim", msg: "x", attrs: { subsystem: "com.other" } }), false);
});

test("legacy noise file migrates into config and is removed", async () => {
  const root = await project();
  await writeFile(join(root, NOISE_FILE), JSON.stringify({ mute: [{ template: "legacy {num}" }] }, null, 2));
  const logs: string[] = [];
  const noise = new NoiseFile(root, { log: (m) => logs.push(m) });
  assert.deepEqual(await noise.rules(), [{ template: "legacy {num}" }]);
  const config = JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8"));
  assert.deepEqual(config.mute, [{ template: "legacy {num}" }]);
  await assert.rejects(readFile(join(root, NOISE_FILE)), /ENOENT/);
  assert.ok(logs.some((l) => /migrated mute rules/.test(l)));
});
