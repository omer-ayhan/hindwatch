import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTEXT_WINDOW_MS,
  incidentDetail,
  incidentPart,
  listIncidents,
  MIN_BUDGET_CHARS,
  nativeCrashDetector,
  parseLogcatEntries,
  type DebugEvent,
  type IncidentRecord,
  type MuteFilter,
  type RawEvent,
} from "@hindwatch/core";
import { emitter, JAVA_CRASH_LOG, pipeline } from "./helpers.js";
import { test } from "./timed.js";

const T0 = 1_750_000_000_000;
const nothingMuted: MuteFilter = () => false;

const frames = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    methodName: `fn${i}`,
    file: i % 2 === 0 ? `/app/src/Screen${i}.tsx` : `/app/node_modules/react-native/Lib${i}.js`,
    lineNumber: 10 + i,
    column: 4,
    collapse: i % 2 === 1,
  }));

const crash = (attrs: Record<string, unknown> = {}): Partial<RawEvent> => ({
  source: "react-native",
  level: "error",
  msg: `TypeError: Cannot read property 'name' of undefined\n${"    at deep\n".repeat(200)}`,
  attrs: {
    exception: true,
    stack: frames(60),
    codeFrame: { content: "  10 | const x = user.name;\n".repeat(80), location: { row: 10, column: 4 }, fileName: "/app/src/Screen0.tsx" },
    ...attrs,
  },
});

/** A crash after a noisy 40 s: polling noise, a warning, an earlier error, and one line too old for the window. */
async function scenario() {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: e.msg.split("\n")[0]! } : undefined) }],
  });
  const { host, buffer, clocks } = pipeline();
  host.add(manifest);
  await host.startAll();
  clocks.setSample("dev", { deviceTs: T0, hostTs: T0 });
  const at = (offsetMs: number, event: Partial<RawEvent>) =>
    emit({ source: "android", deviceId: "dev", app: "app", level: "info", msg: "", ...event, deviceTs: T0 + offsetMs } as RawEvent);
  at(0, { msg: "too old to matter" });
  for (let i = 0; i < 400; i++) at(12_000 + i * 60, { msg: `poll ${i} took ${i % 7}ms`, source: "android" });
  at(20_000, { msg: "fetch /user failed with 500", level: "error", source: "react-native" });
  at(30_000, { msg: "user is undefined, rendering anyway", level: "warn", source: "react-native" });
  at(40_000, crash());
  at(40_010, { msg: "after the crash" });
  const [record] = host.incidents.list() as [IncidentRecord];
  return { record, events: buffer.snapshot(), host, at };
}

test("an incident's detail fits every budget, with the trigger, app frames, code and first error", async () => {
  const { record, events } = await scenario();
  for (const budget of [MIN_BUDGET_CHARS, 1_500, 2_000, 4_000, 8_000, 32_000]) {
    const detail = incidentDetail(record, events, budget, nothingMuted) as Record<string, any>;
    assert.ok(JSON.stringify(detail).length <= budget, `${budget}: ${JSON.stringify(detail).length} chars`);
    assert.equal(detail.id, 1);
    assert.equal(detail.kind, "redbox");
    assert.deepEqual(detail.parts, ["trigger", "stack", "code", "context"]);
  }
  const detail = incidentDetail(record, events, 8_000, nothingMuted) as Record<string, any>;
  assert.equal(detail.title, "TypeError: Cannot read property 'name' of undefined");
  assert.deepEqual(detail.stack.frames, [
    "fn0 (/app/src/Screen0.tsx:10:4)",
    "fn2 (/app/src/Screen2.tsx:12:4)",
    "fn4 (/app/src/Screen4.tsx:14:4)",
    "fn6 (/app/src/Screen6.tsx:16:4)",
    "fn8 (/app/src/Screen8.tsx:18:4)",
  ]);
  assert.equal(detail.stack.totalFrames, 60);
  assert.equal(detail.stack.omittedFrames, 55);
  assert.equal(detail.code.file, "/app/src/Screen0.tsx");
  assert.equal(detail.code.line, 10);
  assert.equal(detail.firstError.msg, "fetch /user failed with 500");
  assert.deepEqual(detail.omittedParts, []);
  const { context } = detail;
  assert.equal(context.to - context.from, CONTEXT_WINDOW_MS);
  // 400 polls fold into one pattern; the line before the window, the crash and the line after it are out.
  assert.equal(context.events, 402);
  const templates = context.patterns.map((p: { template: string }) => p.template);
  // Ordered by lastTs toward the trigger (polls continue latest).
  assert.deepEqual(templates, ["fetch /user failed with {num}", "user is undefined, rendering anyway", "poll {num} took {num}ms"]);
  assert.equal(context.patterns.find((p: { template: string }) => p.template.startsWith("poll"))?.count, 400);
});

