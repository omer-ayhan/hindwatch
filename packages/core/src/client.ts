import { spawn, type ChildProcess } from "node:child_process";
import { closeSync } from "node:fs";
import { openOwnerOnly } from "./owner-file.js";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { capturingPlugins, startConfig } from "./config.js";
import { rotateIfFull } from "./log-file.js";
import { daemonPaths, ensureRuntimeDir, resolveRoot } from "./paths.js";
import { RpcError, parseHello, parseNotice, parseResponse, parseStatus, type DaemonStatus, type RpcNotice } from "./protocol.js";
import { isErrnoException } from "./util.js";

const START_TIMEOUT_MS = 5_000;
const POLL_MS = 50;
/**
 * V8 grows its young generation to 32 MB under a log burst, yet every event outlives it anyway
 * (the buffer keeps it), so a big nursery only adds RSS. 4 MB semi-spaces cut the 10k/s peak by
 * about 20 MB for more, cheaper scavenges.
 */
const DAEMON_V8_FLAGS = ["--max-semi-space-size=4"];

export class DaemonNotRunningError extends Error {
  override readonly name: string = "DaemonNotRunningError";
}

/** The daemon has gone away mid-call: it closed the connection without answering. */
export class DaemonExitedError extends DaemonNotRunningError {
  override readonly name = "DaemonExitedError";
}

/** Shared by every caller with no session of its own, so fresh shells see each other's marks. */
export const DEFAULT_CLIENT = "default";

/** The CLI's client id: HINDWATCH_CLIENT, else the terminal session, else the root's default client. */
export function cliClientId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.HINDWATCH_CLIENT ?? env.TERM_SESSION_ID ?? env.ITERM_SESSION_ID ?? env.WT_SESSION;
  return id !== undefined && id !== "" ? id : DEFAULT_CLIENT;
}


/**
 * No socket, a dead socket, a leftover non-socket file, or a daemon that dropped the
 * connection while shutting down all mean nobody is serving this root.
 */
const NOT_RUNNING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EPIPE", "ECONNRESET"]);

function toConnectError(root: string, error: unknown): unknown {
  return isErrnoException(error) && NOT_RUNNING.has(error.code ?? "")
    ? new DaemonNotRunningError(`no daemon running for ${root}`)
    : error;
}

/** Another root's daemon answered on this root's socket name: two roots share a hash prefix. */
export class SocketCollisionError extends Error {
  override readonly name = "SocketCollisionError";
}

/**
 * Connects to the root's socket and waits for the daemon's greeting. Nothing is sent until the
 * greeting names this root, so a daemon serving another root is never asked for its data.
 */
export function openVerified(given: string, timeoutMs = 5_000): Promise<Socket> {
  const root = resolveRoot(given);
  return new Promise((resolve, reject) => {
    const path = daemonPaths(root).socket;
    const socket = connect(path);
    let pending = "";
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`daemon did not greet within ${timeoutMs}ms`)), timeoutMs);
    const onError = (error: Error) => fail(toConnectError(root, error));
    const onClose = () => fail(new DaemonExitedError("daemon closed the connection before greeting"));
    const onData = (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData).off("error", onError).off("close", onClose);
      try {
        const served = parseHello(JSON.parse(pending.slice(0, newline)));
        if (served !== root) throw new SocketCollisionError(`socket collision: ${path} serves ${served}, not ${root}`);
      } catch (error) {
        fail(error);
        return;
      }
      clearTimeout(timer);
      resolve(socket);
    };
    socket.setEncoding("utf8");
    socket.on("data", onData).on("error", onError).on("close", onClose);
  });
}

