import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ClockTracker, parseErrorStack, stripAnsi, type Level, type RawEvent, type Source, type SourceContext } from "@hindwatch/core";
import { errorText, isRecord, metroUrl, type CdpConnection, type MetroDeps, type MetroOptions } from "./metro.js";

const REQUEST_TIMEOUT_MS = 2_000;
/** Metro's close-reason code when a debugger takes a page that allows only one. */
const NEW_DEBUGGER_OPENED = "[NEW_DEBUGGER_OPENED]";
/** The fetch failure that means nothing listens on Metro's port, so no debugger is held there either. */
const METRO_GONE = "ECONNREFUSED";
// Metro's inspector proxy only trusts a few loopback origins; on Expo only this one works.
const origin = (port: number) => `http://127.0.0.1:${port}`;

export interface MetroTarget {
  readonly id: string;
  readonly deviceId: string;
  readonly app: string;
  /** Path and query of the target's debugger socket, always reached through local Metro. */
  readonly path: string;
}

/** Debuggable apps in Metro's /json/list. Entries without a debugger socket are skipped. */
export function parseTargets(list: unknown): MetroTarget[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): MetroTarget[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.webSocketDebuggerUrl !== "string") return [];
    if (!URL.canParse(entry.webSocketDebuggerUrl)) return [];
    const { pathname, search } = new URL(entry.webSocketDebuggerUrl);
    const logical = isRecord(entry.reactNative) ? entry.reactNative.logicalDeviceId : undefined;
    const app = typeof entry.appId === "string" ? entry.appId : typeof entry.title === "string" ? entry.title : entry.id;
    return [{ id: entry.id, deviceId: typeof logical === "string" ? logical : entry.id, app, path: pathname + search }];
  });
}

/** Metro's /symbolicate frame shape. CDP lines are 0-based, Metro's are 1-based. */
interface StackFrame {
  readonly methodName: string;
  readonly file: string;
  readonly lineNumber: number;
  readonly column: number;
}

function toFrames(stackTrace: unknown): StackFrame[] {
  const frames = isRecord(stackTrace) && Array.isArray(stackTrace.callFrames) ? stackTrace.callFrames : [];
  return frames.flatMap((frame): StackFrame[] => {
    if (!isRecord(frame) || typeof frame.url !== "string" || typeof frame.lineNumber !== "number") return [];
    return [
      {
        methodName: typeof frame.functionName === "string" && frame.functionName !== "" ? frame.functionName : "<anonymous>",
        file: frame.url,
        lineNumber: frame.lineNumber + 1,
        column: typeof frame.columnNumber === "number" ? frame.columnNumber : 0,
      },
    ];
  });
}

/** Renders one console argument the way a console would, from CDP's RemoteObject. */
export function formatArg(arg: unknown): string {
  if (!isRecord(arg)) return String(arg);
  if (arg.type === "string" && typeof arg.value === "string") return arg.value;
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if ("value" in arg) return JSON.stringify(arg.value) ?? String(arg.value);
  if (arg.subtype === "error" && typeof arg.description === "string") return arg.description;
  const { preview } = arg;
  if (isRecord(preview) && Array.isArray(preview.properties)) {
    const props = preview.properties.filter(isRecord);
    const more = preview.overflow === true ? ", …" : "";
    if (arg.subtype === "array") return `[${props.map((p) => String(p.value)).join(", ")}${more}]`;
    return `{${props.map((p) => `${String(p.name)}: ${String(p.value)}`).join(", ")}${more}}`;
  }
  return typeof arg.description === "string" ? arg.description : String(arg.type);
}

/**
 * React Native hands an uncaught error to ErrorUtils.reportFatalError, which reports it with
 * console.error instead of letting the runtime throw it, so CDP sends no exceptionThrown.
 */
const FATAL_REPORTER = "reportFatalError";

const CONSOLE_LEVELS: Readonly<Record<string, Level>> = {
  log: "info",
  info: "info",
  debug: "debug",
  trace: "debug",
  warning: "warn",
  error: "error",
  assert: "error",
};

const LOG_LEVELS: Readonly<Record<string, Level>> = {
  verbose: "verbose",
  info: "info",
  warning: "warn",
  error: "error",
};

type CdpEvent = Pick<RawEvent, "level" | "msg" | "deviceTs" | "attrs">;

