import assert from "node:assert/strict";
import createFixturePlugin from "@hindwatch/plugin-fixture";
import { FORCED_CRASH_LOG, pipeline, until } from "../../core/test/helpers.js";
import { test } from "../../core/test/timed.js";

const REPLAYED = 303;

test("with a rate, the fixture keeps replaying its events stamped now, then stops", async () => {
  const { host, buffer } = pipeline(() => {});
  host.add(await createFixturePlugin({ file: FORCED_CRASH_LOG, clockSkewMs: { "android-a": 0 }, rate: { eventsPerSecond: 1_000, seconds: 0.3 } }));
  const startedAt = Date.now();
  await host.startAll();
  await until(() => buffer.size >= REPLAYED + 300, "the paced events", 5_000);
  const paced = buffer.snapshot().slice(REPLAYED);
  assert.ok(paced.every((e) => e.ts >= startedAt - 1_000), "stamped now, not at the recorded time");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(buffer.size, REPLAYED + 300, "no more once the duration is over");
  await host.stopAll();
});

test("rate options are validated", () => {
  assert.throws(() => createFixturePlugin({ file: "x", rate: { eventsPerSecond: 0, seconds: 1 } }), /positive eventsPerSecond/);
});
