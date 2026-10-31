import assert from "node:assert/strict";
import {
  compactAttrs,
  compactQueryPage,
  formatCompactFrame,
  runQuery,
  shortenBundlesInText,
  toCompactEvent,
  type DebugEvent,
} from "@hindwatch/core";
import { test } from "./timed.js";

const sizeOf = (value: unknown): number => JSON.stringify(value).length;

const BUNDLE =
  "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable";

function event(partial: Partial<DebugEvent> & Pick<DebugEvent, "id" | "msg">): DebugEvent {
  return {
    schemaVersion: 1,
    ts: 1_000 + partial.id,
    deviceTs: 1_000 + partial.id,
    hostTs: 2_000 + partial.id,
    estimated: false,
    source: "react-native",
    deviceId: "dev-a",
    app: "com.example.app",
    sessionId: "sess-1",
    pid: null,
    level: "error",
    attrs: {},
    ...partial,
  };
}

test("shortenBundlesInText turns Metro URLs into bundle:line:col", () => {
  const msg = `at BillingError (${BUNDLE}:375590:12)\n    at getError (${BUNDLE}:376117:29)`;
  const out = shortenBundlesInText(msg);
  assert.equal(out, "at BillingError (bundle:375590:12)\n    at getError (bundle:376117:29)");
  assert.ok(!out.includes("http://"));
  assert.ok(out.length < msg.length - 200);
});

test("formatCompactFrame shortens bundle files and keeps symbolicated paths short", () => {
  assert.equal(
    formatCompactFrame({ methodName: "BillingError", file: `${BUNDLE}`, lineNumber: 375590, column: 12 }),
    "BillingError (bundle:375590:12)",
  );
  assert.equal(
    formatCompactFrame({
      methodName: "paywall",
      file: "/Users/dev/Projects/app/node_modules/@acme/billing/dist/index.js",
      lineNumber: 42,
      column: 3,
    }),
    "paywall (/Users/dev/Projects/app/node_modules/@acme/billing/dist/index.js:42:3)",
  );
  assert.equal(
    formatCompactFrame(
      {
        methodName: "onPress",
        file: "/Users/dev/Projects/app/src/Screen.tsx",
        lineNumber: 10,
        column: 2,
      },
      { root: "/Users/dev/Projects/app" },
    ),
    "onPress (src/Screen.tsx:10:2)",
  );
});

test("compactAttrs keeps a short stack and drops codeFrame", () => {
  const attrs = compactAttrs({
    symbolicated: true,
    codeFrame: { content: "x".repeat(2_000) },
    stack: Array.from({ length: 12 }, (_, i) => ({
      methodName: `fn${i}`,
      file: `${BUNDLE}`,
      lineNumber: 100 + i,
      column: 1,
    })),
  });
  assert.equal(attrs?.symbolicated, true);
  assert.equal(attrs?.codeFrame, undefined);
  assert.equal((attrs?.stack as string[]).length, 8);
  assert.equal(attrs?.stackOmitted, 4);
  assert.ok((attrs?.stack as string[])[0]!.includes("bundle:"));
});

test("compactAttrs keeps tag, subsystem and category; skips plumbing frames", () => {
  const attrs = compactAttrs(
    {
      tag: "ReactNativeJS",
      subsystem: "com.apple.network",
      category: "connection",
      stack: [
        {
          methodName: "error",
          file: "/app/node_modules/react-native/Libraries/Core/console.js",
          lineNumber: 1,
          column: 1,
        },
        {
          methodName: "onPress",
          file: "/Users/x/app/src/Screen.tsx",
          lineNumber: 42,
          column: 3,
        },
        {
          methodName: "fromBubble",
          file: "/Users/x/app/node_modules/bugbubble/index.js",
          lineNumber: 9,
          column: 1,
        },
      ],
    },
    { root: "/Users/x/app", plumbing: ["bugbubble"] },
  );
  assert.equal(attrs?.tag, "ReactNativeJS");
  assert.equal(attrs?.subsystem, "com.apple.network");
  assert.equal(attrs?.category, "connection");
  assert.deepEqual(attrs?.stack, ["onPress (src/Screen.tsx:42:3)"]);
  assert.equal(attrs?.stackOmitted, 2);
});

