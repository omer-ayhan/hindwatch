import assert from "node:assert/strict";
import { Clocks, collapse, EventBuffer, expectEvents, Ingest, MIN_BUDGET_CHARS, Redactor, resolveStale, runPatternQuery, runQuery, SCHEMA_VERSION, type CompactEvent, type DebugEvent, type MuteFilter, type PatternResult } from "@hindwatch/core";
import { test } from "./timed.js";

function setup(count: number) {
  const buffer = new EventBuffer({ maxEvents: 10_000, maxEventsPerSource: 10_000, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  const add = (msg: string, level: "info" | "error" = "info") =>
    ingest.ingest({ source: level === "error" ? "android" : "js", deviceId: "d", app: "com.x", level, msg });
  for (let i = 0; i < count; i++) add(`line ${i}`, i % 5 === 0 ? "error" : "info");
  return { buffer, add };
}

test("filters by level, source and since-id", () => {
  const { buffer } = setup(20);
  const events = buffer.snapshot();
  assert.equal(runQuery(events, { minLevel: "error" }).events.length, 4);
  assert.equal(runQuery(events, { sources: ["js"] }).events.length, 16);
  assert.deepEqual(runQuery(events, { sinceId: 18 }).events.map((e) => e.id), [19, 20]);
});

test("pages under the character budget cover every event exactly once", () => {
  const { buffer } = setup(200);
  const seen: number[] = [];
  let cursor: string | undefined;
  do {
    const page = runQuery(buffer.snapshot(), { budgetChars: 2_000, cursor });
    assert.ok(JSON.stringify(page).length <= 2_000, `response is ${JSON.stringify(page).length} chars`);
    seen.push(...page.events.map((e) => e.id));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => i + 1));
});

test("events that arrive mid-paging wait for the next since-cursor", () => {
  const { buffer, add } = setup(50);
  const first = runQuery(buffer.snapshot(), { budgetChars: 1_000 });
  assert.ok(first.truncated && first.next !== null);
  add("late arrival");
  let page = first;
  const ids: number[] = [...first.events.map((e) => e.id)];
  while (page.next !== null) {
    page = runQuery(buffer.snapshot(), { budgetChars: 1_000, cursor: page.next });
    ids.push(...page.events.map((e) => e.id));
  }
  assert.equal(page.lastId, 50);
  assert.ok(!ids.includes(51));
  assert.deepEqual(runQuery(buffer.snapshot(), { sinceId: page.lastId }).events.map((e) => e.msg), ["late arrival"]);
});

test("one oversized event is clipped with structured msgCut/attrsOmitted instead of stalling", () => {
  const { buffer, add } = setup(0);
  add("word ".repeat(10_000));
  const result = runQuery(buffer.snapshot(), { budgetChars: 1_000 });
  const [event] = result.events as [CompactEvent];
  assert.ok(JSON.stringify(result).length <= 1_000, `response is ${JSON.stringify(result).length} chars`);
  assert.ok(typeof event.msgCut === "number" && event.msgCut > 0, "msgCut records how many chars were cut");
  assert.equal(event.attrsOmitted, true);
  assert.ok(!event.msg.includes("truncated: attrs omitted"), "truncation notes stay out of msg");
  assert.ok(event.msg.endsWith("…") || event.msg.length < 10_000);
  assert.equal(result.next, null);
});

test("a malformed cursor is rejected", () => {
  assert.throws(() => runQuery([], { cursor: "nope" }), /invalid cursor/);
});

test("a budget below the minimum is raised to it", () => {
  const { buffer } = setup(100);
  const result = runQuery(buffer.snapshot(), { budgetChars: 1 });
  assert.ok(result.events.length > 0);
  assert.ok(JSON.stringify(result).length <= MIN_BUDGET_CHARS);
});

test("a muted event is left out and counted, unless muted events are asked for", () => {
  const { buffer } = setup(10);
  const isMuted: MuteFilter = (e) => e.level === "error";
  const result = runQuery(buffer.snapshot(), {}, isMuted);
  assert.equal(result.events.length, 8);
  assert.equal(result.muted, 2);
  assert.equal(runQuery(buffer.snapshot(), { includeMuted: true }, isMuted).events.length, 10);
});

test("events can be read back by the pattern they folded into", () => {
  const { buffer, add } = setup(0);
  add("Image load failed https://cdn.x/1.png after 30ms");
  add("tap");
  add("Image load failed https://cdn.x/2.png after 41ms");
  const [image] = collapse(buffer.snapshot());
  const result = runQuery(buffer.snapshot(), { pattern: image!.id });
  assert.deepEqual(result.events.map((e) => e.id), [1, 3]);
});

test("patterns come most frequent first and page under the budget without repeats", () => {
  const { buffer, add } = setup(0);
  for (let i = 0; i < 60; i++) add(`kind ${"abcdefghij"[i % 10]!.repeat(i % 10 + 1)} took ${i}ms`);
  for (let i = 0; i < 10; i++) add(`hot path ${i}`);
  const seen: string[] = [];
  let cursor: string | undefined;
  let first: PatternResult | undefined;
  do {
    const page = runPatternQuery(buffer.snapshot(), { budgetChars: 1_000, cursor });
    first ??= page;
    assert.ok(JSON.stringify(page).length <= 1_000);
    seen.push(...page.patterns.map((p) => p.id));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  assert.equal(first!.patterns[0]!.template, "hot path {num}");
  assert.equal(first!.events, 70);
  assert.equal(new Set(seen).size, 11);
  assert.equal(seen.length, 11);
});

test("level and text combine case-insensitively (Claude #1)", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  // Require-cycle style: lowercase needle only in a long non-error msg.
  ingest.ingest({
    source: "js",
    deviceId: "d",
    app: "com.x",
    level: "warn",
    msg: "Require cycle: features/x.js -> node_modules/@acme/billing/index.js -> features/x.js",
  });
  // Billing error: capital B — alone level=error finds it; text=billing must too.
  ingest.ingest({
    source: "js",
    deviceId: "d",
    app: "com.x",
    level: "error",
    msg: "Uncaught (in promise) Error: Billing failed to getPaywallProducts",
  });
  const events = buffer.snapshot();
  const byText = runQuery(events, { text: "billing" });
  const byLevel = runQuery(events, { minLevel: "error" });
  const both = runQuery(events, { text: "billing", minLevel: "error" });
  assert.ok(byText.events.length >= 1, "text alone finds billing");
  assert.ok(byLevel.events.length >= 1, "level alone finds error");
  assert.equal(both.events.length, 1, "combo must not be empty");
  assert.equal(both.events[0]!.level, "error");
  assert.match(both.events[0]!.msg, /Billing/i);
});

test("expect with level+text does not false-pass when the error is present (Claude #1)", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  ingest.ingest({
    source: "js",
    deviceId: "d",
    app: "com.x",
    level: "error",
    msg: "Error: Billing network timeout",
  });
  const present = expectEvents(buffer, { text: "billing", minLevel: "error" }, "present", 8_000);
  assert.equal(present.ok, true);
  assert.equal(present.matched, 1);
  const absent = expectEvents(buffer, { text: "billing", minLevel: "error" }, "absent", 8_000);
  assert.equal(absent.ok, false, "absent must not false-pass when Billing error exists");
  assert.equal(absent.matched, 1);
});

