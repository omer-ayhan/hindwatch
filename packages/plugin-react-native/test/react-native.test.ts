import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGET_CHARS,
  expectEvents,
  incidentDetail,
  listIncidents,
  Marks,
  MIN_BUDGET_CHARS,
  waitFor,
  type DebugEvent,
  type RedactedEvent,
} from "@hindwatch/core";
import createPlugin, {
  createReactNativePlugin,
  formatArg,
  parseCdpEvent,
  parseOptions,
  parseTargets,
  symbolicateEnricher,
  type Connect,
  type MetroOptions,
} from "@hindwatch/plugin-react-native";
import { pipeline, until } from "../../core/test/helpers.js";
import { test } from "../../core/test/timed.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/cdp/${name}`, import.meta.url));
const DEVICE = "5f3c2a9e8b7d6c5b4a39281706f5e4d3c2b1a090";
const APP = "com.hindwatch.fixture";
/** Notifications in transcript.jsonl that become events: two are an execution context and a console.clear. */
const LOG_EVENTS = 7;
/** device clock minus host clock */
const DRIFT_MS = 3_000;
const OPTIONS: MetroOptions = { port: 8081, clockResyncMs: 60_000 };

interface FakeConnection {
  readonly url: string;
  readonly origin: string;
  readonly methods: string[];
  drop(reason?: string): void;
}

