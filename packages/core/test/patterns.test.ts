import assert from "node:assert/strict";
import { Clocks, collapse, EventBuffer, Ingest, patternId, Redactor, templateOf } from "@hindwatch/core";
import { test } from "./timed.js";

test("variable parts of a line become slots", () => {
  assert.equal(templateOf("Image load failed https://cdn.x/a.png?w=2 after 30ms"), "Image load failed {url} after {num}ms");
  assert.equal(templateOf("req 3fa85f64-5717-4562-b3fc-2c963f66afa6 took 1.25s"), "req {uuid} took {num}s");
  assert.equal(templateOf("ptr 0x7ffee4 hash deadbeef0123 retry #4"), "ptr {hex} hash {hex} retry #{num}");
  assert.equal(templateOf("v2 api_v3 layer1 ok"), "v2 api_v3 layer1 ok");
  assert.equal(templateOf("TypeError: x is undefined\n    at render (App.js:10:3)"), "TypeError: x is undefined");
  // Hour after T must not stick in the template (letter lookbehind would spare it from {num}).
  assert.equal(
    templateOf("Billing error at 2026-10-23T02:15:30.123Z code 401"),
    "Billing error at {iso} code {num}",
  );
  assert.equal(
    templateOf("retry 2026-10-23T14:00:00+03:00 then ok"),
    "retry {iso} then ok",
  );
  assert.equal(templateOf("fail 2026-10-23T02:15:30.123Z").includes("T02"), false);
});

test("a 1 MB line templates (a quadratic slot rule would hang here) and the template is capped", () => {
  for (const line of ["a1".repeat(500_000), "1.".repeat(500_000), "0x".repeat(500_000), "a://".repeat(250_000)]) {
    assert.ok(templateOf(line).length <= 301);
  }
});

test("repeats collapse into one pattern with a count, first and last ids, and the worst level", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const add = (source: string, msg: string, level: "info" | "warn" = "info") =>
    ingest.ingest({ source, deviceId: "d", app: "a", level, msg });
  add("js", "poll 1 ok");
  add("android", "poll 2 ok");
  add("js", "tap");
  add("js", "poll 3 ok", "warn");
  add("js", "poll 4 ok");
  const patterns = collapse(buffer.snapshot());
  assert.deepEqual(
    patterns.map(({ template, source, count, firstId, lastId, level }) => ({ template, source, count, firstId, lastId, level })),
    [
      { template: "poll {num} ok", source: "js", count: 3, firstId: 1, lastId: 5, level: "warn" },
      { template: "poll {num} ok", source: "android", count: 1, firstId: 2, lastId: 2, level: "info" },
      { template: "tap", source: "js", count: 1, firstId: 3, lastId: 3, level: "info" },
    ],
  );
  assert.equal(patterns[0]!.sample, "poll 1 ok");
  assert.equal(patterns[2]!.sample, undefined);
  assert.equal(patterns[0]!.id, patternId("js", "poll {num} ok"));
  assert.notEqual(patterns[0]!.id, patterns[1]!.id);
});