test("filters by an arrival-order window and by text in the message", () => {
  const { buffer } = setup(20);
  const events = buffer.snapshot();
  assert.deepEqual(runQuery(events, { sinceId: 5, untilId: 7 }).events.map((e) => e.id), [6, 7]);
  assert.deepEqual(runQuery(events, { text: "line 1" }).events.map((e) => e.msg), ["line 1", ...Array.from({ length: 10 }, (_, i) => `line 1${i}`)]);
});

test("patterns honor text the same way logs do", () => {
  const { buffer, add } = setup(0);
  for (let i = 0; i < 5; i++) add(`poll ${i} ok`);
  for (let i = 0; i < 3; i++) add(`login failed ${i}`);
  add("unrelated");
  const all = runPatternQuery(buffer.snapshot(), {});
  assert.ok(all.patterns.length >= 2);
  const narrowed = runPatternQuery(buffer.snapshot(), { text: "login failed" });
  assert.equal(narrowed.events, 3);
  assert.deepEqual(
    narrowed.patterns.map((p) => p.template),
    ["login failed {num}"],
  );
});

test("a logs cursor rejects changed filters and accepts a different budget", () => {
  const { buffer } = setup(80);
  const events = buffer.snapshot();
  const first = runQuery(events, { sources: ["js"], budgetChars: 1_000 });
  assert.ok(first.truncated && first.next !== null);
  assert.throws(
    () => runQuery(events, { sources: ["android"], budgetChars: 1_000, cursor: first.next! }),
    /cursor was minted with different filters/,
  );
  assert.throws(
    () => runQuery(events, { sources: ["js"], text: "line", budgetChars: 1_000, cursor: first.next! }),
    /cursor was minted with different filters/,
  );
  const next = runQuery(events, { sources: ["js"], budgetChars: 2_000, cursor: first.next! });
  assert.ok(next.events.length > 0);
  assert.ok(next.events.every((e) => e.source === "js"));
});

