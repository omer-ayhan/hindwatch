import assert from "node:assert/strict";
import {
  Clocks,
  DeviceIdentity,
  EventBuffer,
  PLUGIN_API_VERSION,
  type Enricher,
  type PluginManifest,
  type RawEvent,
  type SourceContext,
} from "@hindwatch/core";
import { pipeline, until } from "./helpers.js";
import { test } from "./timed.js";

test("the first RN or native id for an app is canonical; its pair aliases onto it", () => {
  const identity = new DeviceIdentity();
  assert.deepEqual(identity.bind("com.app", "udid-a", "ios-sim"), { canonical: "udid-a" });
  assert.deepEqual(identity.bind("com.app", "logical-b", "react-native"), {
    canonical: "udid-a",
    aliasedFrom: "logical-b",
  });
  assert.deepEqual(identity.bind("com.app", "logical-b", "react-native"), { canonical: "udid-a" });
  assert.equal(identity.remap("logical-b"), "udid-a");
  assert.equal(identity.remap("udid-a"), "udid-a");
  assert.equal(identity.remap("unknown"), "unknown");
});

test("a physical iPhone pairs with RN like the simulator, and stays apart from a simulator running the same app", () => {
  const identity = new DeviceIdentity();
  assert.equal(identity.bind("com.app", "logical-b", "react-native").canonical, "logical-b");
  assert.deepEqual(identity.bind("com.app", "00008110-IPHONE", "ios"), { canonical: "00008110-IPHONE", aliasedFrom: "logical-b" });
  assert.equal(identity.remap("logical-b"), "00008110-IPHONE");
  assert.deepEqual(identity.bind("com.app", "SIM-UDID", "ios-sim"), { canonical: "SIM-UDID" });
});

test("RN first flips canonical onto the simulator UDID when native joins", () => {
  const identity = new DeviceIdentity();
  assert.equal(identity.bind("com.app", "logical-b", "react-native").canonical, "logical-b");
  assert.deepEqual(identity.bind("com.app", "udid-a", "ios-sim"), {
    canonical: "udid-a",
    aliasedFrom: "logical-b",
  });
  assert.equal(identity.remap("logical-b"), "udid-a");
  assert.equal(identity.bind("com.app", "logical-b", "react-native").canonical, "udid-a");
});

test("two native devices for the same app stay distinct", () => {
  const identity = new DeviceIdentity();
  assert.equal(identity.bind("com.app", "android-a", "android").canonical, "android-a");
  assert.equal(identity.bind("com.app", "ios-b", "ios-sim").canonical, "ios-b");
});

test("fixture and other sources never merge device ids", () => {
  const identity = new DeviceIdentity();
  assert.equal(identity.bind("com.app", "android-a", "fixture").canonical, "android-a");
  assert.equal(identity.bind("com.app", "ios-b", "fixture").canonical, "ios-b");
  assert.equal(identity.bind("com.app", "logical", "react-native").canonical, "logical");
});

test("different apps keep separate canonical device ids", () => {
  const identity = new DeviceIdentity();
  assert.equal(identity.bind("com.a", "dev-1", "ios-sim").canonical, "dev-1");
  assert.equal(identity.bind("com.b", "dev-2", "ios-sim").canonical, "dev-2");
  assert.equal(identity.bind("com.a", "logical", "react-native").canonical, "dev-1");
});

test("Clocks.rekey moves an offset onto the canonical id", () => {
  const clocks = new Clocks();
  clocks.setSample("logical-b", { deviceTs: 1_000, hostTs: 900 });
  clocks.rekey("logical-b", "udid-a");
  assert.deepEqual(clocks.toHost("udid-a", 1_100, 0), { ts: 1_000, estimated: false });
  assert.deepEqual(clocks.toHost("logical-b", 1_100, 50), { ts: 50, estimated: true });
});

test("Clocks.rekey keeps the destination sample when both exist", () => {
  const clocks = new Clocks();
  clocks.setSample("udid-a", { deviceTs: 500, hostTs: 500 });
  clocks.setSample("logical-b", { deviceTs: 1_000, hostTs: 900 });
  clocks.rekey("logical-b", "udid-a");
  assert.deepEqual(clocks.toHost("udid-a", 600, 0), { ts: 600, estimated: false });
});

test("RN and ios-sim ids for the same app collapse to one deviceId and one session", async () => {
  const contexts: SourceContext[] = [];
  const manifest: PluginManifest = {
    name: "dual",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      { name: "ios-sim", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
      { name: "react-native", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
    ],
  };
  const { host, buffer, clocks } = pipeline();
  host.add(manifest);
  await host.startAll();
  const [sim, rn] = contexts;
  assert.ok(sim && rn);

  sim.setClockSample("2E90-UDID", { deviceTs: 10_000, hostTs: 10_000 });
  sim.emit({
    source: "ios-sim",
    deviceId: "2E90-UDID",
    app: "com.hindwatch.fixture",
    level: "info",
    msg: "from sim",
    deviceTs: 10_100,
  } satisfies RawEvent);
  rn.setClockSample("85bc-logical", { deviceTs: 10_050, hostTs: 10_000 });
  rn.emit({
    source: "react-native",
    deviceId: "85bc-logical",
    app: "com.hindwatch.fixture",
    level: "info",
    msg: "from rn",
    deviceTs: 10_200,
  } satisfies RawEvent);
  await host.settled();

  const events = buffer.snapshot();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.deviceId),
    ["2E90-UDID", "2E90-UDID"],
  );
  assert.equal(new Set(events.map((e) => e.sessionId)).size, 1);
  assert.equal(events[1]!.estimated, false);
  assert.deepEqual(clocks.toHost("2E90-UDID", 10_200, 0), { ts: 10_200, estimated: false });
});

