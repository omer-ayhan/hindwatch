import type { ProcessRunner } from "../proc.js";
import type { Level } from "../schema.js";

/**
 * adb arguments for a logcat on serial. It prints liblog's binary entries, each framed with its
 * length, so an entry is whole however reads cut it, and its tag and message come as logged, to the
 * nanosecond; it applies no tag filters to them. exec-out passes the bytes through untouched, where
 * a shell on an older device would add carriage returns and mix in stderr.
 */
export function logcatArgs(serial: string, ...args: string[]): string[] {
  return ["-s", serial, "exec-out", "logcat", "-B", ...args];
}

/** android_LogPriority, by value. */
const LEVELS: readonly (Level | undefined)[] = [undefined, undefined, "verbose", "debug", "info", "warn", "error", "fatal"];

/** One log entry. */
export interface LogcatEntry {
  readonly deviceTs: number;
  readonly pid: number;
  readonly level: Level;
  readonly tag: string;
  readonly msg: string;
  /** The entry's time, which -T takes. */
  readonly stamp: string;
  /** Its stamp, pid and thread: one entry's alone, except where logd stamps only to the ms, as for kernel audits. */
  readonly key: string;
}

/** liblog's logger_entry: the payload's length and the header's, then pid, tid, sec and nsec. */
const FRAME = { length: 0, headerSize: 2, pid: 4, tid: 8, sec: 12, nsec: 16 } as const;
/** The header before it carried its own size, which reads as 0 there. */
const FIRST_HEADER_SIZE = 20;

function decodeEntry(header: Buffer, payload: Buffer): LogcatEntry {
  const pid = header.readInt32LE(FRAME.pid);
  const tid = header.readUInt32LE(FRAME.tid);
  const sec = header.readUInt32LE(FRAME.sec);
  const nsec = header.readUInt32LE(FRAME.nsec);
  const tagEnd = payload.indexOf(0, 1);
  const msgEnd = payload.indexOf(0, tagEnd + 1);
  const stamp = `${sec}.${String(nsec).padStart(9, "0")}`;
  return {
    deviceTs: sec * 1000 + Math.floor(nsec / 1_000_000),
    pid,
    level: LEVELS[payload[0]!] ?? "info",
    tag: payload.toString("utf8", 1, tagEnd === -1 ? payload.length : tagEnd),
    msg: tagEnd === -1 ? "" : payload.toString("utf8", tagEnd + 1, msgEnd === -1 ? payload.length : msgEnd).replace(/\n+$/, ""),
    stamp,
    key: `${stamp} ${pid} ${tid}`,
  };
}

/**
 * Splits binary logcat output into entries, holding a cut-off one until the rest of it comes.
 * Throws on a header too short to be one, which output that isn't liblog's entries runs into.
 */
export class LogcatFrames {
  readonly #onEntry: (entry: LogcatEntry) => void;
  #rest = Buffer.alloc(0);

  constructor(onEntry: (entry: LogcatEntry) => void) {
    this.#onEntry = onEntry;
  }

  push(chunk: Uint8Array): void {
    let bytes = this.#rest.length === 0 ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.concat([this.#rest, chunk]);
    while (bytes.length >= FIRST_HEADER_SIZE) {
      const headerSize = bytes.readUInt16LE(FRAME.headerSize) || FIRST_HEADER_SIZE;
      if (headerSize < FIRST_HEADER_SIZE) throw new Error(`logcat output is not binary entries: a ${headerSize}-byte header`);
      const end = headerSize + bytes.readUInt16LE(FRAME.length);
      if (bytes.length < end) break;
      this.#onEntry(decodeEntry(bytes.subarray(0, headerSize), bytes.subarray(headerSize, end)));
      bytes = bytes.subarray(end);
    }
    this.#rest = Buffer.from(bytes);
  }
}

export function parseLogcatEntries(output: Uint8Array): LogcatEntry[] {
  const entries: LogcatEntry[] = [];
  new LogcatFrames((entry) => entries.push(entry)).push(output);
  return entries;
}

/** Reads a logcat as whole entries until it ends. */
export function readLogcatEntries(
  runner: ProcessRunner,
  adb: string,
  args: readonly string[],
  onEntry: (entry: LogcatEntry) => void,
  signal: AbortSignal,
): Promise<void> {
  const frames = new LogcatFrames(onEntry);
  return runner.read(adb, args, (chunk) => frames.push(chunk), signal);
}

/** logcat's -T time for a device time in ms. */
function logcatSince(deviceTs: number): string {
  return `${Math.floor(deviceTs / 1000)}.${String(deviceTs % 1000).padStart(3, "0")}`;
}

/**
 * Where a read of one logcat stopped. logd resumes -T after every entry stamped exactly at it, or,
 * at a time no entry has, at the first entry stamped after it, then everything stored after that.
 */
export class ReadMark {
  /** The last entry's time, or where a read that has had no entry starts. */
  #lastTs: number | undefined;
  #stamp: string | undefined;

  constructor(startTs?: number) {
    this.#lastTs = startTs;
  }

  /** -T for a read that picks up after this mark; none for a read from the start of the buffer. */
  since(): string[] {
    const since = this.#stamp ?? (this.#lastTs === undefined ? undefined : logcatSince(this.#lastTs));
    return since === undefined ? [] : ["-T", since];
  }

  passed(entry: LogcatEntry): void {
    [this.#lastTs, this.#stamp] = [entry.deviceTs, entry.stamp];
  }

  /** Moves to a time with no entry at it, for when the device clock no longer reaches the last one. */
  restartAt(deviceTs: number): void {
    [this.#lastTs, this.#stamp] = [deviceTs, undefined];
  }

  /** True while no entry was read and the start is past the device's now, which a clock set back puts no entry after. */
  isAhead(deviceNow: number): boolean {
    return this.#stamp === undefined && this.#lastTs !== undefined && deviceNow < this.#lastTs;
  }
}
