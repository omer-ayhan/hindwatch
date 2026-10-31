import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeTraceEntry, parseXmlPlist, startActivityRequest, TraceFrames, type TraceEntry } from "@hindwatch/core";
import { OS_TRACE_LOG, relayFrames } from "./helpers.js";
import { test } from "./timed.js";

const APP = "/private/var/containers/Bundle/Application/5F0C2A9E-7B41-4D3A-9C6E-2B8F1D4A7E30/HindwatchRN.app";

const RECORDED: TraceEntry[] = [
  {
    pid: 8336,
    deviceTs: 1793363229725,
    level: "info",
    process: "/usr/libexec/locationd",
    image: "/usr/libexec/locationd",
    msg: "CL: CLMotionStateMediator::onStepCountNotification",
    subsystem: "",
    category: "",
  },
  {
    pid: 14125,
    deviceTs: 1793363236838,
    level: "info",
    process: `${APP}/HindwatchRN`,
    image: `${APP}/HindwatchRN.debug.dylib`,
    msg: "'hwburst 1793363236764 0  ü😀', { i: 0, nested: { a: [ 1, 2 ] } }",
    subsystem: "com.facebook.react.log",
    category: "javascript",
  },
  {
    pid: 14125,
    deviceTs: 1793363236849,
    level: "error",
    process: `${APP}/HindwatchRN`,
    image: `${APP}/HindwatchRN.debug.dylib`,
    msg: "'hwburst 1793363236764 3 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ü😀', { i: 3, nested: { a: [ 1, 2 ] } }",
    subsystem: "com.facebook.react.log",
    category: "javascript",
  },
];

/** The frames in the recording, each as [kind, body]. */
const frames = (recorded: Buffer): [number, Buffer][] => relayFrames(recorded).map((frame) => [frame[0]!, frame.subarray(5)]);

const entryFrame = (body: Buffer) => {
  const header = Buffer.alloc(5);
  header[0] = 2;
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
};

test("the recorded relay output reads as its reply and entries however reads cut it, an entry with no subsystem included", async () => {
  const recorded = await readFile(OS_TRACE_LOG);
  for (const size of [1, 7, 64, recorded.length]) {
    const entries: TraceEntry[] = [];
    let started = 0;
    const reader = new TraceFrames((entry) => entries.push(entry), () => started++);
    for (let at = 0; at < recorded.length; at += size) reader.push(recorded.subarray(at, at + size));
    assert.equal(started, 1, `started once, in ${size}-byte reads`);
    assert.deepEqual(entries, RECORDED, `in ${size}-byte reads`);
  }
});

test("each relay message type maps to the level the simulator's log stream gives it", async () => {
  const [, body] = frames(await readFile(OS_TRACE_LOG))[2]!;
  const levelOf = (type: number) => {
    const entry = Buffer.from(body);
    entry[68] = type;
    return decodeTraceEntry(entry)?.level;
  };
  assert.deepEqual([0x00, 0x01, 0x02, 0x10, 0x11].map(levelOf), ["info", "info", "debug", "error", "fatal"]);
  assert.equal(levelOf(0x42), undefined, "an unknown type is no entry");
  assert.equal(decodeTraceEntry(body.subarray(0, 100)), undefined, "nor is an entry cut short");
  const misfit = Buffer.from(body);
  misfit.writeUInt32LE(0x0954_0000, 117);
  assert.deepEqual([decodeTraceEntry(misfit)?.subsystem, decodeTraceEntry(misfit)?.category], ["", ""], "sizes that don't fit what follows the message are no label");
});

test("a refused stream and bytes that aren't relay frames are errors", async () => {
  const recorded = await readFile(OS_TRACE_LOG);
  const reply = Buffer.from(recorded.subarray(0, 5 + recorded.readUInt32BE(1)).toString("latin1").replace("RequestSuccessful", "RequestNotAllowed"), "latin1");
  assert.throws(() => new TraceFrames(() => {}).push(reply), /os_trace_relay refused to stream: RequestNotAllowed/);
  assert.throws(() => new TraceFrames(() => {}).push(Buffer.from("<?xml version")), /os_trace_relay sent an unknown frame 0x3c/);
  const [, body] = frames(recorded)[1]!;
  const entries: TraceEntry[] = [];
  new TraceFrames((entry) => entries.push(entry)).push(entryFrame(body));
  assert.equal(entries.length, 1, "entries need no reply before them");
  const [started] = relayFrames(recorded);
  assert.throws(() => new TraceFrames(() => {}).push(Buffer.concat([started!, started!])), /os_trace_relay answered StartActivity twice/);
});

test("only the processes wanted are handed on, and an unwanted entry is let go at its process path", async () => {
  const recorded = await readFile(OS_TRACE_LOG);
  const asked: string[] = [];
  const entries: TraceEntry[] = [];
  new TraceFrames((entry) => entries.push(entry), () => {}, (process) => {
    asked.push(process);
    return process.endsWith("/HindwatchRN");
  }).push(recorded);
  assert.deepEqual(asked, RECORDED.map((entry) => entry.process));
  assert.deepEqual(entries, RECORDED.slice(1));
});

test("StartActivity asks for every message type from every process", () => {
  const request = startActivityRequest();
  assert.equal(request.readUInt32BE(0), request.length - 4);
  assert.deepEqual(parseXmlPlist(request.subarray(4).toString()), { Request: "StartActivity", MessageFilter: 0xffff, Pid: -1, StreamFlags: 0x3c });
});