test("at the smallest budget the header stays and the parts that don't fit are named", async () => {
  const { record, events } = await scenario();
  const detail = incidentDetail(record, events, MIN_BUDGET_CHARS, nothingMuted) as Record<string, any>;
  assert.ok(detail.omittedParts.length > 0);
  assert.equal(detail.title, "TypeError: Cannot read property 'name' of undefined");
  assert.match(detail.trigger.msg, /^TypeError/);
});

test("muted noise and incident markers stay out of the context", async () => {
  const { record, events } = await scenario();
  const isMuted: MuteFilter = (e) => e.msg.startsWith("poll");
  const { context } = incidentDetail(record, events, 8_000, isMuted) as Record<string, any>;
  assert.equal(context.muted, 400);
  assert.equal(context.events, 2);
  assert.ok(!events.some((e) => e.attrs.incident !== undefined && context.patterns.some((p: { firstId: number }) => p.firstId === e.id)));
});

test("each part pages in full under the budget", async () => {
  const { record, events } = await scenario();
  const budget = 1_500;
  const stack = incidentPart(record, "stack", events, { budgetChars: budget }, nothingMuted) as Record<string, any>;
  assert.ok(JSON.stringify(stack).length <= budget);
  assert.equal(stack.frames[1], "fn1 (/app/node_modules/react-native/Lib1.js:11:4)");
  assert.equal(stack.frames.length + stack.omitted, 60);
  const code = incidentPart(record, "code", events, { budgetChars: budget }, nothingMuted) as Record<string, any>;
  assert.ok(JSON.stringify(code).length <= budget);
  assert.match(code.code.snippet, /…\[\+\d+ chars\]$/);
  const trigger = incidentPart(record, "trigger", events, { budgetChars: budget }, nothingMuted) as Record<string, any>;
  assert.ok(JSON.stringify(trigger).length <= budget);
  assert.equal(trigger.events[0].id, record.trigger.id);
  const ids: number[] = [];
  let cursor: string | undefined;
  do {
    const page = incidentPart(record, "context", events, { budgetChars: budget, cursor }, nothingMuted) as Record<string, any>;
    assert.ok(JSON.stringify(page).length <= budget);
    ids.push(...page.events.map((e: { id: number }) => e.id));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  // The raw window: 400 polls, the error, the warning, the trigger and its incident marker.
  assert.equal(ids.length, 404);
});

test("the trigger is kept with its incident after the buffer evicts it", async () => {
  const { record } = await scenario();
  const trigger = incidentPart(record, "trigger", [], {}, nothingMuted) as Record<string, any>;
  assert.equal(trigger.events[0].id, record.trigger.id);
});

test("incidents list oldest first, from a since-id, paged under the budget", async () => {
  const { host, at } = await scenario();
  for (let i = 0; i < 30; i++) at(41_000 + i, crash({ stack: [] , exception: true, n: i }) as Partial<RawEvent>);
  for (let i = 0; i < 30; i++) at(42_000 + i, { ...crash(), msg: `Error: crash number ${"x".repeat(i)}` });
  const records = host.incidents.list();
  assert.equal(records[0]!.count, 31);
  assert.equal(records.length, 31);
  const seen: number[] = [];
  let cursor: string | undefined;
  do {
    const page = listIncidents(records, { budgetChars: 1_000, cursor });
    assert.ok(JSON.stringify(page).length <= 1_000);
    seen.push(...page.incidents.map((i) => i.id));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(seen, Array.from({ length: 31 }, (_, i) => i + 1));
  assert.deepEqual(listIncidents(records, { sinceId: 29 }).incidents.map((i) => i.id), [30, 31]);
  assert.equal(listIncidents(records, { sinceId: 31 }).lastId, 31);
});

test("listeners hear every raise, new and repeated, until they unsubscribe", async () => {
  const { record, host, at } = await scenario();
  const heard: Array<[number, boolean]> = [];
  const unsubscribe = host.incidents.onRaised(({ record: r, isNew }) => heard.push([r.id, isNew]));
  at(41_000, crash());
  at(42_000, crash({ stack: [] }));
  at(43_000, { ...crash(), msg: "RangeError: out of range" });
  unsubscribe();
  at(44_000, crash());
  assert.deepEqual(heard, [
    [record.id, false],
    [record.id, false],
    [record.id + 1, true],
  ]);
});


test("prefers the Error stack in msg over a collapsed console call-site stack", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: e.msg.split("\n")[0]! } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  const bundle =
    "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true&hot=false";
  const msg = [
    "Uncaught (in promise, id: 0) Error: billing failed",
    `    at BillingError (${bundle}:375590:12)`,
    `    at getError (${bundle}:376117:29)`,
    "    at tryCallOne (address at InternalBytecode.js:1:1296)",
  ].join("\n");
  emit({
    source: "react-native",
    deviceId: "dev",
    app: "app",
    level: "error",
    msg,
    deviceTs: T0,
    attrs: {
      exception: true,
      stack: [
        { methodName: "error", file: "/app/node_modules/react-native/Libraries/Core/console.js", lineNumber: 667, column: 28, collapse: true },
        { methodName: "reportException", file: "/app/node_modules/react-native/Libraries/Core/ExceptionsManager.js", lineNumber: 10, column: 1, collapse: true },
      ],
      codeFrame: {
        content: "\u001b[0m \u001b[90m 665 |\u001b[39m\n\u001b[0m\u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 667 |\u001b[39m  console.error(err);\n",
        location: { row: 667, column: 28 },
        fileName: "/app/node_modules/react-native/Libraries/Core/console.js",
      },
    },
  } as RawEvent);
  const [record] = host.incidents.list() as [IncidentRecord];
  const detail = incidentDetail(record, buffer.snapshot(), 8_000, nothingMuted) as Record<string, any>;
  assert.deepEqual(detail.stack.frames, [
    "BillingError (entry.bundle:375590:12)",
    "getError (entry.bundle:376117:29)",
  ]);
  assert.equal(detail.stack.totalFrames, 2);
  assert.equal(detail.code, null, "plumbing code frames are omitted");
});