/** The CDP notifications that become events. Everything else is ignored. */
export function parseCdpEvent(message: unknown): CdpEvent | undefined {
  if (!isRecord(message) || !isRecord(message.params)) return undefined;
  const { params } = message;
  const deviceTs = typeof params.timestamp === "number" ? params.timestamp : undefined;
  /** Attach a stack when either the text or CDP's callFrames yield frames. */
  const withStack = (frames: ReturnType<typeof toFrames>) => (frames.length > 0 ? { stack: frames } : {});
  /**
   * console.error(err): CDP's stackTrace is the console call site (console.js). The Error
   * description in `msg` carries the origin — prefer it so /symbolicate hits app frames.
   */
  const stackFromConsole = (msg: string, trace: unknown) => {
    const fromMsg = parseErrorStack(msg);
    return withStack(fromMsg.length > 0 ? fromMsg : toFrames(trace));
  };
  const reportedFatal = (trace: unknown) => (toFrames(trace).some((frame) => frame.methodName === FATAL_REPORTER) ? { exception: true } : {});
  switch (message.method) {
    case "Runtime.consoleAPICalled": {
      const level = typeof params.type === "string" ? CONSOLE_LEVELS[params.type] : undefined;
      if (level === undefined) return undefined;
      const args = Array.isArray(params.args) ? params.args : [];
      // Metro / Hermes often colorize console text; keep the timeline plain for patterns and expect.
      const msg = stripAnsi(args.map(formatArg).join(" "));
      return { level, msg, deviceTs, attrs: { ...reportedFatal(params.stackTrace), ...stackFromConsole(msg, params.stackTrace) } };
    }
    case "Runtime.exceptionThrown": {
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
      const exception = isRecord(details.exception) ? details.exception : {};
      const msg = stripAnsi(
        typeof exception.description === "string" ? exception.description : String(details.text ?? "exception"),
      );
      // exceptionThrown's stackTrace is already the exception origin; fall back to parsing msg.
      const frames = toFrames(details.stackTrace);
      return { level: "error", msg, deviceTs, attrs: { exception: true, ...withStack(frames.length > 0 ? frames : parseErrorStack(msg)) } };
    }
    case "Log.entryAdded": {
      const entry = isRecord(params.entry) ? params.entry : {};
      const level = typeof entry.level === "string" ? LOG_LEVELS[entry.level] : undefined;
      if (level === undefined || typeof entry.text !== "string") return undefined;
      const ts = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      const msg = stripAnsi(entry.text);
      return { level, msg, deviceTs: ts, attrs: { logSource: entry.source, ...stackFromConsole(msg, entry.stackTrace) } };
    }
    default:
      return undefined;
  }
}

/**
 * The newest millisecond a target has shown, and hashes of the messages seen in it. A reconnect
 * compares against a copy, so history replayed before that millisecond is skipped and, at it, only
 * what was already seen.
 */
interface Boundary {
  ms: number;
  readonly seen: Set<string>;
}

function messageKey(event: CdpEvent): string {
  return createHash("sha1").update(`${event.deviceTs}\0${event.level}\0${event.msg}`).digest("base64");
}

interface Session {
  readonly connection: CdpConnection;
  readonly clock: ClockTracker;
}

/**
 * Follows every app Metro knows about over its inspector socket: console calls, exceptions and
 * Log entries. Each app's JS clock is measured through Runtime.evaluate on every connect and then
 * periodically. A reconnect skips the console history Runtime.enable replays.
 */
