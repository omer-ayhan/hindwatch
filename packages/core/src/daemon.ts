import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { EventBuffer } from "./buffer.js";
import { ChildLedger } from "./children.js";
import { CappedLog, pruneStaleLogs } from "./log-file.js";
import { Clocks } from "./clock.js";
import {
  capturingPlugins,
  startConfig,
  DEFAULT_MUTED_BUFFER,
  type SourcesConfig,
} from "./config.js";
import { PluginHost } from "./host.js";
import { streamExport } from "./export.js";
import { Ingest } from "./ingest.js";
import { DaemonNotRunningError, call } from "./client.js";
import { daemonPaths, ensureRuntimeDir, resolveRoot, runtimeDir } from "./paths.js";
import { PLUGIN_API_VERSION, type Source } from "./plugin.js";
import {
  CLIENTS_ATTACHED,
  RpcError,
  parseRequest,
  type DaemonStatus,
  type RpcHello,
  type RpcNotice,
  type RpcResponse,
} from "./protocol.js";
import { Marks } from "./marks.js";
import { NoiseFile } from "./noise.js";
import { resolveAdb } from "./adb-path.js";
import { supervisedRunner, type ProcessRunner } from "./proc.js";
import { budgetOf } from "./budget.js";
import { parseQuery, resolveStale, type Query } from "./query.js";
import { Redactor } from "./redact.js";
import { SCHEMA_VERSION } from "./schema.js";
import { HINDWATCH_VERSION } from "./version.js";
import { nativeCrashDetector } from "./native-crash.js";
import { androidSource } from "./sources/android.js";
import { iosSource } from "./sources/ios.js";
import { iosSimSource } from "./sources/ios-sim.js";
import { errorMessage, isErrnoException, isPlainObject } from "./util.js";
import { DEFAULT_WAIT_MS, expectEvents, mayLandInWindow, waitFor, waitResult } from "./verify.js";
import { createViews } from "./views.js";

const SHUTDOWN_GRACE_MS = 500;
const PROBE_TIMEOUT_MS = 500;
const MAX_LINE_CHARS = 1_000_000;