test("RN-first rewrites buffered deviceIds onto UDID when native attaches", async () => {
  const contexts: SourceContext[] = [];
  const manifest: PluginManifest = {
    name: "dual",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      { name: "react-native", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
      { name: "ios-sim", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
    ],
  };
  const mutedBuffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const isMuted = () => (e: { msg: string }) => e.msg.startsWith("noise");
  const { host, buffer } = pipeline(() => {}, { mutedBuffer, isMuted });
  host.add(manifest);
  await host.startAll();
  const [rn, sim] = contexts;
  assert.ok(rn && sim);

  rn.emit({
    source: "react-native",
    deviceId: "85bc-logical",
    app: "com.hindwatch.fixture",
    level: "info",
    msg: "from rn",
  } satisfies RawEvent);
  rn.emit({
    source: "react-native",
    deviceId: "85bc-logical",
    app: "com.hindwatch.fixture",
    level: "info",
    msg: "noise muted early",
  } satisfies RawEvent);
  await host.settled();
  assert.deepEqual(buffer.snapshot().map((e) => e.deviceId), ["85bc-logical"]);
  assert.deepEqual(mutedBuffer.snapshot().map((e) => e.deviceId), ["85bc-logical"]);

  sim.emit({
    source: "ios-sim",
    deviceId: "2E90-UDID",
    app: "com.hindwatch.fixture",
    level: "info",
    msg: "from sim",
  } satisfies RawEvent);
  await host.settled();

  assert.deepEqual(
    buffer.snapshot().map((e) => e.deviceId),
    ["2E90-UDID", "2E90-UDID"],
    "main buffer must rewrite Metro id onto UDID",
  );
  assert.deepEqual(
    mutedBuffer.snapshot().map((e) => e.deviceId),
    ["2E90-UDID"],
    "muted side-buffer must rewrite too",
  );
  assert.equal(new Set(buffer.snapshot().map((e) => e.sessionId)).size, 1);
});

test("a skewed multi-device fixture keeps each device id", async () => {
  let ctx: SourceContext | undefined;
  const manifest: PluginManifest = {
    name: "fixture",
    apiVersion: PLUGIN_API_VERSION,
    sources: [{ name: "fixture", start: async (c) => void (ctx = c), stop: async () => {} }],
  };
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  ctx!.emit({ source: "fixture", deviceId: "android-a", app: "com.hindwatch.fixture", level: "info", msg: "a" });
  ctx!.emit({ source: "fixture", deviceId: "ios-b", app: "com.hindwatch.fixture", level: "info", msg: "b" });
  await host.settled();
  assert.deepEqual(
    buffer.snapshot().map((e) => e.deviceId),
    ["android-a", "ios-b"],
  );
  assert.equal(new Set(buffer.snapshot().map((e) => e.sessionId)).size, 2);
});

test("in-flight enrich commits remap onto UDID after native bind (live Metro split)", async () => {
  // Mirrors live RN: symbolicate queues events with Metro id baked in; ios-sim flips
  // identity while they are still enriching; store must not commit the stale Metro id.
  const contexts: SourceContext[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: Enricher = {
    name: "slow",
    // Like symbolicate: only RN waits; native stores promptly and flips identity mid-flight.
    enrich: async (event) => {
      if (event.source !== "react-native") return undefined;
      await gate;
      return undefined;
    },
  };
  const manifest: PluginManifest = {
    name: "dual",
    apiVersion: PLUGIN_API_VERSION,
    enrichers: [slow],
    sources: [
      { name: "react-native", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
      { name: "ios-sim", start: async (ctx) => void contexts.push(ctx), stop: async () => {} },
    ],
  };
  const { host, buffer } = pipeline();
  host.add(manifest);
  await host.startAll();
  const [rn, sim] = contexts;
  assert.ok(rn && sim);

  for (let i = 0; i < 20; i++) {
    rn.emit({
      source: "react-native",
      deviceId: "85bc-logical",
      app: "com.example.app",
      level: "info",
      msg: `rn-${i}`,
    } satisfies RawEvent);
  }
  // Let the enrich queue pick up the Metro-baked events before native joins.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(buffer.snapshot().length, 0, "enrich still holding all RN events");

  sim.emit({
    source: "ios-sim",
    deviceId: "2E90-UDID",
    app: "com.example.app",
    level: "info",
    msg: "from sim",
  } satisfies RawEvent);
  // Native bind flips + rewrite runs while RN is still enriching (buffer has only the sim row).
  // Do not settled() yet — that waits on the gated RN queue.
  await until(() => buffer.snapshot().length === 1, "sim event stored");
  assert.deepEqual(buffer.snapshot().map((e) => e.deviceId), ["2E90-UDID"]);

  release();
  await host.settled();

  const ids = [...new Set(buffer.snapshot().map((e) => e.deviceId))];
  assert.deepEqual(ids, ["2E90-UDID"], "export must show one deviceId after enrich drains");
  assert.equal(buffer.snapshot().length, 21);
  assert.equal(new Set(buffer.snapshot().map((e) => e.sessionId)).size, 1);
});