test("a patterns cursor rejects changed filters", () => {
  const { buffer, add } = setup(0);
  for (let i = 0; i < 40; i++) add(`kind ${"abcdefghij"[i % 10]!.repeat(i % 10 + 1)} took ${i}ms`);
  for (let i = 0; i < 10; i++) add(`hot path ${i}`);
  const first = runPatternQuery(buffer.snapshot(), { minLevel: "info", budgetChars: 800 });
  assert.ok(first.truncated && first.next !== null);
  assert.throws(
    () => runPatternQuery(buffer.snapshot(), { minLevel: "error", budgetChars: 800, cursor: first.next! }),
    /cursor was minted with different filters/,
  );
  const next = runPatternQuery(buffer.snapshot(), { minLevel: "info", budgetChars: 1_200, cursor: first.next! });
  assert.ok(next.patterns.length > 0);
});

test("includeMuted is part of the cursor fingerprint", () => {
  const { buffer } = setup(40);
  const isMuted: MuteFilter = (e) => e.level === "error";
  const first = runQuery(buffer.snapshot(), { includeMuted: true, budgetChars: 800 }, isMuted);
  assert.ok(first.truncated && first.next !== null);
  assert.throws(
    () => runQuery(buffer.snapshot(), { budgetChars: 800, cursor: first.next! }, isMuted),
    /cursor was minted with different filters/,
  );
  const next = runQuery(buffer.snapshot(), { includeMuted: true, budgetChars: 800, cursor: first.next! }, isMuted);
  assert.ok(next.events.length > 0);
});


test("order desc returns newest first and pages toward older", () => {
  const { buffer } = setup(20);
  const first = runQuery(buffer.snapshot(), { budgetChars: 1_200, order: "desc" });
  assert.equal(first.order, "desc");
  assert.ok(first.events.length >= 2);
  assert.ok(first.events[0]!.id > first.events.at(-1)!.id, "desc page is newest-first");
  assert.ok(first.truncated, "small budget truncates");
  assert.ok(first.next !== null);
  const second = runQuery(buffer.snapshot(), { budgetChars: 1_200, order: "desc", cursor: first.next! });
  assert.ok(second.events.every((e) => e.id < first.events.at(-1)!.id));
});

test("text filter adds a match snippet so the hit stays visible", () => {
  const { buffer, add } = setup(0);
  const needle = "UNIQUE_NEEDLE_42";
  add(`prefix ${"x".repeat(500)} ${needle} ${"y".repeat(500)} suffix`);
  const result = runQuery(buffer.snapshot(), { text: needle, budgetChars: 1_000 });
  const [event] = result.events;
  assert.ok(event, "matched event returned");
  assert.ok(event!.match?.includes(needle), `match snippet should show the needle, got ${event!.match}`);
});