/** A Metro that lists one app and replays a recorded CDP transcript whenever Runtime.enable is sent. */
async function fakeMetro(recording: string) {
  const transcript = (await readFile(fixture(recording), "utf8")).split("\n").filter((l) => l !== "");
  const list: unknown = JSON.parse(await readFile(fixture("json-list.json"), "utf8"));
  const symbolicated: unknown = JSON.parse(await readFile(fixture("symbolicate.json"), "utf8"));
  const state = { up: true, failure: "refused" as "refused" | "timeout" | "garbled", pages: true, failClock: false, listRequests: 0, evaluations: 0, symbolicateBodies: [] as string[], later: [] as string[] };
  const connections: FakeConnection[] = [];

  const connect: Connect = (url, origin, handlers) => {
    let open = true;
    const methods: string[] = [];
    const reply = (message: object) => setImmediate(() => open && handlers.onMessage(JSON.stringify(message)));
    const close = (reason = "") => {
      if (!open) return;
      open = false;
      handlers.onClose(reason);
    };
    connections.push({ url, origin, methods, drop: close });
    setImmediate(() => handlers.onOpen());
    return {
      send(raw) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        methods.push(method);
        if (method === "Runtime.evaluate") {
          state.evaluations++;
          if (state.failClock) {
            reply({ id, error: { message: "Date.now() unavailable" } });
            return;
          }
          reply({ id, result: { result: { type: "number", value: Date.now() + DRIFT_MS } } });
          return;
        }
        // Like Hermes, Runtime.enable replays the console history before it replies.
        if (method === "Runtime.enable") setImmediate(() => [...transcript, ...state.later].forEach((l) => open && handlers.onMessage(l)));
        reply({ id, result: {} });
      },
      close: () => close(),
    };
  };

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://localhost:8081/json/list") state.listRequests++;
    if (!state.up && state.failure === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (!state.up && state.failure === "refused") {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8081"), { code: "ECONNREFUSED" }) });
    }
    if (!state.up) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (url === "http://localhost:8081/json/list") return Response.json(state.pages ? list : []);
    if (url === "http://localhost:8081/symbolicate" && init?.method === "POST") {
      state.symbolicateBodies.push(String(init.body));
      return Response.json(symbolicated);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { state, connections, deps: { fetch: fakeFetch, connect, pollMs: 5 } };
}

async function attach(options: MetroOptions = OPTIONS, recording = "transcript.jsonl") {
  const metro = await fakeMetro(recording);
  const logs: string[] = [];
  const { host, buffer } = pipeline((message) => logs.push(message));
  const plugin = createReactNativePlugin(options, metro.deps);
  const seen = { enricher: [] as RedactedEvent[], detector: [] as DebugEvent[] };
  const [enricher] = plugin.enrichers ?? [];
  const [detector] = plugin.detectors ?? [];
  // Spies around the plugin's own enricher and detector record exactly what they were handed.
  host.add({
    ...plugin,
    enrichers: [{ name: enricher!.name, enrich: (e) => (seen.enricher.push(e), enricher!.enrich(e)) }],
    detectors: [{ name: detector!.name, detect: (e) => (seen.detector.push(e), detector!.detect(e)) }],
  });
  await host.startAll();
  const all = () => buffer.snapshot();
  const events = () => all().filter((e) => e.attrs.incident === undefined);
  const incidents = () => all().filter((e) => e.attrs.incident !== undefined);
  const stop = async () => {
    await host.stopAll();
    await host.settled();
  };
  return { ...metro, host, buffer, logs, seen, all, events, incidents, stop };
}

test("Metro's /json/list yields one target per debuggable app, reached through local Metro", async () => {
  const list: unknown = JSON.parse(await readFile(fixture("json-list.json"), "utf8"));
  assert.deepEqual(parseTargets(list), [
    { id: `${DEVICE}-1`, deviceId: DEVICE, app: APP, path: `/inspector/debug?device=${DEVICE}&page=1` },
  ]);
  assert.deepEqual(parseTargets({}), []);
});

test("a target advertising another host keeps only its path, so it is dialled on local Metro", () => {
  const [target] = parseTargets([{ id: "t", webSocketDebuggerUrl: "ws://192.0.2.7:9229//evil.example/inspector?page=1" }]);
  assert.equal(target!.path, "//evil.example/inspector?page=1");
  assert.equal(new URL(`ws://localhost:8081${target!.path}`).host, "localhost:8081");
});

test("console arguments render like a console, from CDP remote objects", () => {
  assert.equal(formatArg({ type: "string", value: "hi" }), "hi");
  assert.equal(formatArg({ type: "number", value: 1.5 }), "1.5");
  assert.equal(formatArg({ type: "number", unserializableValue: "NaN" }), "NaN");
  assert.equal(formatArg({ type: "undefined" }), "undefined");
  assert.equal(
    formatArg({ type: "object", preview: { overflow: true, properties: [{ name: "a", value: "1" }] } }),
    "{a: 1, …}",
  );
  assert.equal(formatArg({ type: "function", description: "function f() {}" }), "function f() {}");
  assert.equal(parseCdpEvent({ method: "Runtime.consoleAPICalled", params: { type: "clear", args: [] } }), undefined);
  assert.equal(parseCdpEvent({ method: "Debugger.paused", params: {} }), undefined);
});

test("console.error prefers the Error stack in msg over CDP's console call-site stackTrace", () => {
  const bundle = "http://127.0.0.1:8081/index.bundle//&platform=ios&dev=true";
  const event = parseCdpEvent({
    method: "Runtime.consoleAPICalled",
    params: {
      type: "error",
      args: [
        {
          type: "object",
          subtype: "error",
          className: "Error",
          description: `Error: boom\n    at onPress (${bundle}:42:19)\n    at handler (${bundle}:10:1)`,
        },
      ],
      stackTrace: {
        callFrames: [
          { functionName: "error", url: "http://127.0.0.1:8081/node_modules/react-native/Libraries/Core/console.js", lineNumber: 666, columnNumber: 28 },
        ],
      },
      timestamp: 1,
    },
  })!;
  assert.equal(event.level, "error");
  const stack = event.attrs!.stack as { methodName: string; file: string; lineNumber: number }[];
  assert.deepEqual(
    stack.map((f) => [f.methodName, f.lineNumber]),
    [
      ["onPress", 42],
      ["handler", 10],
    ],
  );
  assert.match(stack[0]!.file, /index\.bundle/);
  assert.equal(event.attrs!.exception, undefined, "a console.error the app made itself is not an uncaught error");
});

test("an uncaught error, which React Native reports through console.error, is an exception", async () => {
  // Captured from the app on an emulator after `setTimeout(() => { throw new TypeError(…) })`.
  const event = parseCdpEvent(JSON.parse(await readFile(fixture("fatal-console-error.json"), "utf8")))!;
  assert.equal(event.attrs!.exception, true);
  assert.match(event.msg, /^TypeError: hindwatch live fatal \d+\n/);
});

test("parseCdpEvent strips ANSI color from console, exception, and Log messages", () => {
  const red = "\u001b[31m";
  const reset = "\u001b[0m";
  const consoleEvt = parseCdpEvent({
    method: "Runtime.consoleAPICalled",
    params: { type: "warning", args: [{ type: "string", value: `${red}Require cycle${reset}` }], timestamp: 1 },
  })!;
  assert.equal(consoleEvt.msg, "Require cycle");

  const thrown = parseCdpEvent({
    method: "Runtime.exceptionThrown",
    params: {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: `${red}TypeError: boom${reset}\n    at onPress (http://127.0.0.1:8081/index.bundle:1:1)` },
      },
      timestamp: 2,
    },
  })!;
  assert.equal(thrown.msg.split("\n", 1)[0], "TypeError: boom");
  const stack = thrown.attrs!.stack as { methodName: string }[];
  assert.equal(stack[0]!.methodName, "onPress");

  const logged = parseCdpEvent({
    method: "Log.entryAdded",
    params: { entry: { level: "warning", text: `${red}possible${reset} issue`, source: "javascript", timestamp: 3 } },
  })!;
  assert.equal(logged.msg, "possible issue");
});

