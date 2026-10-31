import assert from "node:assert/strict";
import { sizeOf } from "../src/budget.js";
import { omitEmpty } from "../src/util.js";
import { test } from "./timed.js";

/** Fixed logs + patterns shaped like MCP envelopes (null next, empty optionals). */
const LOGS_FIXTURE = {
  schemaVersion: 1,
  sessionId: "sess-1",
  deviceId: "dev-a",
  app: "com.example.app",
  startedAt: 1_700_000_000_000,
  order: "asc" as const,
  note: "",
  hint: null as string | null,
  extra: undefined as string | undefined,
  meta: {} as Record<string, unknown>,
  nested: { tag: null as string | null, empty: "", keep: "x" },
  events: [] as unknown[],
  truncated: false,
  omitted: 0,
  muted: 0,
  next: null as string | null,
  lastId: 42,
};

const PATTERNS_FIXTURE = {
  schemaVersion: 1,
  patterns: [] as unknown[],
  events: 0,
  truncated: false,
  omitted: 0,
  muted: 0,
  next: null as string | null,
  lastId: 42,
  unused: null as null,
  blank: "",
  emptyObj: {},
};

test("omitEmpty drops null/undefined/empty optionals and keeps intentional empties", () => {
  const out = omitEmpty(LOGS_FIXTURE) as Record<string, unknown>;
  assert.equal("hint" in out, false);
  assert.equal("extra" in out, false);
  assert.equal("note" in out, false);
  assert.equal("meta" in out, false);
  assert.equal("next" in out, false);
  assert.deepEqual(out.events, []);
  assert.equal(out.omitted, 0);
  assert.equal(out.muted, 0);
  assert.equal(out.truncated, false);
  assert.equal(out.lastId, 42);
  const nested = out.nested as Record<string, unknown>;
  assert.deepEqual(nested, { keep: "x" });
});

test("omitEmpty sizeOf drops on fixed logs+patterns fixtures", () => {
  const logsBefore = sizeOf(LOGS_FIXTURE);
  const logsAfter = sizeOf(omitEmpty(LOGS_FIXTURE));
  const patternsBefore = sizeOf(PATTERNS_FIXTURE);
  const patternsAfter = sizeOf(omitEmpty(PATTERNS_FIXTURE));

  assert.ok(logsAfter < logsBefore, `logs sizeOf ${logsBefore} → ${logsAfter}`);
  assert.ok(patternsAfter < patternsBefore, `patterns sizeOf ${patternsBefore} → ${patternsAfter}`);

  const patterns = omitEmpty(PATTERNS_FIXTURE) as Record<string, unknown>;
  assert.deepEqual(patterns.patterns, []);
  assert.equal(patterns.events, 0);
  assert.equal("next" in patterns, false);
  assert.equal("unused" in patterns, false);
  assert.equal("blank" in patterns, false);
  assert.equal("emptyObj" in patterns, false);

  // Surfaced for the Wave U1 prove bar (also asserted above).
  console.log(
    JSON.stringify({
      logs: { before: logsBefore, after: logsAfter, delta: logsBefore - logsAfter },
      patterns: { before: patternsBefore, after: patternsAfter, delta: patternsBefore - patternsAfter },
    }),
  );
});

test("omitEmpty leaves arrays of objects cleaned but never drops the array", () => {
  const out = omitEmpty({
    events: [{ id: 1, msg: "a", pad: null, attrs: {} }],
  }) as { events: Record<string, unknown>[] };
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0], { id: 1, msg: "a" });
});
