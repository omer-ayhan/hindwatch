import assert from "node:assert/strict";
import { EventBuffer, MAX_MSG_CHARS, PLUGIN_API_VERSION, type DebugEvent, type PluginManifest, type RawEvent, type RedactedEvent } from "@hindwatch/core";
import { emitter, pipeline } from "./helpers.js";
import { test } from "./timed.js";

const TOKEN = "Bearer sk-live-4f9a8b7c6d5e";

const raw = (msg: string, attrs: Record<string, unknown> = {}): RawEvent => ({
  source: "probe",
  deviceId: "dev",
  app: "app",
  level: "error",
  msg,
  attrs,
});

test("enrichers and detectors only ever see redacted events", async () => {
  const seenByEnricher: RedactedEvent[] = [];
  const seenByDetector: DebugEvent[] = [];
  const { manifest, emit } = emitter({
    enrichers: [{ name: "spy", enrich: (e) => void seenByEnricher.push(structuredClone(e)) }],
    detectors: [{ name: "spy", detect: (e) => void seenByDetector.push(structuredClone(e)) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit(raw(`fetch failed, Authorization: ${TOKEN}`, { headers: { authorization: TOKEN }, note: TOKEN }));
  await host.settled();
  assert.equal(seenByEnricher.length, 1);
  assert.equal(seenByDetector.length, 1);
  for (const seen of [...seenByEnricher, ...seenByDetector, ...buffer.snapshot()]) {
    assert.doesNotMatch(JSON.stringify(seen), /sk-live/);
  }
  assert.match(seenByEnricher[0]!.msg, /Bearer \[REDACTED:bearer\]/);
});

test("plugin log lines and plugin errors reach the daemon log redacted", async () => {
  const lines: string[] = [];
  const fail = (what: string) => () => {
    throw new Error(`${what} failed for ${TOKEN}`);
  };
  const { manifest, emit } = emitter({
    enrichers: [{ name: "thrower", enrich: fail("enrich") }],
    detectors: [{ name: "thrower", detect: fail("detect") }],
  });
  const logging: PluginManifest = {
    name: "logger",
    apiVersion: PLUGIN_API_VERSION,
    sources: [{ name: "logger", start: async (ctx) => ctx.log(`connected with ${TOKEN}`), stop: async () => {} }],
  };
  const { host } = pipeline((line) => lines.push(line));
  host.add(manifest);
  host.add(logging);
  await host.startAll();
  emit(raw("hello"));
  await host.settled();
  assert.equal(lines.length, 3, lines.join("\n"));
  for (const line of lines) {
    assert.doesNotMatch(line, /sk-live/);
    assert.match(line, /Bearer \[REDACTED:bearer\]/);
  }
});

test("a secret an enricher injects is redacted before it reaches the buffer or the next plugin", async () => {
  const seenByNext: RedactedEvent[] = [];
  const seenByDetector: DebugEvent[] = [];
  const { manifest, emit } = emitter({
    enrichers: [
      { name: "leaky", enrich: async (e) => ({ msg: `${e.msg} (retry with ${TOKEN})`, attrs: { apiKey: "k-123", extra: TOKEN } }) },
      { name: "next", enrich: (e) => void seenByNext.push(structuredClone(e)) },
    ],
    detectors: [{ name: "spy", detect: (e) => void seenByDetector.push(structuredClone(e)) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit(raw("request failed"));
  await host.settled();
  const [stored] = buffer.snapshot();
  assert.equal(stored!.msg, "request failed (retry with Bearer [REDACTED:bearer])");
  assert.deepEqual(stored!.attrs, { apiKey: "[REDACTED:apiKey]", extra: "Bearer [REDACTED:bearer]" });
  for (const seen of [...seenByNext, ...seenByDetector]) {
    assert.doesNotMatch(JSON.stringify(seen), /sk-live|k-123/);
  }
});

test("enricher output is capped like a source's, and may not touch anything but msg and attrs", async () => {
  const { manifest, emit } = emitter({
    enrichers: [
      { name: "huge", enrich: () => ({ msg: "x ".repeat(MAX_MSG_CHARS) }) },
      { name: "sneaky", enrich: () => ({ level: "debug", deviceId: "other" }) as never },
    ],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit(raw("short"));
  await host.settled();
  const [stored] = buffer.snapshot();
  assert.ok(stored!.msg.length <= MAX_MSG_CHARS);
  assert.ok((stored!.attrs.truncatedChars as number) > 0);
  assert.equal(stored!.level, "error");
  assert.equal(stored!.deviceId, "dev");
});

test("a failing enricher is skipped and the event is kept", async () => {
  const logs: string[] = [];
  const { manifest, emit } = emitter({
    enrichers: [
      { name: "broken", enrich: () => Promise.reject(new Error("boom")) },
      { name: "bad-patch", enrich: () => ({ msg: 42 }) as never },
      { name: "tagger", enrich: (e) => ({ attrs: { tagged: e.msg } }) },
    ],
  });
  const { host, buffer } = pipeline((m) => logs.push(m));
  host.add(manifest);
  await host.startAll();
  emit(raw("kept"));
  await host.settled();
  assert.deepEqual(buffer.snapshot().map((e) => [e.msg, e.attrs.tagged]), [["kept", "kept"]]);
  assert.equal(logs.filter((m) => /broken failed: boom|bad-patch failed/.test(m)).length, 2);
});

test("enriched events keep their source's order and get ids in store order", async () => {
  const { manifest, emit } = emitter({
    enrichers: [{ name: "slow-first", enrich: async (e) => void (e.msg === "1" && (await new Promise((r) => setTimeout(r, 20)))) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  for (const msg of ["1", "2", "3"]) emit(raw(msg));
  await host.settled();
  const events = buffer.snapshot();
  assert.deepEqual(events.map((e) => e.msg), ["1", "2", "3"]);
  assert.deepEqual(events.map((e) => e.id), [...events.map((e) => e.id)].sort((a, b) => a - b));
});

test("a detector's incident is stored next to its trigger, redacted", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.msg.startsWith("crash") ? { kind: "crash", title: `${e.msg} ${TOKEN}` } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit({ ...raw("crash in render"), level: "warn", pid: 7 });
  emit(raw("fine"));
  const [trigger, incident, fine] = buffer.snapshot();
  assert.equal(fine!.msg, "fine");
  assert.equal(incident!.msg, "crash in render Bearer [REDACTED:bearer]");
  assert.equal(incident!.level, "error");
  assert.equal(incident!.pid, 7);
  assert.equal(incident!.sessionId, trigger!.sessionId);
  assert.deepEqual(incident!.attrs.incident, { id: 1, kind: "crash", detector: "crash", eventId: trigger!.id });
  const [record] = host.incidents.list();
  assert.equal(record!.title, "crash in render Bearer [REDACTED:bearer]");
  assert.equal(record!.trigger.id, trigger!.id);
});

test("a repeat of the same incident in a session folds into it with a count and no new marker", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.msg.startsWith("crash") ? { kind: "crash", title: e.msg } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit(raw("crash at 0x1f after 3 tries"));
  emit(raw("crash at 0x2a after 4 tries"));
  emit(raw("crash elsewhere"));
  const records = host.incidents.list();
  assert.deepEqual(records.map((r) => [r.id, r.count]), [[1, 2], [2, 1]]);
  assert.equal(records[0]!.lastTriggerId, 3);
  assert.equal(buffer.snapshot().filter((e) => e.attrs.incident !== undefined).length, 2);
});

test("a hanging enricher is timed out per event: the source keeps going and the chain continues", async () => {
  const logs: string[] = [];
  const { manifest, emit } = emitter({
    enrichers: [
      { name: "hang", enrich: () => new Promise<undefined>(() => {}) },
      { name: "next", enrich: () => ({ attrs: { next: true } }) },
    ],
  });
  const { host, buffer } = pipeline((message) => logs.push(message), { enrichTimeoutMs: 20 });
  host.add(manifest);
  await host.startAll();
  const started = Date.now();
  emit(raw("first"));
  emit(raw("second"));
  await host.settled();
  assert.ok(Date.now() - started >= 40, "each event waited out the timeout");
  assert.deepEqual(
    buffer.snapshot().map((e) => [e.msg, e.attrs]),
    [
      ["first", { next: true }],
      ["second", { next: true }],
    ],
  );
  assert.deepEqual(logs, ["enricher hang failed: timed out after 20ms", "enricher hang failed: timed out after 20ms"]);
});

test("a timed-out enricher's late answer or late edit never reaches the stored event", async () => {
  let resolveLate: (patch: { msg: string }) => void = () => {};
  let rejectLate: (error: Error) => void = () => {};
  let held: RedactedEvent | undefined;
  const { manifest, emit } = emitter({
    enrichers: [
      {
        name: "slow",
        enrich: (e) =>
          new Promise((resolve, reject) => {
            held = e;
            resolveLate = resolve;
            rejectLate = reject;
          }),
      },
    ],
  });
  const { host, buffer } = pipeline(() => {}, { enrichTimeoutMs: 10 });
  host.add(manifest);
  await host.startAll();
  emit(raw("original", { a: 1 }));
  await host.settled();
  // Types say readonly, but a plugin written in plain JS can still edit what it was handed.
  const mutable = held as unknown as { msg: string; attrs: Record<string, unknown> };
  mutable.msg = TOKEN;
  mutable.attrs.a = TOKEN;
  resolveLate({ msg: `late ${TOKEN}` });
  rejectLate(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await host.settled();
  assert.deepEqual(
    buffer.snapshot().map((e) => [e.msg, e.attrs]),
    [["original", { a: 1 }]],
  );
});

test("a flood past the per-source queue cap is stored unenriched, still redacted, and counted", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { manifest, emit } = emitter({
    enrichers: [{ name: "gated", enrich: async () => (await gate, { attrs: { enriched: true } }) }],
  });
  const { host, buffer } = pipeline(() => {}, { maxQueuedPerSource: 3 });
  host.add(manifest);
  await host.startAll();
  for (let i = 0; i < 10; i++) emit(raw(`event ${i} ${TOKEN}`));
  assert.equal(host.unenrichedEvents, 7);
  assert.equal(buffer.snapshot().length, 7, "past the cap, stored right away");
  release();
  await host.settled();
  const events = buffer.snapshot();
  assert.equal(events.length, 10);
  assert.equal(events.filter((e) => e.attrs.enriched === true).length, 3);
  for (const e of events) assert.doesNotMatch(e.msg, /sk-live/);
  emit(raw("after the flood"));
  await host.settled();
  assert.equal(buffer.snapshot().at(-1)!.attrs.enriched, true, "a drained queue enriches again");
  assert.equal(host.unenrichedEvents, 7);
});

test("an event that doesn't match the schema is rejected, logged and counted as invalid", async () => {
  const logs: string[] = [];
  const { manifest, emit } = emitter();
  const { host, buffer } = pipeline((m) => logs.push(m));
  host.add(manifest);
  await host.startAll();
  emit({ ...raw("fine"), level: "loud" } as unknown as RawEvent);
  emit(raw("fine"));
  assert.equal(host.invalidEvents, 1);
  assert.equal(buffer.size, 1);
  assert.match(logs.join("\n"), /invalid event from probe/);
});

test("status activity tracks emits; a silent source warns after the attach window", async () => {
  let now = 1_000;
  let setIdleHealth: ((h: { status: "waiting" | "live" | "idle"; detail: string }) => void) | undefined;
  const { manifest, emit } = emitter();
  const idle: PluginManifest = {
    name: "idle",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      {
        name: "idle",
        start: async (ctx) => {
          setIdleHealth = ctx.setHealth;
          // Live with nothing — the only state that may be labeled deaf.
          ctx.setHealth({ status: "live", detail: "attached" });
        },
        stop: async () => {},
      },
    ],
  };
  const { host } = pipeline(() => {}, { now: () => now, silentAfterMs: 100 });
  host.add(manifest);
  host.add(idle);
  await host.startAll();

  assert.deepEqual(
    host.sourceActivity().map((a) => [a.name, a.events]),
    [
      ["probe", 0],
      ["idle", 0],
    ],
  );
  assert.deepEqual(host.silentSourceWarnings(), []);

  emit(raw("hello"));
  await host.settled();
  const probe = host.sourceActivity().find((a) => a.name === "probe")!;
  assert.equal(probe.events, 1);
  assert.equal(probe.lastEventAt, 1_000);
  assert.deepEqual(host.silentSourceWarnings(), []);

  now = 1_000 + 150;
  const warnings = host.silentSourceWarnings();
  assert.ok(warnings.includes("idle: no events for 1s after attach; the source may be deaf"));
  assert.ok(
    warnings.some((w) => w.startsWith("probe:") && w.includes("since last")),
    "a source that emitted then went quiet warns on time-since-last",
  );
  void setIdleHealth;
});


test("muted events never enter the buffer and mutedDropped counts them", async () => {
  const { manifest, emit } = emitter();
  const isMuted = () => (e: { msg: string }) => e.msg.startsWith("noise");
  const mutedBuffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const { host, buffer } = pipeline(() => {}, { isMuted, mutedBuffer });
  host.add(manifest);
  await host.startAll();
  emit(raw("noise spam 1"));
  emit(raw("noise spam 2"));
  emit(raw("keep me"));
  await host.settled();
  assert.equal(host.mutedDropped, 2);
  assert.deepEqual(buffer.snapshot().map((e) => e.msg), ["keep me"]);
  assert.equal(buffer.size, 1);
  // Side-buffer holds capped muted copies for --include-muted; not the main ring.
  assert.deepEqual(mutedBuffer.snapshot().map((e) => e.msg), ["noise spam 1", "noise spam 2"]);
  assert.equal(mutedBuffer.size, 2);
});

test("live with prior events does not warn gone quiet (RN idle is ok)", async () => {
  let now = 1_000;
  let ctx: { emit: (e: RawEvent) => void; setHealth: (h: { status: "waiting" | "live" | "idle"; detail: string }) => void } | undefined;
  const live: PluginManifest = {
    name: "rn",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      {
        name: "react-native",
        start: async (c) => {
          ctx = c;
          c.setHealth({ status: "live", detail: "connected" });
        },
        stop: async () => {},
      },
    ],
  };
  const { host } = pipeline(() => {}, { now: () => now, silentAfterMs: 100 });
  host.add(live);
  await host.startAll();
  ctx!.emit({ source: "react-native", deviceId: "logical", app: "app", level: "info", msg: "hello" });
  await host.settled();
  now = 1_000 + 150;
  const warnings = host.silentSourceWarnings();
  assert.equal(
    warnings.some((w) => w.includes("gone quiet") || w.includes("since last")),
    false,
    `live+events must not warn gone quiet, got: ${warnings.join(" | ")}`,
  );
  assert.equal(warnings.some((w) => /deaf/.test(w)), false);
});

test("waiting health is not labeled deaf; quiet-after-events warns on time since last", async () => {
  let now = 1_000;
  let setHealth: ((h: { status: "waiting" | "live" | "idle"; detail: string }) => void) | undefined;
  const waiting: PluginManifest = {
    name: "waiter",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      {
        name: "waiter",
        start: async (ctx) => {
          setHealth = ctx.setHealth;
          ctx.setHealth({ status: "waiting", detail: "no booted simulator" });
        },
        stop: async () => {},
      },
    ],
  };
  const { manifest, emit } = emitter();
  const { host } = pipeline(() => {}, { now: () => now, silentAfterMs: 100 });
  host.add(waiting);
  host.add(manifest);
  await host.startAll();
  now = 1_200;
  assert.ok(host.silentSourceWarnings().includes("waiter: no booted simulator"));
  assert.equal(
    host.silentSourceWarnings().some((w) => w.startsWith("waiter:") && /deaf/.test(w)),
    false,
    "waiting is never labeled deaf",
  );

  emit(raw("hello"));
  await host.settled();
  now = 1_400;
  assert.ok(host.silentSourceWarnings().some((w) => w.includes("probe:") && w.includes("since last")));
  assert.equal(host.silentSourceWarnings().some((w) => w.startsWith("probe:") && /deaf/.test(w)), false);
});

test("unset health (android never-connected) is waiting, never deaf", async () => {
  let now = 1_000;
  // Source that finishes start() without setHealth — mirrors android before first pidof.
  const neverConnected: PluginManifest = {
    name: "android",
    apiVersion: PLUGIN_API_VERSION,
    sources: [{ name: "android", start: async () => {}, stop: async () => {} }],
  };
  const { host } = pipeline(() => {}, { now: () => now, silentAfterMs: 100 });
  host.add(neverConnected);
  await host.startAll();
  now = 1_200;
  const warnings = host.silentSourceWarnings();
  assert.ok(
    warnings.includes("android: waiting (no device or not yet attached)"),
    `expected waiting warning, got: ${warnings.join(" | ")}`,
  );
  assert.equal(
    warnings.some((w) => /deaf/.test(w)),
    false,
    "never-connected / unset health must not report deaf",
  );
});