/** One request, one response, then the connection closes. */
export async function call(root: string, method: string, params: unknown = {}, timeoutMs = 5_000): Promise<unknown> {
  const socket = await openVerified(root, timeoutMs);
  return new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon did not answer ${method} within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      socket.end();
      finish();
    };
    socket.write(`${JSON.stringify({ method, params })}\n`);
    socket.on("error", (error) => settle(() => reject(toConnectError(root, error))));
    // After an answer this is a no-op; before one it means the daemon died under the call.
    socket.on("close", () => settle(() => reject(new DaemonExitedError(`daemon exited before answering ${method}`))));
    socket.on("data", (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = parseResponse(JSON.parse(pending.slice(0, newline)));
        settle(() => (reply.ok ? resolve(reply.result) : reject(new RpcError(reply.error, reply.code))));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

export async function status(root: string): Promise<DaemonStatus> {
  return parseStatus(await call(root, "status"));
}

async function spawnDaemon(root: string): Promise<ChildProcess> {
  await ensureRuntimeDir();
  const self = fileURLToPath(import.meta.url);
  const fromSource = self.endsWith(".ts");
  const cli = join(dirname(self), fromSource ? "cli.ts" : "cli.js");
  // Running from source (dev and tests) needs the TypeScript loader in the child too.
  const loader = fromSource ? ["--import", import.meta.resolve("tsx")] : [];
  const { log, stderr } = daemonPaths(root);
  rotateIfFull(log);
  // Not the log: once the daemon rotates that, this fd would point at the old copy.
  const out = openOwnerOnly(stderr);
  try {
    const child = spawn(process.execPath, [...DAEMON_V8_FLAGS, ...loader, cli, "__daemon", "--root", root], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    return child;
  } finally {
    closeSync(out);
  }
}

export interface EnsureResult {
  /** True when this call launched the daemon, so its history starts now. */
  readonly started: boolean;
  readonly status: DaemonStatus;
}

/** Safe to call any number of times, concurrently: the daemon's lock keeps exactly one alive. */
export async function ensureDaemon(given: string): Promise<EnsureResult> {
  const root = resolveRoot(given);
  try {
    return { started: false, status: await status(root) };
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }
  // Refuse here, where the caller sees why, rather than in a daemon whose log nobody reads.
  await capturingPlugins(root, await startConfig(root));
  const deadline = Date.now() + START_TIMEOUT_MS;
  // A stop returns before the peer releases its lock. One spawn that exits on a held lock
  // must not burn the whole timeout — re-spawn once that child exits. Do not re-spawn on a
  // timer while a live starter is still coming up: that races a second daemon under load
  // (kill -9 reclaim), and the loser can grab the lock when the winner drains on stop.
  let childExited = true;
  for (;;) {
    if (childExited) {
      const child = await spawnDaemon(root);
      childExited = false;
      const markExited = () => {
        childExited = true;
      };
      child.once("exit", markExited);
      // Exit can land before the listener if the child dies during spawn setup.
      if (child.exitCode !== null || child.signalCode !== null) markExited();
    }
    await delay(POLL_MS);
    try {
      return { started: true, status: await status(root) };
    } catch (error) {
      if (!(error instanceof DaemonNotRunningError)) throw error;
      if (Date.now() > deadline) {
        throw new Error(`daemon did not start within ${START_TIMEOUT_MS}ms; see ${daemonPaths(root).log}`);
      }
    }
  }
}

export interface Attachment {
  /** Resolves when the connection ends; `stopping` tells whether the daemon announced its shutdown. */
  readonly closed: Promise<{ readonly stopping: boolean }>;
  close(): void;
}

/**
 * A long-lived connection, used by MCP sessions, that keeps the daemon from idling out. The
 * daemon's notices on it go to onNotice.
 */
export async function attach(
  root: string,
  clientId: string,
  kind: string,
  onNotice: (notice: RpcNotice) => void = () => {},
): Promise<Attachment> {
  const socket = await openVerified(root);
  return new Promise((resolve, reject) => {
    let pending = "";
    let attached = false;
    let stopping = false;
    const closed = new Promise<{ stopping: boolean }>((done) => socket.once("close", () => done({ stopping })));
    const readNotices = () => {
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let notice: RpcNotice | undefined;
        try {
          notice = parseNotice(JSON.parse(line));
        } catch {
          continue;
        }
        if (notice === undefined) continue;
        if (notice.notice === "stopping") stopping = true;
        onNotice(notice);
      }
    };
    socket.write(`${JSON.stringify({ method: "attach", params: { clientId, kind } })}\n`);
    socket.on("error", (error) => {
      if (!attached) reject(toConnectError(root, error));
    });
    socket.on("data", (chunk: string) => {
      pending += chunk;
      if (attached) {
        readNotices();
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = parseResponse(JSON.parse(pending.slice(0, newline)));
        if (!reply.ok) throw new RpcError(reply.error, reply.code);
        attached = true;
        pending = pending.slice(newline + 1);
        resolve({ closed, close: () => socket.end() });
        readNotices();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}