test("keeps symbolicated library frames from attrs over the unsymbolicated Error msg stack", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: e.msg.split("\n")[0]! } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  const bundle = "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true";
  const msg = `Error: billing\n    at BillingError (${bundle}:375590:12)`;
  emit({
    source: "react-native",
    deviceId: "dev",
    app: "app",
    level: "error",
    msg,
    deviceTs: T0,
    attrs: {
      exception: true,
      symbolicated: true,
      stack: [
        { methodName: "BillingError", file: "/app/node_modules/@acme/billing/dist/index.cjs", lineNumber: 412, column: 6, collapse: true },
        { methodName: "getError", file: "/app/node_modules/@acme/billing/dist/index.cjs", lineNumber: 500, column: 2, collapse: true },
      ],
      codeFrame: {
        content: "> 412 | \tsuper(BillingError.getMessage(input));\n",
        location: { row: 412, column: 6 },
        fileName: "/app/node_modules/@acme/billing/dist/index.cjs",
      },
    },
  } as RawEvent);
  const [record] = host.incidents.list() as [IncidentRecord];
  const detail = incidentDetail(record, buffer.snapshot(), 8_000, nothingMuted) as Record<string, any>;
  assert.deepEqual(detail.stack.frames, [
    "BillingError (/app/node_modules/@acme/billing/dist/index.cjs:412:6)",
    "getError (/app/node_modules/@acme/billing/dist/index.cjs:500:2)",
  ]);
  assert.equal(detail.code.file, "/app/node_modules/@acme/billing/dist/index.cjs");
  assert.doesNotMatch(detail.code.snippet, /\u001b\[/);
});


test("strips ANSI from an app code frame and keeps non-collapsed app frames from attrs", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: "x" } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit({
    source: "react-native",
    deviceId: "dev",
    app: "app",
    level: "error",
    msg: "TypeError: x",
    deviceTs: T0,
    attrs: {
      exception: true,
      stack: [
        { methodName: "onPress", file: "/app/src/Profile.tsx", lineNumber: 42, column: 19, collapse: false },
        { methodName: "error", file: "/app/node_modules/react-native/Libraries/Core/console.js", lineNumber: 667, column: 1, collapse: true },
      ],
      codeFrame: {
        content: "\u001b[31m> 42 |\u001b[39m  user.name;\n",
        location: { row: 42, column: 19 },
        fileName: "/app/src/Profile.tsx",
      },
    },
  } as RawEvent);
  const [r] = host.incidents.list() as [IncidentRecord];
  const d = incidentDetail(r, buffer.snapshot(), 8_000, nothingMuted) as Record<string, any>;
  assert.equal(d.code.snippet, "> 42 |  user.name;\n");
  assert.deepEqual(d.stack.frames, ["onPress (/app/src/Profile.tsx:42:19)"]);
  assert.equal(d.stack.totalFrames, 2);
});