test("the recorded CDP transcript replays into events, with Metro's required Origin", async () => {
  const { connections, events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  await stop();
  const [connection] = connections;
  assert.equal(connection!.url, `ws://localhost:8081/inspector/debug?device=${DEVICE}&page=1`);
  assert.equal(connection!.origin, "http://127.0.0.1:8081");
  assert.deepEqual(connection!.methods, ["Runtime.evaluate", "Runtime.enable", "Log.enable"]);
  assert.deepEqual(
    events().map((e) => [e.level, e.msg.split("\n", 1)[0]]),
    [
      ["info", 'Running "main" with {"rootTag":1,"initialProps":{}}'],
      ["warn", "profile loaded {id: 42, plan: pro}"],
      ["debug", "render took 16.7 true [1, 2]"],
      ["warn", "Require cycle: src/a.ts -> src/b.ts -> src/a.ts"],
      ["info", "auth refreshed, Authorization: Bearer [REDACTED:bearer]"],
      ["error", "TypeError: Cannot read property 'name' of undefined"],
      ["warn", "Possible Unhandled Promise Rejection (id: 0):"],
    ],
  );
  assert.ok(events().every((e) => e.source === "react-native" && e.deviceId === DEVICE && e.app === APP));
});

test("the JS clock is measured over CDP before the replayed history, and on reconnect", async () => {
  const { connections, state, events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  for (const e of events()) {
    assert.equal(e.estimated, false);
    assert.ok(Math.abs(e.ts - (e.deviceTs! - DRIFT_MS)) < 50, "device time corrected by the measured drift");
  }
  connections[0]!.drop();
  await until(() => connections.length === 2 && state.evaluations === 2, "a reconnect that re-measures");
  await stop();
});

test("the JS clock is re-measured on the configured interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { state, events, stop } = await attach({ ...OPTIONS, clockResyncMs: 10_000 });
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  assert.equal(state.evaluations, 1);
  t.mock.timers.tick(10_000);
  await until(() => state.evaluations === 2, "a periodic re-measure");
  t.mock.timers.tick(10_000);
  await until(() => state.evaluations === 3, "another periodic re-measure");
  await stop();
});

test("a reconnect skips the history Runtime.enable replays and keeps new messages", async () => {
  const { connections, state, events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  const later = { method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ type: "string", value: "after reload" }], timestamp: 1792602669839.338 + 500 } };
  state.later.push(JSON.stringify(later));
  connections[0]!.drop();
  await until(() => events().length === LOG_EVENTS + 1, "the new message");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await stop();
  assert.equal(events().length, LOG_EVENTS + 1, "no replayed duplicates");
  assert.equal(events().at(-1)!.msg, "after reload");
});

test("a mark, wait-for and expect hold across a reload: the replayed history is not new", async () => {
  const { connections, state, events, stop, buffer } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  const marks = new Marks();
  marks.set("agent", "fix", buffer.lastId);
  const sinceFix = (text: string) => marks.resolve("agent", { sinceMark: "fix", text });
  const reloaded = waitFor(buffer, sinceFix("after reload"), 60_000, new AbortController().signal);
  const later = { method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ type: "string", value: "after reload" }], timestamp: 1792602669839.338 + 500 } };
  state.later.push(JSON.stringify(later));
  connections[0]!.drop();
  assert.equal((await reloaded)?.msg, "after reload");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await stop();
  assert.equal(expectEvents(buffer, sinceFix("Possible Unhandled Promise Rejection"), "absent", DEFAULT_BUDGET_CHARS).ok, true);
  assert.equal(expectEvents(buffer, { text: "Possible Unhandled Promise Rejection" }, "present", DEFAULT_BUDGET_CHARS).ok, true);
  assert.equal(expectEvents(buffer, sinceFix("after reload"), "present", DEFAULT_BUDGET_CHARS).matched, 1);
});