test("compactQueryPage hoists shared identity and strips it from events", () => {
  const page = compactQueryPage([
    event({ id: 1, msg: "a" }),
    event({ id: 2, msg: "b" }),
  ]);
  assert.deepEqual(page.envelope, {
    schemaVersion: 1,
    sessionId: "sess-1",
    deviceId: "dev-a",
    app: "com.example.app",
  });
  for (const e of page.events) {
    assert.equal(e.sessionId, undefined);
    assert.equal(e.deviceId, undefined);
    assert.equal(e.app, undefined);
    assert.equal(e.estimated, undefined);
    assert.equal(e.pid, undefined);
    assert.ok(!("estimated" in e));
    assert.ok(!("pid" in e));
    assert.ok(e.id !== undefined && e.msg !== undefined);
  }
});

test("compactQueryPage leaves identity on events when values differ", () => {
  const page = compactQueryPage([
    event({ id: 1, msg: "a", deviceId: "phone" }),
    event({ id: 2, msg: "b", deviceId: "sim" }),
  ]);
  assert.equal(page.envelope.deviceId, undefined);
  assert.deepEqual(
    page.events.map((e) => e.deviceId),
    ["phone", "sim"],
  );
});

test("under the same char budget, compact pages fit more useful content than raw events", () => {
  const budget = 1_500;
  const stackMsg = `Uncaught Error: boom\n    at BillingError (${BUNDLE}:375590:12)\n    at getError (${BUNDLE}:376117:29)\n    at parse (${BUNDLE}:376200:5)`;
  const events = Array.from({ length: 20 }, (_, i) =>
    event({
      id: i + 1,
      msg: stackMsg,
      attrs: {
        symbolicated: true,
        codeFrame: { content: "huge ".repeat(200) },
        stack: [
          { methodName: "BillingError", file: `${BUNDLE}`, lineNumber: 375590, column: 12 },
          { methodName: "getError", file: `${BUNDLE}`, lineNumber: 376117, column: 29 },
          {
            methodName: "paywall",
            file: "/Users/x/app/node_modules/@acme/billing/dist/index.js",
            lineNumber: 10,
            column: 1,
          },
        ],
      },
    }),
  );

  // Before: packing raw DebugEvent size (what fitPage used to measure) underfills once
  // the response is considered — approximate by sizing raw events alone.
  let rawUsed = sizeOf({ events: [] as DebugEvent[], truncated: false, omitted: 0, muted: 0, next: null, lastId: 0 });
  let rawCount = 0;
  for (const e of events) {
    const next = rawUsed + sizeOf(e) + 1;
    if (next > budget) break;
    rawUsed = next;
    rawCount++;
  }

  const compact = runQuery(events, { budgetChars: budget });
  assert.ok(sizeOf(compact) <= budget, `compact page is ${sizeOf(compact)} chars`);
  assert.ok(compact.events.length > rawCount, `compact fits ${compact.events.length} vs raw packing ${rawCount}`);
  assert.ok(compact.events.length >= 2, `expected several compact events, got ${compact.events.length}`);
  assert.equal(compact.schemaVersion, 1);
  assert.equal(compact.app, "com.example.app");
  assert.ok(!JSON.stringify(compact).includes("http://127.0.0.1"));
  assert.ok(compact.events.some((e) => e.attrs?.stack !== undefined), "stack survives when budget allows");
  assert.ok(compact.events.every((e) => e.msg.includes("bundle:")), "msgs use shortened bundles");
  // Envelope chars are not repeated per event.
  assert.ok(!("schemaVersion" in compact.events[0]!));
  assert.ok(!("deviceTs" in compact.events[0]!));
  assert.ok(!("hostTs" in compact.events[0]!));
});

test("toCompactEvent shortens msg and omits empty attrs", () => {
  const c = toCompactEvent(event({ id: 1, msg: `x (${BUNDLE}:1:2)`, attrs: {} }));
  assert.equal(c.msg, "x (bundle:1:2)");
  assert.equal(c.attrs, undefined);
  assert.ok(!("pid" in c));
  assert.ok(!("estimated" in c));
});

test("compact pages omit default pid/estimated but keep real pid and estimated true", () => {
  const page = compactQueryPage([
    event({ id: 1, msg: "plain", pid: null, estimated: false }),
    event({ id: 2, msg: "gap", pid: 4242, estimated: true }),
  ]);
  assert.ok(!("pid" in page.events[0]!));
  assert.ok(!("estimated" in page.events[0]!));
  assert.equal(page.events[1]!.pid, 4242);
  assert.equal(page.events[1]!.estimated, true);
});