async function builtinSources({ android, "ios-sim": iosSim, ios }: SourcesConfig, runner: ProcessRunner): Promise<Source[]> {
  // Not found, plain "adb" still fails each poll with a clear ENOENT in the log.
  const adb = android === undefined ? "adb" : ((await resolveAdb())?.path ?? "adb");
  return [
    ...(android ? [androidSource(android, { runner, adb })] : []),
    ...(iosSim ? [iosSimSource(iosSim, { runner })] : []),
    ...(ios ? [iosSource(ios, { runner })] : []),
  ];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

async function readLockPid(lock: string): Promise<number | null> {
  try {
    const pid = Number.parseInt(await readFile(lock, "utf8"), 10);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Moves a dead daemon's lock aside atomically. If a racing starter replaced it with a live lock
 * in the meantime, puts that lock back (link fails if the slot is already taken again).
 */
async function takeOverStaleLock(lock: string, stalePid: number | null): Promise<void> {
  const aside = `${lock}.${process.pid}.stale`;
  try {
    await rename(lock, aside);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  const moved = await readLockPid(aside);
  if (moved !== null && moved !== stalePid && isAlive(moved)) {
    await link(aside, lock).catch((error: unknown) => {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
    });
  }
  await rm(aside, { force: true });
}

/** Returns false when a live daemon already owns this project root. */
async function acquireLock(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
    }
    const owner = await readLockPid(lock);
    if (owner !== null && isAlive(owner)) return false;
    await takeOverStaleLock(lock, owner);
  }
  return false;
}

/** The lock is the first guard; a daemon answering on the socket is the second. */
async function socketAnswers(root: string): Promise<boolean> {
  try {
    await call(root, "status", {}, PROBE_TIMEOUT_MS);
    return true;
  } catch (error) {
    if (error instanceof DaemonNotRunningError) return false;
    // Something holds the socket but won't answer: don't take it over.
    return true;
  }
}

async function releaseLock(lock: string): Promise<void> {
  if ((await readLockPid(lock)) === process.pid) await rm(lock, { force: true });
}

/**
 * For stop/exit when nothing answers: reclaims a dead daemon's lock and socket and sweeps its
 * children. A lock whose daemon is alive (one is starting) is left alone, and so is its socket.
 */
export async function clearStale(root: string): Promise<string[]> {
  const paths = daemonPaths(root);
  const owner = await readLockPid(paths.lock);
  if (owner !== null && isAlive(owner)) return [];
  const cleared: string[] = [];
  if (owner !== null) {
    await takeOverStaleLock(paths.lock, owner);
    cleared.push("lock");
  }
  if ((await readLockPid(paths.lock)) === null && (await rm(paths.socket).then(() => true, () => false))) cleared.push("socket");
  const swept: string[] = [];
  await new ChildLedger(paths.children).sweep((message) => swept.push(message));
  if (swept.length > 0) cleared.push("children");
  return cleared;
}

interface AttachedClient {
  readonly clientId: string;
  readonly kind: string;
}

function requireClientId(params: unknown): string {
  if (!isPlainObject(params) || typeof params.clientId !== "string" || params.clientId === "") {
    throw new RpcError("clientId is required");
  }
  return params.clientId;
}

/** Runs until stopped. Returns immediately if another daemon already serves this root. */
export async function runDaemon(given: string): Promise<void> {
  const root = resolveRoot(given);
  // Everything the daemon creates (socket, lock) is owner-only from the start.
  process.umask(0o077);
  await ensureRuntimeDir();
  const paths = daemonPaths(root);
  const logFile = new CappedLog(paths.log);
  const log = (message: string) => logFile.write(`${new Date().toISOString()} ${message}\n`);
  // A crash goes to the capped log, written before exit; the ledger stays for the next start to sweep.
  const fatal = (kind: string) => (error: unknown) => {
    log(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));
  if (!(await acquireLock(paths.lock))) {
    log(`lock held by pid ${(await readLockPid(paths.lock)) ?? "unknown"}; exiting`);
    return;
  }

  try {
    const config = await startConfig(root);
    const clocks = new Clocks();
    const buffer = new EventBuffer({ maxAgeMs: config.logTimeSpan });
    const mutedBuffer = new EventBuffer({ ...DEFAULT_MUTED_BUFFER, maxAgeMs: config.logTimeSpan });
    const ingest = new Ingest({ redactor: new Redactor(), clocks, buffer });
    const noise = new NoiseFile(root, { log });
    await noise.rules().catch(() => []); // warm peekFilter + migrate legacy noise; broken mute surfaces on query
    const host = new PluginHost({
      root,
      ingest,
      clocks,
      log,
      isMuted: () => noise.peekFilter(),
      mutedBuffer,
    });
    // We own the root now, so anything a previous daemon left running is an orphan.
    const ledger = new ChildLedger(paths.children);
    await ledger.sweep(log);
    const pruned = await pruneStaleLogs(runtimeDir()).catch(() => []);
    if (pruned.length > 0) log(`removed ${pruned.length} stale log file(s) of other roots`);
    const builtins = await builtinSources(config.sources, supervisedRunner(ledger));
    if (builtins.length > 0) host.add({ name: "builtin", apiVersion: PLUGIN_API_VERSION, sources: builtins, detectors: [nativeCrashDetector()] });
    for (const plugin of await capturingPlugins(root, config)) host.add(plugin);

    const startedAt = Date.now();
    /** sinceLast: id floor after a full catch-up; optional timeline `after` while a page is mid-drain. */
    const cursors = new Map<string, { sinceId: number; after?: { ts: number; id: number } }>();
    const attached = new Map<Socket, AttachedClient>();
    /** Connections waiting on events: they keep the daemon from idling out but don't block stop. */
    const busy = new Set<Socket>();
    let lastActivity = Date.now();
    let stopping = false;

    const status = (): DaemonStatus & Record<string, unknown> => {
      const sourceActivity = host.sourceActivity();
      const warnings = [
        ...host.silentSourceWarnings(),
        ...(noise.warning() !== undefined ? [noise.warning()!] : []),
      ];
      return {
        pid: process.pid,
        root,
        startedAt,
        events: buffer.size,
        attachedClients: attached.size,
        version: HINDWATCH_VERSION,
        sources: host.sourceNames,
        sourceActivity,
        ...(warnings.length > 0 ? { warnings } : {}),
        buffer: {
          size: buffer.size,
          logTimeSpan: buffer.maxAgeMs,
        },
        oldestEvent: buffer.oldest,
        /** Calls still being answered: waits and bounded exports. */
        pendingCalls: busy.size,
        schemaVersion: SCHEMA_VERSION,
        pluginApiVersion: PLUGIN_API_VERSION,
        plugins: host.pluginNames,
        droppedEvents: buffer.dropped,
        mutedDropped: host.mutedDropped,
        mutedBuffered: mutedBuffer.size,
        invalidEvents: host.invalidEvents,
        unenrichedEvents: host.unenrichedEvents,
      };
    };

    const display = { root, plumbing: config.plumbing };
    const views = createViews({ buffer, mutedBuffer, incidents: host.incidents, noise, display, startedAt });


    /** Attached sessions hear about incidents; ids are batched so a crash loop sends one line per turn. */
    const sessions = new Set<Socket>();
    const raised = new Set<number>();
    host.incidents.onRaised(({ record }) => {
      if (sessions.size === 0) return;
      if (raised.size === 0) {
        setImmediate(() => {
          const lines = [...raised].map((id) => `${JSON.stringify({ notice: "incident", id } satisfies RpcNotice)}\n`).join("");
          raised.clear();
          for (const socket of sessions) if (socket.writable) socket.write(lines);
        });
      }
      raised.add(record.id);
    });
    const marks = new Marks();

    /** Sources the query names that no source runs under and no event has carried, with a hint listing those that do. */
    const unseenSources = (parsed: Query) => {
      const known = new Set([...host.sourceNames, ...buffer.seenSources, ...mutedBuffer.seenSources]);
      const unseen = parsed.sources?.filter((name) => !known.has(name)) ?? [];
      return unseen.length === 0 ? undefined : `unknown source(s): ${unseen.join(", ")}; known: ${[...known].join(", ") || "none"}`;
    };

    /**
     * The params' query, with mark names resolved and stale folded into from/to. A source no one
     * has seen is refused, except for a wait, whose event may be the first under that name.
     */
    const readQuery = (params: unknown, { allowUnseen = false } = {}) => {
      const parsed = parseQuery(isPlainObject(params) ? params.query ?? {} : {});
      const unseen = unseenSources(parsed);
      if (unseen !== undefined && !allowUnseen) throw new RpcError(unseen);
      return resolveStale(marks.resolve(requireClientId(params), parsed), startedAt);
    };

    const query = async (params: unknown) => {
      const clientId = requireClientId(params);
      const sinceLast = isPlainObject(params) && params.sinceLast === true;
      const parsed = readQuery(params);
      // Desc pages jump the sinceLast cursor to the highest returned id, which marks older
      // unread events as seen. Reject the combo; agents should poll asc (or page with next).
      if (sinceLast && parsed.order === "desc") {
        throw new RpcError(
          'sinceLast cannot be used with order "desc"; use asc (default) so unread events are not skipped',
        );
      }
      let effective = parsed;
      if (sinceLast) {
        const saved = cursors.get(clientId);
        const sinceId = Math.max(saved?.sinceId ?? 0, parsed.sinceId ?? 0);
        effective = {
          ...parsed,
          sinceId,
          // Timeline page-end (not max id) so clock-skewed lower ids after the page are not skipped.
          ...(saved?.after !== undefined ? { after: saved.after } : {}),
        };
      }
      const result = await views.query(effective);
      if (sinceLast) {
        // Full page (or empty): jump to tip so empty filters still mark the window seen.
        // Truncated: keep sinceId floor and advance by the page's last timeline position.
        if (result.next === null) {
          cursors.set(clientId, { sinceId: result.lastId });
        } else if (result.events.length > 0) {
          const last = result.events[result.events.length - 1]!;
          const prev = cursors.get(clientId);
          cursors.set(clientId, {
            sinceId: prev?.sinceId ?? 0,
            after: { ts: last.ts, id: last.id },
          });
        }
      }
      return result;
    };

    const timeoutOf = (params: unknown): number => {
      const timeoutMs = isPlainObject(params) && params.timeoutMs !== undefined ? params.timeoutMs : DEFAULT_WAIT_MS;
      if (typeof timeoutMs !== "number" || !(timeoutMs >= 0)) throw new RpcError("timeoutMs must be a number of ms");
      return timeoutMs;
    };

    const waitForEvent = async (socket: Socket, params: unknown) => {
      const filter = readQuery(params, { allowUnseen: true });
      const timeoutMs = timeoutOf(params);
      const gone = new AbortController();
      socket.once("close", () => gone.abort());
      busy.add(socket);
      const startedAt = Date.now();
      try {
        const event = await waitFor(buffer, filter, timeoutMs, gone.signal, await noise.filter(), mutedBuffer);
        const unseen = event === undefined ? unseenSources(filter) : undefined;
        return waitResult(event, Date.now() - startedAt, budgetOf(filter.budgetChars), unseen);
      } finally {
        busy.delete(socket);
        lastActivity = Date.now();
      }
    };

    /**
     * Waits, up to timeoutMs, for events already emitted to clear the enrichers, so a check sees
     * them. A presence that already holds has nothing to wait for.
     */
    const expect = async (socket: Socket, params: unknown) => {
      const expectation = isPlainObject(params) ? params.expect : undefined;
      if (expectation !== "absent" && expectation !== "present") throw new RpcError("expect must be absent or present");
      const filter = readQuery(params);
      const timeoutMs = timeoutOf(params);
      if (expectation === "present") {
        const now = expectEvents(buffer, filter, expectation, budgetOf(filter.budgetChars), await noise.filter(), display, mutedBuffer);
        if (now.ok) return now;
      }
      const waiting = host.pendingEvents().filter((event) => mayLandInWindow(event, filter));
      const done = new AbortController();
      socket.once("close", () => done.abort());
      busy.add(socket);
      try {
        await Promise.race([host.settled(), delay(timeoutMs, undefined, { signal: done.signal }).catch(() => {})]);
      } finally {
        done.abort();
        busy.delete(socket);
        lastActivity = Date.now();
      }
      const muted = await noise.filter();
      const stillPending = new Set(host.pendingEvents());
      const pending = waiting.filter((event) => stillPending.has(event)).length;
      return expectEvents(buffer, filter, expectation, budgetOf(filter.budgetChars), muted, display, mutedBuffer, pending);
    };

    /** Answers, then streams on the same connection; the CLI writes the file. */
    const startExport = (socket: Socket, params: unknown) => {
      const clientId = requireClientId(params);
      const filter = readQuery(params);
      const follow = isPlainObject(params) && params.follow === true;
      socket.write(`${JSON.stringify({ ok: true, result: { follow } })}\n`);
      // A follow export is a live client like an attached session; a bounded one is just busy.
      if (follow) attached.set(socket, { clientId, kind: "export" });
      else busy.add(socket);
      void streamExport(socket, buffer, filter, follow).finally(() => {
        attached.delete(socket);
        busy.delete(socket);
        lastActivity = Date.now();
      });
      return STREAMED;
    };

    const shutdown = async (reason: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      log(`stopping: ${reason}`);
      const notice: RpcNotice = { notice: "stopping" };
      for (const socket of attached.keys()) socket.end(`${JSON.stringify(notice)}\n`);
      // Give the root up first, while the lock is still ours: unlink the socket name before
      // closing so a new client fails fast instead of queueing on a closing listener, move the
      // ledger to our own hand-off file, then free the lock so a successor can start while we
      // drain. After this we touch no shared files but our own log and hand-off file.
      await rm(paths.socket, { force: true });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await ledger.handOff();
      await releaseLock(paths.lock);
      // Then let replies and the stopping notice flush, but never hang the exit on a stuck client.
      const grace = delay(SHUTDOWN_GRACE_MS).then(() => {
        for (const socket of sockets) socket.destroy();
      });
      await Promise.race([closed, grace]);
      await host.stopAll();
      // The hand-off file goes only once the children are gone; a kill -9 before that leaves it to sweep.
      await ledger.drain();
      process.exit(0);
    };

    const stop = (params: unknown) => {
      const clientId = requireClientId(params);
      const force = isPlainObject(params) && params.force === true;
      // The caller never blocks its own stop; only other attached clients do.
      const others = [...attached.values()].filter((client) => client.clientId !== clientId);
      if (others.length > 0 && !force) {
        throw new RpcError(
          `${others.length} other client(s) attached (${others.map((c) => `${c.kind}:${c.clientId}`).join(", ")}); stopping drops their buffer, pass --force to stop anyway`,
          CLIENTS_ATTACHED,
        );
      }
      setImmediate(() => void shutdown(`stop requested by ${clientId}`));
      return { stopping: true, bufferDropped: buffer.size };
    };

    const handle = async (socket: Socket, method: string, params: unknown): Promise<unknown> => {
      switch (method) {
        case "status":
          return status();
        case "query":
          // Only queries count as activity, so health checks like status can't keep the daemon alive.
          lastActivity = Date.now();
          return query(params);
        case "attach": {
          const clientId = requireClientId(params);
          const kind = isPlainObject(params) && typeof params.kind === "string" ? params.kind : "unknown";
          attached.set(socket, { clientId, kind });
          sessions.add(socket);
          socket.once("close", () => {
            attached.delete(socket);
            sessions.delete(socket);
            lastActivity = Date.now();
          });
          return { attached: true };
        }
        case "patterns":
          lastActivity = Date.now();
          return views.patterns(readQuery(params));
        case "mark": {
          lastActivity = Date.now();
          const name = isPlainObject(params) && typeof params.name === "string" ? params.name : "";
          return { mark: marks.set(requireClientId(params), name, buffer.lastId) };
        }
        case "marks":
          return { marks: marks.list(requireClientId(params)) };
        case "waitFor":
          lastActivity = Date.now();
          return waitForEvent(socket, params);
        case "expect":
          lastActivity = Date.now();
          return expect(socket, params);
        case "export":
          lastActivity = Date.now();
          return startExport(socket, params);
        case "incidents":
        case "incident":
          lastActivity = Date.now();
          return views[method](params);
        case "mute":
        case "unmute":
        case "noise":
          return views[method](params);
        case "stop":
          return stop(params);
        default:
          throw new RpcError(`unknown method: ${method}`);
      }
    };

    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const hello: RpcHello = { hello: { root } };
      socket.write(`${JSON.stringify(hello)}\n`);
      serve(socket, handle);
    });
    await host.startAll();
    if (await socketAnswers(root)) {
      log("another daemon is already serving this root; exiting");
      await host.stopAll();
      await releaseLock(paths.lock);
      return;
    }
    // Lock held and nobody answers, so the socket file belongs to a dead daemon.
    await rm(paths.socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => resolve());
    });
    log(`listening on ${paths.socket} for ${root}`);

    const idleCheck = setInterval(() => {
      if (attached.size === 0 && busy.size === 0 && Date.now() - lastActivity >= config.idleMs) void shutdown("idle");
    }, Math.min(config.idleMs, 30_000));
    idleCheck.unref();

    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void shutdown(signal));
  } catch (error) {
    await releaseLock(paths.lock);
    throw error;
  }
}

type Handler = (socket: Socket, method: string, params: unknown) => Promise<unknown>;

/** A handler's result when it has answered on the socket itself. */
const STREAMED = Symbol("streamed");

function serve(socket: Socket, handle: Handler): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > MAX_LINE_CHARS) {
      socket.destroy();
      return;
    }
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      void respond(socket, line, handle);
    }
  });
}

async function respond(socket: Socket, line: string, handle: Handler): Promise<void> {
  let reply: RpcResponse;
  try {
    const request = parseRequest(JSON.parse(line));
    const result = await handle(socket, request.method, request.params);
    if (result === STREAMED) return;
    reply = { ok: true, result };
  } catch (error) {
    reply =
      error instanceof RpcError && error.code !== undefined
        ? { ok: false, error: error.message, code: error.code }
        : { ok: false, error: errorMessage(error) };
  }
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
}
