import assert from "node:assert/strict";
import createFixturePlugin from "@hindwatch/plugin-fixture";
import { Clocks, EventBuffer, Ingest, PluginHost, Redactor } from "@hindwatch/core";
import { SKEW, SKEWED_LOG, TRUE_ORDER } from "./helpers.js";
import { test } from "./timed.js";

async function replay(clockSkewMs: Record<string, number>) {
  const clocks = new Clocks();
  const buffer = new EventBuffer({ maxEvents: 1_000, maxEventsPerSource: 1_000, maxAgeMs: 60_000 });
  const host = new PluginHost({
    root: "/",
    ingest: new Ingest({ redactor: new Redactor(), clocks, buffer }),
    clocks,
    log: () => {},
  });
  host.add(await createFixturePlugin({ file: SKEWED_LOG, clockSkewMs }));
  await host.startAll();
  // Snapshot is arrival order; the timeline sorts on mapped device time.
  return [...buffer.snapshot()].sort((a, b) => a.ts - b.ts || a.id - b.id);
}

test("a skewed-clock replay comes out in true order", async () => {
  const events = await replay(SKEW);
  const synced = events.filter((e) => !e.estimated).map((e) => e.msg);
  assert.deepEqual(synced, TRUE_ORDER);
});

test("events without device time or clock offset fall back to host time, flagged estimated", async () => {
  const events = await replay(SKEW);
  const estimated = events.filter((e) => e.estimated);
  assert.deepEqual(estimated.map((e) => e.msg).sort(), ["no clock sample", "no device time"]);
  for (const e of estimated) assert.equal(e.ts, e.hostTs);
});

test("without the clock offsets, arrival skew would scramble the order", async () => {
  // Guards the fixture itself: it must actually be out of order before normalization.
  const events = await replay({});
  const byDeviceTime = [...events].filter((e) => e.deviceTs !== null).sort((a, b) => a.deviceTs! - b.deviceTs!);
  assert.notDeepEqual(byDeviceTime.filter((e) => e.msg.startsWith("step")).map((e) => e.msg), TRUE_ORDER);
});

test("an app restart with a new pid keeps its session", () => {
  const buffer = new EventBuffer({ maxEvents: 10, maxEventsPerSource: 10, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const base = { source: "android", deviceId: "emu-1", app: "com.x", level: "info", msg: "hi" } as const;
  const before = ingest.ingest({ ...base, pid: 100 });
  const after = ingest.ingest({ ...base, pid: 200 });
  const otherApp = ingest.ingest({ ...base, app: "com.y", pid: 300 });
  assert.equal(before.sessionId, after.sessionId);
  assert.notEqual(before.sessionId, otherApp.sessionId);
});