test("at the boundary millisecond a reconnect skips only messages already seen", async () => {
  const { connections, state, events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  const boundary = events().at(-1)!;
  // Logged in the same millisecond as the last message, but only after the socket dropped.
  const sameMs = {
    method: "Runtime.consoleAPICalled",
    params: { type: "warning", args: [{ type: "string", value: "same millisecond, not seen" }], timestamp: boundary.deviceTs },
  };
  state.later.push(JSON.stringify(sameMs));
  connections[0]!.drop();
  await until(() => events().length === LOG_EVENTS + 1, "the unseen boundary message");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await stop();
  assert.equal(events().length, LOG_EVENTS + 1, "the seen boundary message and older history are not re-stored");
  assert.deepEqual(
    events().slice(-2).map((e) => [e.msg.split("\n", 1)[0], e.deviceTs]),
    [
      ["Possible Unhandled Promise Rejection (id: 0):", boundary.deviceTs],
      ["same millisecond, not seen", boundary.deviceTs],
    ],
  );
});

test("plugins only see redacted events: the enricher, Metro's /symbolicate and the detector never get a secret", async () => {
  const { seen, state, events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  await stop();
  const leaks = /sk-live-|sk_live_/;
  assert.ok(seen.enricher.length >= LOG_EVENTS && seen.detector.length >= LOG_EVENTS);
  for (const e of [...seen.enricher, ...seen.detector]) assert.doesNotMatch(JSON.stringify(e), leaks);
  // The bundle URL in the stack carried a token; what went out to Metro was already redacted.
  assert.equal(state.symbolicateBodies.length, 2, "exception + console text with an Error stack");
  const exceptionBody = state.symbolicateBodies.find((b) => b.includes("index.bundle"))!;
  assert.ok(exceptionBody, "exception stack was sent to /symbolicate");
  assert.doesNotMatch(exceptionBody, leaks);
  assert.match(exceptionBody, /token=\[REDACTED:secret\]/);
  assert.match(exceptionBody, /"lineNumber":91234/, "CDP's 0-based lines become Metro's 1-based");
  for (const e of events()) assert.doesNotMatch(JSON.stringify(e), leaks);
});

test("symbolicated stacks and code frames are stored, and re-redacted", async () => {
  const { events, stop } = await attach();
  await until(() => events().length === LOG_EVENTS, "the recorded events");
  await stop();
  const exception = events().find((e) => e.attrs.exception === true)!;
  assert.equal(exception.attrs.symbolicated, true);
  const [top] = exception.attrs.stack as { file: string; lineNumber: number }[];
  assert.deepEqual([top!.file, top!.lineNumber], ["/Users/dev/fixture-app/src/screens/Profile.tsx", 42]);
  const { content } = exception.attrs.codeFrame as { content: string };
  assert.match(content, /const apiKey = "\[REDACTED:secret\]";/);
  assert.equal(events().filter((e) => e.attrs.symbolicated === true).length, 2, "exception + unhandled-rejection text stack");
});

test("a redbox and an unhandled rejection each raise a minimal incident next to the trigger", async () => {
  const { events, incidents, stop } = await attach();
  await until(() => incidents().length === 2, "the incidents");
  await stop();
  const byKind = new Map(incidents().map((i) => [(i.attrs.incident as { kind: string }).kind, i]));
  const redbox = byKind.get("redbox")!;
  const rejection = byKind.get("unhandled-rejection")!;
  assert.equal(redbox.msg, "TypeError: Cannot read property 'name' of undefined");
  assert.equal(rejection.msg, "Possible Unhandled Promise Rejection (id: 0):");
  assert.equal(rejection.level, "error");
  const trigger = events().find((e) => e.attrs.exception === true)!;
  assert.deepEqual(redbox.attrs, { incident: { id: (redbox.attrs.incident as { id: number }).id, kind: "redbox", detector: "redbox", eventId: trigger.id } });
});

test("done when: a forced crash in the fixture app is a single incident whose detail fits the budget", async () => {
  const { host, all, incidents, stop } = await attach(OPTIONS, "forced-crash.jsonl");
  await until(() => incidents().length === 1 && all().length >= 160, "the crash");
  await stop();
  const listed = listIncidents(host.incidents.list(), {});
  assert.equal(listed.incidents.length, 1);
  const [record] = host.incidents.list();
  assert.equal(record!.kind, "redbox");
  assert.equal(record!.title, "TypeError: Cannot read property 'name' of undefined");
  for (const budget of [MIN_BUDGET_CHARS, 2_000, DEFAULT_BUDGET_CHARS]) {
    const detail = incidentDetail(record!, all(), budget, () => false);
    assert.ok(JSON.stringify(detail).length <= budget, `detail over ${budget}`);
    assert.equal(detail.title, record!.title);
  }
  const detail = incidentDetail(record!, all(), DEFAULT_BUDGET_CHARS, () => false);
  assert.equal(detail.stack?.frames[0], "onPress (/Users/dev/fixture-app/src/screens/Profile.tsx:42:19)");
  assert.equal(detail.code?.line, 42);
  assert.equal(detail.firstError?.msg, "profile request failed: 500 Internal Server Error");
  const contextTemplates = detail.context.patterns.map((p) => p.template);
  assert.ok(
    contextTemplates.includes("GET /api/feed?page={num} {num} in {num}ms"),
    `expected feed pattern in context, got ${contextTemplates.join(" | ")}`,
  );
  for (let i = 1; i < detail.context.patterns.length; i++) {
    assert.ok(detail.context.patterns[i]!.lastTs >= detail.context.patterns[i - 1]!.lastTs);
  }
});

test("Metro being down is logged once and retried until it is up", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  metro.state.up = false;
  const logs: string[] = [];
  const { host, buffer } = pipeline((message) => logs.push(message));
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(logs, ["[react-native] Metro on port 8081 is not reachable: fetch failed"]);
  metro.state.up = true;
  await until(() => buffer.snapshot().length > 0, "events once Metro is up");
  await host.stopAll();
  await host.settled();
});

test("Metro up with no pages is skipped quietly, and an app is attached once it appears", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  metro.state.pages = false;
  const logs: string[] = [];
  const { host, buffer } = pipeline((message) => logs.push(message));
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  await until(() => metro.state.listRequests >= 3, "several polls of an empty target list");
  assert.deepEqual(metro.connections, []);
  assert.deepEqual(logs, []);
  assert.equal(buffer.snapshot().length, 0);
  metro.state.pages = true;
  await until(() => buffer.snapshot().length > 0, "events once the app is listed");
  assert.equal(metro.connections.length, 1);
  await host.stopAll();
  await host.settled();
});

