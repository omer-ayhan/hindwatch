import { closeSync, fstatSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_SUFFIX } from "./paths.js";
import { isErrnoException } from "./util.js";

/** A daemon log is at most this big, plus one rotated copy at `<log>.1`. */
export const MAX_LOG_BYTES = 1024 * 1024;
export const ROTATED_SUFFIX = ".1";

/** Moves `path` to `path.1`, replacing an older copy, once it holds `max` bytes or more. */
export function rotateIfFull(path: string, max: number = MAX_LOG_BYTES): void {
  try {
    if (statSync(path).size >= max) renameSync(path, `${path}${ROTATED_SUFFIX}`);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

/** An append-only log file that rotates to `<path>.1` before a write would take it past `max`. */
export class CappedLog {
  readonly #path: string;
  readonly #max: number;
  #fd: number;

  constructor(path: string, max: number = MAX_LOG_BYTES) {
    this.#path = path;
    this.#max = max;
    this.#fd = openSync(path, "a", 0o600);
  }

  write(text: string): void {
    const bytes = Buffer.from(text);
    const open = fstatSync(this.#fd);
    const current = statSync(this.#path, { throwIfNoEntry: false });
    if (current?.ino !== open.ino) {
      // Someone else rotated it: write to the new file, and leave their copy alone.
      this.#reopen();
    } else if (open.size > 0 && open.size + bytes.length > this.#max) {
      renameSync(this.#path, `${this.#path}${ROTATED_SUFFIX}`);
      this.#reopen();
    }
    writeSync(this.#fd, bytes);
  }

  close(): void {
    closeSync(this.#fd);
  }

  #reopen(): void {
    closeSync(this.#fd);
    this.#fd = openSync(this.#path, "a", 0o600);
  }
}

/** Logs of a root not served for this long are removed by the next daemon to start. */
export const STALE_LOG_MS = 14 * 24 * 60 * 60 * 1000;
const LOG_SUFFIXES = [DAEMON_SUFFIX.log, `${DAEMON_SUFFIX.log}${ROTATED_SUFFIX}`, DAEMON_SUFFIX.stderr];
const LIVE_SUFFIXES = [DAEMON_SUFFIX.lock, DAEMON_SUFFIX.socket];

/** The root hash a daemon file is named by, when its name ends in one of `suffixes`. */
function hashOf(name: string, suffixes: readonly string[]): string | undefined {
  const suffix = suffixes.find((candidate) => name.endsWith(candidate) && name.length > candidate.length);
  return suffix === undefined ? undefined : name.slice(0, -suffix.length);
}

/**
 * Removes the daemon logs of roots that have no lock or socket left and haven't been written in
 * `maxAgeMs`. Every root leaves a pair behind, and nothing else ever cleans the runtime folder.
 */
export async function pruneStaleLogs(dir: string, maxAgeMs: number = STALE_LOG_MS, now: number = Date.now()): Promise<string[]> {
  const names = await readdir(dir);
  const live = names.flatMap((name) => hashOf(name, LIVE_SUFFIXES) ?? []);
  const removed: string[] = [];
  for (const name of names) {
    const hash = hashOf(name, LOG_SUFFIXES);
    if (hash === undefined || live.some((prefix) => hash.startsWith(prefix))) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs < maxAgeMs) continue;
    await rm(path, { force: true });
    removed.push(name);
  }
  return removed;
}
