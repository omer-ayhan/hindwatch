import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANR_BUFFER, ANR_TAG, nativeCrashDetector, parseLogcatEntries, SCHEMA_VERSION, type DebugEvent } from "@hindwatch/core";
import { ANR_LOG, JAVA_CRASH_LOG } from "./helpers.js";
import { test } from "./timed.js";

let nextId = 0;
const event = (source: string, msg: string, attrs: Record<string, unknown> = {}, pid: number | null = 1111): DebugEvent => ({
  schemaVersion: SCHEMA_VERSION,
  id: ++nextId,
  ts: nextId,
  deviceTs: nextId,
  hostTs: nextId,
  estimated: false,
  source,
  deviceId: "emulator-5554",
  app: "com.example",
  sessionId: "s",
  pid,
  level: "error",
  msg,
  attrs,
});
const android = (tag: string, msg: string, pid?: number) => event("android", msg, { tag }, pid);

test("an Android Java crash is titled by its exception line, after FATAL EXCEPTION and Process:", () => {
  const [crash] = parseLogcatEntries(readFileSync(JAVA_CRASH_LOG));
  assert.deepEqual(nativeCrashDetector().detect(android(crash!.tag, crash!.msg)), {
    kind: "crash",
    title: "android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash",
  });
});

test("a Java crash cut before its exception line is titled by its first line; other AndroidRuntime lines raise nothing", () => {
  const detector = nativeCrashDetector();
  assert.deepEqual(detector.detect(android("AndroidRuntime", "FATAL EXCEPTION: main\nProcess: com.example, PID: 1111")), {
    kind: "crash",
    title: "FATAL EXCEPTION: main",
  });
  assert.equal(detector.detect(android("AndroidRuntime", "Shutting down VM")), undefined);
  assert.equal(detector.detect(android("ReactNativeJS", "FATAL EXCEPTION: main\njava.lang.Error: look-alike")), undefined);
});

test("native signals, system ANRs and simulator crash reports raise; look-alikes don't", () => {
  const detector = nativeCrashDetector();
  const signal = "Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 1135 (main)";
  assert.deepEqual(detector.detect(android("libc", signal)), { kind: "crash", title: signal });
  const [report] = parseLogcatEntries(readFileSync(ANR_LOG));
  const anr = report!.msg.split("\n")[0]!;
  assert.deepEqual(detector.detect(event("android", report!.msg, { tag: ANR_TAG, buffer: ANR_BUFFER })), { kind: "anr", title: anr });
  assert.equal(detector.detect(event("android", anr, { tag: ANR_TAG })), undefined, "only system_server's buffer reports ANRs");
  const crash = "FixtureApp crashed with EXC_BAD_ACCESS (SIGSEGV)";
  assert.deepEqual(detector.detect(event("ios-sim", crash, { crashReport: "/tmp/FixtureApp-1.ips" })), { kind: "crash", title: crash });
  assert.equal(detector.detect(event("ios-sim", crash)), undefined);
  assert.deepEqual(detector.detect(event("ios", crash, { crashReport: "FixtureApp-2026-10-30-153150.ips" })), { kind: "crash", title: crash });
  assert.equal(detector.detect(event("ios", crash)), undefined);
  assert.equal(detector.detect(event("react-native", signal)), undefined);
});