test("plugin options are validated; port and clock interval default", () => {
  assert.deepEqual(parseOptions({}), { port: 8081, clockResyncMs: 60_000 });
  assert.deepEqual(parseOptions({ port: 19000, clockResyncMs: 5_000 }), { port: 19000, clockResyncMs: 5_000 });
  assert.throws(() => parseOptions({ port: "8081" }), /options.port must be a positive integer/);
  assert.throws(() => createPlugin({ clockResyncMs: 0 }), /options.clockResyncMs/);
});

test("skips symbolicate while Metro is down after logging once", async () => {
  let fetches = 0;
  const enricher = symbolicateEnricher({ port: 8081, clockResyncMs: 60_000 }, {
    fetch: (async () => {
      fetches++;
      throw new Error("fetch failed");
    }) as typeof fetch,
  });
  const event = {
    schemaVersion: 1 as const,
    id: 1,
    ts: 0,
    deviceTs: null,
    hostTs: 0,
    estimated: true,
    source: "react-native" as const,
    deviceId: "d",
    app: "a",
    sessionId: "s",
    pid: null,
    level: "error" as const,
    msg: "boom",
    attrs: { stack: [{ file: "index.bundle", lineNumber: 1, columnNumber: 1, methodName: "x" }] },
  };
  await assert.rejects(async () => { await enricher.enrich(event as never); }, /fetch failed/);
  assert.equal(fetches, 1);
  assert.equal(await enricher.enrich(event as never), undefined);
  assert.equal(await enricher.enrich(event as never), undefined);
  assert.equal(fetches, 1, "cooldown must not re-fetch per event");
});

