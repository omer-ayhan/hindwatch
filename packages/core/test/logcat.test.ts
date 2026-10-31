import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLogcatEntries } from "@hindwatch/core";
import { ANR_LOG, JAVA_CRASH_LOG, logcatFrame } from "./helpers.js";
import { test } from "./timed.js";

const JAVA_CRASH = readFileSync(JAVA_CRASH_LOG);
const ANR = readFileSync(ANR_LOG);

test("a Java crash decodes as the one entry it was logged as, stamped to the nanosecond", () => {
  const [crash, ...rest] = parseLogcatEntries(JAVA_CRASH);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { pid: crash!.pid, level: crash!.level, tag: crash!.tag, stamp: crash!.stamp, deviceTs: crash!.deviceTs, key: crash!.key },
    {
      pid: 25282,
      level: "error",
      tag: "AndroidRuntime",
      stamp: "1793348067.517382901",
      deviceTs: 1793348067517,
      key: "1793348067.517382901 25282 25282",
    },
  );
  assert.deepEqual(crash!.msg.split("\n").slice(0, 3), [
    "FATAL EXCEPTION: main",
    "Process: com.example.app, PID: 25282",
    "android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash",
  ]);
  assert.match(crash!.msg, /\tat com\.android\.internal\.os\.ZygoteInit\.main\(ZygoteInit\.java:\d+\)$/);
});

test("an ANR report keeps its reason, and the blank line inside it with what follows", () => {
  const [anr] = parseLogcatEntries(ANR);
  assert.match(anr!.msg, /^ANR in com\.example\.app \(.*\)\nPID: \d+\nReason: Input dispatching timed out/);
  assert.match(anr!.msg, /-----\n\nCPU usage from/);
});

test("a tag too long for logcat's text header comes whole, apart from its message", () => {
  const tag = "com.reactnativekeyboardcontroller.modules.statusbar.StatusBarManagerCompatModuleImpStatusBarModule";
  const [entry] = parseLogcatEntries(logcatFrame({ sec: 1793347542, nsec: 558484109, pid: 24462, tid: 24598, priority: 5, tag, msg: "Ignored status bar change" }));
  assert.deepEqual([entry!.tag, entry!.msg, entry!.level], [tag, "Ignored status bar change", "warn"]);
});

test("an entry cut short is held back, not decoded from part of its bytes", () => {
  assert.deepEqual(parseLogcatEntries(JAVA_CRASH.subarray(0, JAVA_CRASH.length - 1)), []);
});

const RECORD = { sec: 1793347542, nsec: 558484109, pid: 24462, tid: 24598, priority: 4, tag: "ReactNativeJS", msg: "hello" };

test("an entry from a device whose header carries no size of its own decodes with the 20-byte header", () => {
  const frame = logcatFrame(RECORD);
  const old = Buffer.concat([frame.subarray(0, 20), frame.subarray(28)]);
  old.writeUInt16LE(0, 2);
  const [entry] = parseLogcatEntries(Buffer.concat([old, old]));
  assert.deepEqual([entry!.key, entry!.tag, entry!.msg], ["1793347542.558484109 24462 24598", "ReactNativeJS", "hello"]);
  assert.equal(parseLogcatEntries(Buffer.concat([old, old])).length, 2);
});

test("a header shorter than liblog's first one is refused, not decoded", () => {
  const frame = logcatFrame(RECORD);
  frame.writeUInt16LE(8, 2);
  assert.throws(() => parseLogcatEntries(frame), /not binary entries: a 8-byte header/);
});
