import assert from "node:assert/strict";
import { ClockTracker, Clocks, type ClockSample } from "@hindwatch/core";
import { test } from "./timed.js";

/** Lets the tracker's async reading settle after a mocked tick. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function tracker(intervalMs: number, readings: number[]) {
  const samples: ClockSample[] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const clock = new ClockTracker({
    read: async () => {
      const value = readings[reads++];
      if (value === undefined) throw new Error("device gone");
      return value;
    },
    onSample: (sample) => samples.push(sample),
    intervalMs,
    onError: (error) => errors.push(error),
  });
  return { clock, samples, errors, reads: () => reads };
}

test("the clock is re-measured on attach and then periodically", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { clock, samples, reads } = tracker(60_000, [1_000, 2_000, 3_000]);
  await clock.resample();
  assert.equal(reads(), 1);
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(reads(), 1);
  t.mock.timers.tick(1);
  await settle();
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(samples.map((s) => s.deviceTs), [1_000, 2_000, 3_000]);
  clock.stop();
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(reads(), 3);
});

test("a reattach measures at once and restarts the period", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { clock, reads } = tracker(60_000, [1, 2, 3]);
  await clock.resample();
  t.mock.timers.tick(50_000);
  await clock.resample();
  assert.equal(reads(), 2);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(reads(), 2, "the old period must not fire after a reattach");
  t.mock.timers.tick(50_000);
  await settle();
  assert.equal(reads(), 3);
  clock.stop();
});

test("a failed reading is reported and keeps the last offset", async () => {
  const { clock, samples, errors } = tracker(60_000, []);
  assert.equal(await clock.resample(), false);
  clock.stop();
  assert.equal(samples.length, 0);
  assert.equal(errors.length, 1);
});

test("a successful reading resolves true", async () => {
  const { clock, samples } = tracker(60_000, [1_000]);
  assert.equal(await clock.resample(), true);
  clock.stop();
  assert.equal(samples.length, 1);
});

test("clearSample drops the offset so later convert falls back to receipt", () => {
  const clocks = new Clocks();
  clocks.setSample("s1", { deviceTs: 1_000, hostTs: 5_000 });
  assert.deepEqual(clocks.toHost("s1", 2_000, 9_999), { ts: 6_000, estimated: false });
  clocks.clearSample("s1");
  assert.deepEqual(clocks.toHost("s1", 2_000, 9_999), { ts: 9_999, estimated: true });
});