export function cdpSource(options: MetroOptions, deps: MetroDeps): Source {
  const stopped = new AbortController();
  const sessions = new Map<string, Session>();
  /** Open sockets only, by target id: the app each one follows. */
  const connected = new Map<string, string>();
  /** Per target, so it outlives a dropped connection. */
  const boundaries = new Map<string, Boundary>();
  /**
   * Targets another debugger took, by id. Metro doesn't say when that debugger leaves, so they are
   * left alone until they drop out of /json/list or Metro refuses connections.
   */
  const yielded = new Map<string, string>();
  let loop: Promise<void> | undefined;

  const connect = (ctx: SourceContext, target: MetroTarget) => {
    let nextId = 0;
    /** Settles an outstanding request with its reply, or with an error once the socket is gone. */
    const pending = new Map<number, (reply: Record<string, unknown>) => void>();
    const live = boundaries.get(target.id) ?? { ms: -Infinity, seen: new Set<string>() };
    boundaries.set(target.id, live);
    const resume: Boundary = { ms: live.ms, seen: new Set(live.seen) };
    const request = (method: string, params: object = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId;
        const settle = (reply: Record<string, unknown>) => {
          clearTimeout(timer);
          pending.delete(id);
          if (reply.error === undefined) resolve(reply.result);
          else reject(new Error(`${method} failed: ${JSON.stringify(reply.error)}`));
        };
        const timer = setTimeout(() => settle({ error: "timed out" }), REQUEST_TIMEOUT_MS);
        pending.set(id, settle);
        connection.send(JSON.stringify({ id, method, params }));
      });
    const clock = new ClockTracker({
      read: async () => {
        const reply = await request("Runtime.evaluate", { expression: "Date.now()", returnByValue: true });
        const value = isRecord(reply) && isRecord(reply.result) ? reply.result.value : undefined;
        if (typeof value !== "number") throw new Error("Date.now() did not return a number");
        return value;
      },
      onSample: (sample) => ctx.setClockSample(target.deviceId, sample),
      intervalMs: options.clockResyncMs,
      onError: (error) => ctx.log(`clock reading for ${target.app} failed: ${errorText(error)}`),
    });
    const connection = deps.connect(metroUrl(options.port, target.path, "ws"), origin(options.port), {
      onOpen: () => {
        connected.set(target.id, target.app);
        ctx.setHealth({ status: "live", detail: `connected to ${target.app}` });
        ctx.log(`connected to ${target.app} on ${target.deviceId}`);
        // Offset must be in place before Runtime.enable replays buffered console calls.
        // A failed clock read clears any stale offset so replay uses receipt time + estimated.
        void clock.resample().then((ok) => {
          if (!ok) ctx.clearClockSample(target.deviceId);
          void request("Runtime.enable").catch(() => {});
          void request("Log.enable").catch(() => {});
        });
      },
      onMessage: (data) => {
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (isRecord(message) && typeof message.id === "number") {
          pending.get(message.id)?.(message);
          return;
        }
        const event = parseCdpEvent(message);
        if (event === undefined) return;
        if (event.deviceTs !== undefined) {
          const ms = Math.floor(event.deviceTs);
          const key = messageKey(event);
          if (ms < resume.ms || (ms === resume.ms && resume.seen.has(key))) return;
          if (ms > live.ms) {
            live.ms = ms;
            live.seen.clear();
          }
          if (ms === live.ms) live.seen.add(key);
        }
        ctx.emit({ source: "react-native", deviceId: target.deviceId, app: target.app, ...event });
      },
      onClose: (reason) => {
        clock.stop();
        for (const settle of [...pending.values()]) settle({ error: "connection closed" });
        sessions.delete(target.id);
        connected.delete(target.id);
        if (stopped.signal.aborted || ctx.signal.aborted) return;
        if (reason.includes(NEW_DEBUGGER_OPENED)) {
          yielded.set(target.id, target.app);
          ctx.log(`another debugger opened ${target.app}; leaving it alone until its page leaves Metro or Metro stops`);
          if (!setLiveHealth(ctx)) setYieldedHealth(ctx);
          return;
        }
        ctx.log(`disconnected from ${target.app}`);
      },
    });
    sessions.set(target.id, { connection, clock });
  };

  /** Reports the newest open connection as live; false when no socket is open. */
  const setLiveHealth = (ctx: SourceContext): boolean => {
    const app = [...connected.values()].at(-1);
    if (app === undefined) return false;
    ctx.setHealth({ status: "live", detail: `connected to ${app}` });
    return true;
  };

  const setYieldedHealth = (ctx: SourceContext) => {
    const apps = [...new Set(yielded.values())].join(", ");
    ctx.setHealth({
      status: "waiting",
      detail: `another debugger (React Native DevTools?) has ${apps}; JS logs resume when its page leaves Metro or Metro stops, or stop the daemon after closing that debugger`,
    });
  };

  const watch = async (ctx: SourceContext, signal: AbortSignal) => {
    let lastError: string | undefined;
    while (!signal.aborted) {
      try {
        const response = await deps.fetch(metroUrl(options.port, "/json/list"), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const targets = parseTargets(await response.json());
        for (const id of yielded.keys()) if (!targets.some((target) => target.id === id)) yielded.delete(id);
        for (const target of targets) {
          if (!sessions.has(target.id) && !yielded.has(target.id) && !signal.aborted) connect(ctx, target);
        }
        if (!setLiveHealth(ctx)) {
          if (yielded.size > 0) setYieldedHealth(ctx);
          else if (sessions.size === 0) ctx.setHealth({ status: "waiting", detail: `Metro on port ${options.port} has no inspector targets yet` });
        }
        lastError = undefined;
      } catch (error) {
        const message = `Metro on port ${options.port} is not reachable: ${errorText(error)}`;
        // A slow or garbled answer comes from a Metro that is still up, still holding the other debugger.
        if (isRecord(error) && isRecord(error.cause) && error.cause.code === METRO_GONE) yielded.clear();
        if (!setLiveHealth(ctx)) {
          ctx.setHealth({ status: "waiting", detail: `Metro on port ${options.port} is not reachable` });
        }
        if (!signal.aborted && message !== lastError) ctx.log(message);
        lastError = message;
      }
      await sleep(deps.pollMs, undefined, { signal }).catch(() => {});
    }
    for (const { connection, clock } of sessions.values()) {
      clock.stop();
      connection.close();
    }
    sessions.clear();
    connected.clear();
  };

  return {
    name: "react-native",
    async start(ctx) {
      loop = watch(ctx, AbortSignal.any([ctx.signal, stopped.signal]));
    },
    async stop() {
      stopped.abort();
      await loop;
    },
  };
}