test("trigger msg shortens Metro bundle URLs like compact queries", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: e.msg.split("\n")[0]! } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  const bundle =
    "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true&hot=false&lazy=true";
  const msg = `Error: boom\n    at BillingError (${bundle}:375590:12)`;
  emit({
    source: "react-native",
    deviceId: "dev",
    app: "app",
    level: "error",
    msg,
    deviceTs: T0,
    attrs: { exception: true, stack: [] },
  } as RawEvent);
  const [record] = host.incidents.list() as [IncidentRecord];
  const detail = incidentDetail(record, buffer.snapshot(), 8_000, nothingMuted) as Record<string, any>;
  assert.match(detail.trigger.msg, /BillingError \(bundle:375590:12\)/);
  assert.ok(!detail.trigger.msg.includes("http://"), detail.trigger.msg);
});

test("incident frames relativize under display.root and honor extra plumbing", async () => {
  const { manifest, emit } = emitter({
    detectors: [{ name: "crash", detect: (e) => (e.attrs.exception === true ? { kind: "redbox", title: e.msg.split("\n")[0]! } : undefined) }],
  });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  emit({
    source: "react-native",
    deviceId: "dev",
    app: "app",
    level: "error",
    msg: "Error: x",
    deviceTs: T0,
    attrs: {
      exception: true,
      stack: [
        {
          methodName: "fromBubble",
          file: "/Users/x/app/node_modules/bugbubble/index.js",
          lineNumber: 1,
          column: 1,
        },
        {
          methodName: "onPress",
          file: "/Users/x/app/src/Screen.tsx",
          lineNumber: 10,
          column: 2,
        },
      ],
    },
  } as RawEvent);
  const [record] = host.incidents.list() as [IncidentRecord];
  const detail = incidentDetail(record, buffer.snapshot(), 8_000, nothingMuted, {
    root: "/Users/x/app",
    plumbing: ["bugbubble"],
  }) as Record<string, any>;
  assert.deepEqual(detail.stack.frames, ["onPress (src/Screen.tsx:10:2)"]);
});


test("context patterns are fitted nearest the trigger and shown by lastTs", async () => {
  const { record, events } = await scenario();
  const detail = incidentDetail(record, events, 8_000, nothingMuted) as Record<string, any>;
  const patterns = detail.context?.patterns ?? [];
  assert.ok(patterns.length >= 1, "at least one context pattern fits");
  for (let i = 1; i < patterns.length; i++) {
    assert.ok(patterns[i].lastTs >= patterns[i - 1].lastTs, "context patterns ordered by lastTs toward trigger");
  }
  // Tight budget: keep nearest-lastTs patterns first when fitting (poll lastTs is latest).
  const tight = incidentDetail(record, events, 2_200, nothingMuted) as Record<string, any>;
  if (!tight.omittedParts?.includes("context") && (tight.context?.patterns?.length ?? 0) > 0) {
    const last = tight.context.patterns.at(-1);
    assert.ok(last.lastTs >= tight.context.patterns[0].lastTs);
  }
});

test("an incident is stale only while every occurrence predates startedAt", async () => {
  const { record, events } = await scenario();
  const startedAt = record.lastTs + 1;
  const stale = incidentDetail(record, events, 8_000, nothingMuted, {}, startedAt) as Record<string, any>;
  assert.equal(stale.stale, true);
  assert.equal(stale.startedAt, startedAt);
  const recurred = { ...record, lastTs: startedAt };
  assert.equal((incidentDetail(recurred, events, 8_000, nothingMuted, {}, startedAt) as Record<string, any>).stale, undefined);
  assert.equal(listIncidents([recurred], { startedAt }).incidents[0]!.stale, undefined, "a recurrence since start makes it live");
  assert.equal(listIncidents([record], { startedAt }).incidents[0]!.stale, true);
});

test("an Android Java crash shows the frames of its trace", async () => {
  const { manifest, emit } = emitter({ detectors: [nativeCrashDetector()] });
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  const [crash] = parseLogcatEntries(readFileSync(JAVA_CRASH_LOG));
  emit({ source: "android", deviceId: "dev", app: "app", level: crash!.level, msg: crash!.msg, deviceTs: T0, attrs: { tag: crash!.tag } } as RawEvent);
  const [record] = host.incidents.list() as [IncidentRecord];
  const detail = incidentDetail(record, buffer.snapshot(), 8_000, nothingMuted) as Record<string, any>;
  assert.equal(detail.stack.frames[0], "android.app.ActivityThread.throwRemoteServiceException (ActivityThread.java:2377)");
  assert.equal(detail.stack.totalFrames, crash!.msg.split("\n").filter((line) => /^\tat .*:\d+\)$/.test(line)).length);
});
