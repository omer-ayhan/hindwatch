import { execFile } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isErrnoException, isPlainObject } from "./util.js";

const exec = promisify(execFile);

/** A recorded child: its pid and what `ps` said about it right after it started. */
interface Entry {
  readonly pid: number;
  readonly identity: string;
}

/** Start time and command line, so a pid the OS has since reused is never mistaken for ours. */
async function identityOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=,command=", "-p", String(pid)]);
    const identity = stdout.trim();
    return identity === "" ? null : identity;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/** Every process group id in use. Empty if ps fails. */
async function liveGroups(): Promise<Set<number>> {
  try {
    const { stdout } = await exec("ps", ["-A", "-o", "pgid="]);
    return new Set(stdout.split("\n").map((line) => Number(line.trim())));
  } catch {
    return new Set();
  }
}

/** True while any process is still in the group, which keeps the OS from reusing its id. */
async function groupExists(pgid: number): Promise<boolean> {
  return (await liveGroups()).has(pgid);
}

/**
 * Ours if the leader is the very process we recorded or, once the leader is gone, if its group
 * still has members: a group id is never handed out again while the group exists.
 */
async function stillOurs({ pid, identity }: Entry): Promise<boolean> {
  const now = await identityOf(pid);
  return now === null ? groupExists(pid) : now === identity;
}

/** After a stop, how long the children get to exit before the ledger kills them. */
const DRAIN_GRACE_MS = 2_000;
/** How long a SIGKILLed group gets to go before the hand-off file is left for the next sweep. */
const KILL_WAIT_MS = 1_000;
const DRAIN_POLL_MS = 20;

async function killIfOurs(entry: Entry, log: (message: string) => void): Promise<void> {
  if (!(await stillOurs(entry))) return;
  try {
    process.kill(-entry.pid, "SIGKILL");
    log(`killed leftover child group ${entry.pid}: ${entry.identity}`);
  } catch {
    // Exited in the meantime.
  }
}

/** The writer's pid in `<prefix><pid><suffix>`, or null for any other name. */
function writerOf(name: string, prefix: string, suffix: string): number | null {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const pid = Number(name.slice(prefix.length, -suffix.length));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parseEntries(text: string): Entry[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Entry => isPlainObject(e) && Number.isSafeInteger(e.pid) && (e.pid as number) > 1 && typeof e.identity === "string",
    );
  } catch {
    return [];
  }
}

/**
 * The daemon's long-lived children, one file per project root. Supervisors already die with the
 * daemon; this is the backup for one that didn't: the next daemon kills what is still recorded.
 *
 * A graceful stop hands the file off before giving the root up: it becomes
 * `<file>.<pid>.stopping`, which a successor never writes, and is deleted only once every child
 * has exited. A kill -9 at any point leaves the ledger or the hand-off file for the next sweep.
 */
export class ChildLedger {
  readonly #file: string;
  readonly #stopping: string;
  readonly #entries = new Map<number, Entry>();
  #writes: Promise<void> = Promise.resolve();
  readonly #adding = new Set<Promise<void>>();
  #handedOff = false;

  constructor(file: string) {
    this.#file = file;
    this.#stopping = `${file}.${process.pid}.stopping`;
  }

  /** Kills every recorded process group that is still ours, a dead daemon's hand-off included, then forgets them all. */
  async sweep(log: (message: string) => void): Promise<void> {
    await this.#removeOrphaned(".tmp", async () => {});
    await this.#removeOrphaned(".stopping", async (path) => {
      for (const entry of parseEntries(await readFile(path, "utf8").catch(() => "[]"))) await killIfOurs(entry, log);
    });
    for (const entry of parseEntries(await readFile(this.#file, "utf8").catch(() => "[]"))) await killIfOurs(entry, log);
    await this.#persist();
  }

  /** True once a stop has begun: no child may be started from then on. */
  get stopping(): boolean {
    return this.#handedOff;
  }

  /** Rejects once a stop has begun. A child added before it is in the hand-off file, so the drain waits for it. */
  add(pid: number): Promise<void> {
    if (this.#handedOff) return Promise.reject(new Error(`not recording child ${pid}: the daemon is stopping`));
    const adding = (async () => {
      const identity = await identityOf(pid);
      if (identity === null) return;
      this.#entries.set(pid, { pid, identity });
      await this.#persist();
    })().finally(() => this.#adding.delete(adding));
    this.#adding.add(adding);
    return adding;
  }

  /** After a hand-off the entry stays: the drain waits on its whole group, not just the leader. */
  async remove(pid: number): Promise<void> {
    if (!this.#handedOff && this.#entries.delete(pid)) await this.#persist();
  }

  /**
   * For a graceful stop, while the root is still ours: moves the ledger to this daemon's
   * hand-off file and writes the ledger no more, so a successor's is never touched.
   */
  async handOff(): Promise<void> {
    this.#handedOff = true;
    await Promise.allSettled(this.#adding);
    await this.#writes;
    await rename(this.#file, this.#stopping).catch((error: unknown) => {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    });
  }

  /**
   * After the children were told to stop: waits for every recorded group to empty, kills what is
   * left after a grace period, and deletes the hand-off file only once all of them are gone.
   */
  async drain(): Promise<void> {
    const entries = [...this.#entries.values()];
    const killAt = Date.now() + DRAIN_GRACE_MS;
    let giveUpAt = Infinity;
    for (;;) {
      const groups = await liveGroups();
      const left = entries.filter((entry) => groups.has(entry.pid));
      if (left.length === 0) break;
      const now = Date.now();
      if (now >= giveUpAt) return;
      if (now >= killAt && giveUpAt === Infinity) {
        for (const entry of left) await killIfOurs(entry, () => {});
        giveUpAt = now + KILL_WAIT_MS;
      }
      await delay(DRAIN_POLL_MS);
    }
    await rm(this.#stopping, { force: true });
  }

  /** Handles `<file>.<pid><suffix>` files whose writer is dead, then deletes them. */
  async #removeOrphaned(suffix: string, handle: (path: string) => Promise<void>): Promise<void> {
    const dir = dirname(this.#file);
    const prefix = `${basename(this.#file)}.`;
    for (const name of await readdir(dir).catch(() => [])) {
      const writer = writerOf(name, prefix, suffix);
      if (writer === null || alive(writer)) continue;
      const path = join(dir, name);
      await handle(path);
      await rm(path, { force: true });
    }
  }

  /** Serialized, and atomic via rename, so a crash never leaves a half-written file. No entries, no file. */
  #persist(): Promise<void> {
    const write = async () => {
      if (this.#entries.size === 0) return rm(this.#file, { force: true });
      const temp = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify([...this.#entries.values()]), { mode: 0o600 });
      await rename(temp, this.#file);
    };
    this.#writes = this.#writes.then(write, write);
    return this.#writes;
  }
}