test("events before startedAt are flagged stale on the page", () => {
  const { buffer } = setup(5);
  // Ingest timestamps can share a ms; prove with a ceiling that marks every row, then none.
  const all = runQuery(buffer.snapshot(), {}, undefined, undefined, { startedAt: Number.MAX_SAFE_INTEGER });
  assert.equal(all.startedAt, Number.MAX_SAFE_INTEGER);
  assert.ok(all.events.length > 0 && all.events.every((e) => e.stale === true));
  const none = runQuery(buffer.snapshot(), {}, undefined, undefined, { startedAt: 0 });
  assert.equal(none.startedAt, 0);
  assert.ok(none.events.every((e) => e.stale !== true));
});

test("resolveStale folds stale false/true into from/to against startedAt", () => {
  assert.deepEqual(resolveStale({ stale: false, text: "x" }, 5_000), { text: "x", from: 5_000 });
  assert.deepEqual(resolveStale({ stale: true, text: "x" }, 5_000), { text: "x", to: 4_999 });
  assert.deepEqual(resolveStale({ stale: false, from: 6_000 }, 5_000), { from: 6_000 });
  assert.deepEqual(resolveStale({ stale: false, from: 4_000 }, 5_000), { from: 5_000 });
  assert.deepEqual(resolveStale({ stale: true, to: 3_000 }, 5_000), { to: 3_000 });
  assert.deepEqual(resolveStale({ text: "x" }, 5_000), { text: "x" });
  assert.deepEqual(resolveStale({ stale: false }, undefined), {});
});

test("stale false keeps only events at or after startedAt", () => {
  const now = 1_000_000;
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 1e9 }, () => now);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    deviceTs: null as null,
    estimated: true as const,
    source: "s",
    deviceId: "d",
    app: "a",
    sessionId: "x",
    pid: null as null,
    level: "info" as const,
    attrs: {},
  };
  buffer.push({ ...base, id: 1, ts: 100, hostTs: now, msg: "old" });
  buffer.push({ ...base, id: 2, ts: 200, hostTs: now, msg: "live" });
  const startedAt = 150;
  const live = runQuery(buffer.snapshot(), resolveStale({ stale: false }, startedAt), undefined, undefined, { startedAt });
  assert.deepEqual(live.events.map((e) => e.msg), ["live"]);
  assert.ok(live.events.every((e) => e.stale !== true));
  const replay = runQuery(buffer.snapshot(), resolveStale({ stale: true }, startedAt), undefined, undefined, { startedAt });
  assert.deepEqual(replay.events.map((e) => e.msg), ["old"]);
  assert.ok(replay.events.every((e) => e.stale === true));
});

test("query.after excludes events at or before the timeline keyset (sinceLast page-end)", () => {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    deviceTs: null as null,
    estimated: false as const,
    source: "s",
    deviceId: "d",
    app: "a",
    sessionId: "x",
    pid: null as null,
    level: "error" as const,
    attrs: {},
    hostTs: 0,
  };
  const events: DebugEvent[] = [
    { ...base, id: 1, ts: 2_000, hostTs: 2_000, msg: "later-low-id" },
    { ...base, id: 2, ts: 1_000, hostTs: 1_000, msg: "earlier-high-id" },
  ];
  const full = runQuery(events, { budgetChars: 10_000 });
  assert.deepEqual(full.events.map((e) => e.msg), ["earlier-high-id", "later-low-id"]);
  const afterPage = runQuery(events, { after: { ts: 1_000, id: 2 }, budgetChars: 10_000 });
  assert.deepEqual(afterPage.events.map((e) => e.msg), ["later-low-id"]);
  assert.equal(afterPage.events[0]!.id, 1);
});