test("when the JS clock read fails, replayed history uses receipt time and is estimated", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  metro.state.failClock = true;
  const logs: string[] = [];
  const { host, buffer } = pipeline((message) => logs.push(message));
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  const events = () => buffer.snapshot().filter((e) => e.attrs.incident === undefined);
  await until(() => events().length === LOG_EVENTS, "replayed history without a clock");
  await host.stopAll();
  await host.settled();
  assert.equal(events().length, LOG_EVENTS);
  assert.ok(events().every((e) => e.estimated === true), "no offset → estimated");
  const now = Date.now();
  for (const e of events()) {
    assert.ok(Math.abs(e.ts - now) < 10_000, `receipt-time ts, got ${e.ts} vs ${now}`);
  }
  assert.ok(logs.some((l) => /clock reading.*failed/.test(l)));
  assert.deepEqual(metro.connections[0]!.methods, ["Runtime.evaluate", "Runtime.enable", "Log.enable"]);
});

test("a failed clock read clears a stale offset before history replay", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  const logs: string[] = [];
  const { host, buffer, clocks } = pipeline((message) => logs.push(message));
  // Stale offset that would pull ts ~3 days early if left in place during a failed reattach.
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  clocks.setSample(DEVICE, { deviceTs: Date.now() + DRIFT_MS - THREE_DAYS_MS, hostTs: Date.now() });
  metro.state.failClock = true;
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  const events = () => buffer.snapshot().filter((e) => e.attrs.incident === undefined);
  await until(() => events().length === LOG_EVENTS, "replay after clearing stale offset");
  await host.stopAll();
  await host.settled();
  const now = Date.now();
  assert.ok(events().every((e) => e.estimated === true));
  for (const e of events()) {
    assert.ok(Math.abs(e.ts - now) < 10_000, "cleared stale offset; not 3 days early");
    assert.ok(e.ts > now - THREE_DAYS_MS / 2, "must not keep the stale 3-day offset");
  }
});

test("a failed poll keeps health live while an app is connected", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  const { host, buffer } = pipeline(() => {});
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  await until(() => buffer.snapshot().length > 0, "events from the connected app");
  const health = () => host.sourceActivity()[0]!.health;
  assert.equal(health()?.status, "live");
  metro.state.up = false;
  const polls = metro.state.listRequests;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(health()?.status, "live");
  metro.state.up = true;
  await until(() => metro.state.listRequests > polls, "a poll once Metro answers again");
  assert.equal(health()?.status, "live");
  await host.stopAll();
  await host.settled();
});

test("a page another debugger took is left alone until it leaves /json/list or Metro refuses connections", async () => {
  const metro = await fakeMetro("transcript.jsonl");
  const { host, buffer } = pipeline(() => {});
  host.add(createReactNativePlugin(OPTIONS, metro.deps));
  await host.startAll();
  await until(() => buffer.snapshot().length > 0, "events from the connected app");
  const health = () => host.sourceActivity()[0]!.health;
  const pollsAfter = async (count: number) => {
    const from = metro.state.listRequests;
    await until(() => metro.state.listRequests >= from + count, `${count} more polls`);
  };

  metro.connections.at(-1)!.drop("[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance");
  await pollsAfter(5);
  assert.equal(metro.connections.length, 1, "no reconnect while the other debugger holds the page");
  assert.equal(health()?.status, "waiting");
  assert.match(health()!.detail, new RegExp(`another debugger .* has ${APP.replaceAll(".", "\\.")}`));

  for (const failure of ["timeout", "garbled"] as const) {
    metro.state.up = false;
    metro.state.failure = failure;
    await pollsAfter(3);
    metro.state.up = true;
    await pollsAfter(3);
    assert.equal(metro.connections.length, 1, `a ${failure} answer comes from a Metro still holding the page`);
  }

  metro.state.pages = false;
  await pollsAfter(2);
  metro.state.pages = true;
  await until(() => metro.connections.length === 2, "a reconnect once the page came back");

  metro.connections.at(-1)!.drop("[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance");
  await pollsAfter(2);
  metro.state.up = false;
  metro.state.failure = "refused";
  await pollsAfter(2);
  metro.state.up = true;
  await until(() => metro.connections.length === 3, "a reconnect once Metro refused connections");

  metro.connections.at(-1)!.drop();
  await until(() => metro.connections.length === 4, "a plain drop reconnects at once");
  await host.stopAll();
  await host.settled();
});
