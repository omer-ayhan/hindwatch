import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

/** Daemons, supervisors, and the device tools they run. */
const OURS = /__daemon --root|hindwatch-child|log stream|adb .*logcat/;
/** What only we start, so only these are ever killed; a bare `log stream` may be someone else's. */
const DAEMON = /__daemon --root/;
const SUPERVISOR = /hindwatch-child/;

/** "pid command" for every process of ours running now. */
export async function ourProcesses(): Promise<Map<number, string>> {
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,command="]);
  const found = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null && OURS.test(match[2]!)) found.set(Number(match[1]), match[2]!);
  }
  return found;
}

/** Processes of ours that weren't running before and are still there after a grace period (gate 8: 5 s). */
export async function leftoversSince(before: ReadonlyMap<number, string>, graceMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const left = [...(await ourProcesses())].filter(([pid]) => !before.has(pid)).map(([pid, command]) => `${pid} ${command}`);
    if (left.length === 0 || Date.now() >= deadline) return left;
    await sleep(250);
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

const pidOf = (line: string) => Number.parseInt(line, 10);

/**
 * Stops what a hung run left behind. Daemons get SIGTERM so they take their children down; after
 * the grace period, daemons and supervisor groups still there get SIGKILL. Returns what was left
 * after SIGTERM.
 */
export async function killLeftovers(before: ReadonlyMap<number, string>, left: readonly string[]): Promise<string[]> {
  for (const line of left) if (DAEMON.test(line)) signal(pidOf(line), "SIGTERM");
  const remaining = await leftoversSince(before);
  for (const line of remaining) {
    if (DAEMON.test(line)) signal(pidOf(line), "SIGKILL");
    else if (SUPERVISOR.test(line)) signal(-pidOf(line), "SIGKILL");
  }
  return remaining;
}
