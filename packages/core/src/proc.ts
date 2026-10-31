import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { ChildLedger } from "./children.js";

/** How built-in sources reach adb and xcrun. Injected so recorded output can replay in tests. */
export interface ProcessRunner {
  /** Resolves with stdout. Rejects on a non-zero exit or a timeout. */
  run(command: string, args: readonly string[]): Promise<string>;
  /** Like run, with stdout's bytes, for output that isn't text. */
  runBytes(command: string, args: readonly string[]): Promise<Buffer>;
  /** Calls onLine per stdout line until the process exits (resolves on exit 0 or abort). */
  stream(command: string, args: readonly string[], onLine: (line: string) => void, signal: AbortSignal): Promise<void>;
  /** Like stream, with stdout's bytes as they come, for output that isn't lines. */
  read(command: string, args: readonly string[], onData: (chunk: Uint8Array) => void, signal: AbortSignal): Promise<void>;
}

const RUN_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 500;
/** After SIGTERM, how long the group gets before SIGKILL; the supervisor's own watcher waits as long. */
const KILL_GRACE_MS = 2_000;
/** argv[0] of every supervisor, so a sweep can tell ours from a reused pid. */
export const SUPERVISOR_NAME = "hindwatch-child";

/**
 * Runs "$@" and holds the read end of a pipe only the daemon writes to (it never does). When the
 * daemon dies for any reason the pipe hits EOF and the child is killed, idle or not. When the child
 * exits on its own the supervisor exits too, with the child's status.
 */
const SUPERVISOR =
  'exec 3<&0 0</dev/null; "$@" 3<&- & c=$!; (read _ <&3; kill $c; sleep 2; kill -9 $c) 2>/dev/null & w=$!; exec 3<&-; ' +
  'wait $c; s=$?; kill $w 2>/dev/null; exit $s';

/** Spawns command under the supervisor, in its own process group so one signal reaches all of it. */
function supervised(command: string, args: readonly string[]): ChildProcess {
  return spawn("/bin/sh", ["-c", SUPERVISOR, SUPERVISOR_NAME, command, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child.pid, signal);
}

function stderrTail(child: ChildProcess): () => string {
  let tail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  return () => tail.trim();
}

function stoppingError(command: string): Error {
  return new Error(`not starting ${command}: the daemon is stopping`);
}

function exitError(command: string, code: number | null, stderr: string): Error {
  return new Error(`${command} exited with code ${code}${stderr === "" ? "" : `: ${stderr}`}`);
}

/** Wraps a consumer of a command's output, so one that throws ends the command instead. */
type Guard = <T>(consume: (value: T) => void) => (value: T) => void;

/** Runs a long-lived command, handing its stdout to read, until it exits (resolves on exit 0 or abort). */
function follow(command: string, args: readonly string[], signal: AbortSignal, ledger: ChildLedger | undefined, read: (stdout: Readable, guard: Guard) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    if (ledger?.stopping) return reject(stoppingError(command));
    const child = supervised(command, args);
    const stderr = stderrTail(child);
    const pid = child.pid;
    let escalation: NodeJS.Timeout | undefined;
    let failure: { readonly error: unknown } | undefined;
    // A process forked while SIGTERM reached the group can miss it, and its open stdout would
    // keep the stream from ever closing. The group id stays ours while any member lives.
    const abort = () => {
      killGroup(child, "SIGTERM");
      if (pid !== undefined) escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const guard: Guard = (consume) => (value) => {
      if (failure !== undefined) return;
      try {
        consume(value);
      } catch (error) {
        failure = { error };
        abort();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (pid !== undefined) void ledger?.add(pid);
    read(child.stdout!, guard);
    child.on("error", (error) => (signal.aborted ? resolve() : reject(error)));
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(escalation);
      if (pid !== undefined) void ledger?.remove(pid);
      if (failure !== undefined) reject(failure.error);
      else code === 0 || signal.aborted ? resolve() : reject(exitError(command, code, stderr()));
    });
  });
}

/**
 * Every child runs under the supervisor. Long-lived streams are also recorded in the ledger, so
 * the next daemon can sweep any that outlived this one.
 */
export function supervisedRunner(ledger?: ChildLedger): ProcessRunner {
  const runner: Omit<ProcessRunner, "run"> = {
    runBytes: (command, args) =>
      new Promise((resolve, reject) => {
        if (ledger?.stopping) return reject(stoppingError(command));
        const child = supervised(command, args);
        const stderr = stderrTail(child);
        const stdout: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        const timer = setTimeout(() => killGroup(child, "SIGKILL"), RUN_TIMEOUT_MS);
        child.on("error", (error) => (clearTimeout(timer), reject(error)));
        child.on("close", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve(Buffer.concat(stdout)) : reject(exitError(command, code, stderr()));
        });
      }),
    stream: (command, args, onLine, signal) =>
      follow(command, args, signal, ledger, (stdout, guard) => createInterface({ input: stdout }).on("line", guard(onLine))),
    read: (command, args, onData, signal) => follow(command, args, signal, ledger, (stdout, guard) => stdout.on("data", guard(onData))),
  };
  return { ...runner, run: async (command, args) => (await runner.runBytes(command, args)).toString("utf8") };
}
