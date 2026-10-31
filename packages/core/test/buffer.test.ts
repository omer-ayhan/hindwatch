import assert from "node:assert/strict";
import { EventBuffer, SCHEMA_VERSION, type DebugEvent } from "@hindwatch/core";
import { test } from "./timed.js";

const event = (id: number, hostTs: number, source = "s"): DebugEvent => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  ts: hostTs,
  deviceTs: null,
  hostTs,
  estimated: true,
  source,
  deviceId: "d",
  app: "a",
  sessionId: "x",
  pid: null,
  level: "info",
  msg: "",
  attrs: {},
});

test("keeps at most maxEvents, dropping the oldest", () => {
  const buffer = new EventBuffer({ maxEvents: 3, maxEventsPerSource: 3, maxAgeMs: 1e9 }, () => 0);
  for (let id = 1; id <= 5000; id++) buffer.push(event(id, 0));
  assert.deepEqual(buffer.snapshot().map((e) => e.id), [4998, 4999, 5000]);
  assert.equal(buffer.dropped, 4997);
});

test("remembers every source it was pushed, even once eviction removed them all", () => {
  const buffer = new EventBuffer({ maxEvents: 1, maxEventsPerSource: 1, maxAgeMs: 1e9 }, () => 0);
  buffer.push(event(1, 1, "first"));
  buffer.push(event(2, 2, "second"));
  assert.equal(buffer.countFor("first"), 0);
  assert.deepEqual([...buffer.seenSources], ["first", "second"]);
});

test("drops events older than maxAgeMs", () => {
  let now = 1_000;
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 500 }, () => now);
  buffer.push(event(1, 600));
  buffer.push(event(2, 900));
  now = 1_200;
  assert.deepEqual(buffer.snapshot().map((e) => e.id), [2]);
  assert.equal(buffer.dropped, 0, "expiring by age is not overflow");
});

test("reads a slice after an id without copying the buffer, and says how far eviction reached", () => {
  const buffer = new EventBuffer({ maxEvents: 5, maxEventsPerSource: 5, maxAgeMs: 1e9 }, () => 0);
  assert.equal(buffer.lastId, 0);
  assert.equal(buffer.evicted, undefined);
  for (let id = 1; id <= 8; id++) buffer.push({ ...event(id, 0), ts: id * 10 });
  assert.equal(buffer.lastId, 8);
  assert.deepEqual(buffer.evicted, { id: 3, ts: 30 });
  assert.deepEqual(buffer.after(0, 2).map((e) => e.id), [4, 5]);
  assert.deepEqual(buffer.after(6, 10).map((e) => e.id), [7, 8]);
  assert.deepEqual(buffer.after(8, 10), []);
});

test("listeners hear every push until they unsubscribe", () => {
  const buffer = new EventBuffer({ maxEvents: 5, maxEventsPerSource: 5, maxAgeMs: 1e9 }, () => 0);
  let heard = 0;
  const off = buffer.onPush(() => heard++);
  buffer.push(event(1, 0));
  buffer.push(event(2, 0));
  off();
  buffer.push(event(3, 0));
  assert.equal(heard, 2);
});

test("exposes maxAgeMs and the oldest held event", () => {
  const buffer = new EventBuffer({ maxEvents: 3, maxEventsPerSource: 3, maxAgeMs: 1_000 }, () => 0);
  assert.equal(buffer.maxAgeMs, 1_000);
  assert.equal(buffer.oldest, undefined);
  buffer.push(event(1, 0));
  buffer.push({ ...event(2, 0), ts: 20 });
  buffer.push({ ...event(3, 0), ts: 30 });
  assert.deepEqual(buffer.oldest, { id: 1, ts: 0 });
  buffer.push({ ...event(4, 0), ts: 40 });
  assert.deepEqual(buffer.oldest, { id: 2, ts: 20 });
});

test("oldest is the earliest timeline ts among held events, not the arrival head", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 1e9 }, () => 10_000);
  buffer.push(event(1, 9_900));
  buffer.push({ ...event(2, 9_950), ts: 100 });
  buffer.push({ ...event(3, 9_960), ts: 200 });
  buffer.push({ ...event(4, 9_970), ts: 9_920 });
  assert.deepEqual(buffer.snapshot().map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(buffer.oldest, { id: 2, ts: 100 });
});

test("soft per-source: alone may exceed share until global fills; under pressure over-share yields", () => {
  const buffer = new EventBuffer({ maxEvents: 10, maxEventsPerSource: 4, maxAgeMs: 1e9 }, () => 0);
  for (let id = 1; id <= 8; id++) buffer.push(event(id, 0, "ios-sim"));
  assert.equal(buffer.countFor("ios-sim"), 8, "under capacity, sim may exceed its 4-share");
  for (let id = 9; id <= 20; id++) buffer.push(event(id, 0, "ios-sim"));
  assert.equal(buffer.size, 10);
  assert.equal(buffer.countFor("ios-sim"), 10, "alone, soft share still fills global capacity");

  for (let id = 21; id <= 25; id++) buffer.push(event(id, 0, "react-native"));
  assert.equal(buffer.size, 10);
  assert.ok(buffer.countFor("react-native") >= 4, "RN grows by trimming over-share sim first");
  assert.ok(buffer.countFor("ios-sim") <= 6, "sim over-share yields under pressure");
  assert.ok(buffer.snapshot().some((e) => e.source === "react-native" && e.id === 25));
  assert.ok(buffer.snapshot().some((e) => e.source === "ios-sim"));
});

test("alone, a source may fill all of maxEvents", () => {
  const buffer = new EventBuffer({ maxEvents: 10, maxAgeMs: 1e9 }, () => 0);
  for (let id = 1; id <= 20; id++) buffer.push(event(id, 0, "ios-sim"));
  assert.equal(buffer.size, 10, "alone fills global max, not the soft half");
  assert.equal(buffer.countFor("ios-sim"), 10);
});
