import type { Level } from "../schema.js";
import { isPlainObject } from "../util.js";
import { MESSAGE_TYPES } from "./apple.js";
import { parseBinaryPlist } from "./plist.js";
import { plistFrame } from "./usbmux.js";

/** The lockdown service that streams the device's unified log, as Console.app shows it. */
export const OS_TRACE_RELAY = "com.apple.os_trace_relay";

/** Starts the stream: every message type, from every process. */
export function startActivityRequest(): Buffer {
  return plistFrame({ Request: "StartActivity", MessageFilter: 0xffff, Pid: -1, StreamFlags: 0x3c });
}

/** Each frame starts with its kind, then its length: the reply to StartActivity, then log entries. */
const REPLY_FRAME = 0x01;
const ENTRY_FRAME = 0x02;
const FRAME_HEADER = 5;

/** os_trace_relay's type byte for each unified-logging message type. */
const RELAY_TYPES: Readonly<Record<number, keyof typeof MESSAGE_TYPES>> = { 0x00: "Default", 0x01: "Info", 0x02: "Debug", 0x10: "Error", 0x11: "Fault" };

/** Where an entry keeps its fields; the strings follow from PROCESS on, NUL-terminated, in this order. */
const ENTRY = { pid: 9, seconds: 55, micros: 63, type: 68, imageSize: 107, messageSize: 109, subsystemSize: 117, categorySize: 121, process: 129 } as const;

export interface TraceEntry {
  readonly pid: number;
  readonly deviceTs: number;
  readonly level: Level;
  /** The logging process's executable. */
  readonly process: string;
  /** The binary that logged it: the executable, or a library it loaded. */
  readonly image: string;
  readonly msg: string;
  readonly subsystem: string;
  readonly category: string;
}

/**
 * One log entry, or undefined when it is too short or of an unknown type to be one, or its process
 * isn't wanted; the rest of an unwanted entry isn't decoded.
 */
export function decodeTraceEntry(entry: Buffer, wants: (process: string) => boolean = () => true): TraceEntry | undefined {
  if (entry.length <= ENTRY.process) return undefined;
  const type = RELAY_TYPES[entry[ENTRY.type]!];
  const processEnd = entry.indexOf(0, ENTRY.process);
  if (type === undefined || processEnd < 0) return undefined;
  const process = entry.toString("utf8", ENTRY.process, processEnd);
  if (!wants(process)) return undefined;
  let at = processEnd + 1;
  const string = (size: number) => {
    const text = entry.toString("utf8", at, Math.min(entry.length, at + size)).replace(/\0+$/, "");
    at += size;
    return text;
  };
  const image = string(entry.readUInt16LE(ENTRY.imageSize));
  const msg = string(entry.readUInt16LE(ENTRY.messageSize));
  // An entry with no subsystem ends at its message; the size fields hold something else then.
  const [subsystemSize, categorySize] = [entry.readUInt32LE(ENTRY.subsystemSize), entry.readUInt32LE(ENTRY.categorySize)];
  const labelled = at < entry.length && at + subsystemSize + categorySize === entry.length;
  return {
    pid: entry.readUInt32LE(ENTRY.pid),
    deviceTs: Number(entry.readBigUInt64LE(ENTRY.seconds)) * 1000 + Math.floor(entry.readUInt32LE(ENTRY.micros) / 1000),
    level: MESSAGE_TYPES[type].level,
    process,
    image,
    msg,
    subsystem: labelled ? string(subsystemSize) : "",
    category: labelled ? string(categorySize) : "",
  };
}

/**
 * Splits os_trace_relay output into entries, holding a cut-off one until the rest of it comes.
 * Throws when the service refuses the stream or sends something that isn't its frames.
 */
export class TraceFrames {
  readonly #onEntry: (entry: TraceEntry) => void;
  readonly #onStarted: () => void;
  readonly #wants: (process: string) => boolean;
  #rest = Buffer.alloc(0);
  #started = false;

  constructor(onEntry: (entry: TraceEntry) => void, onStarted: () => void = () => {}, wants: (process: string) => boolean = () => true) {
    this.#onEntry = onEntry;
    this.#onStarted = onStarted;
    this.#wants = wants;
  }

  push(chunk: Buffer): void {
    let bytes = this.#rest.length === 0 ? chunk : Buffer.concat([this.#rest, chunk]);
    while (bytes.length >= FRAME_HEADER) {
      const kind = bytes[0]!;
      if (kind !== REPLY_FRAME && kind !== ENTRY_FRAME) throw new Error(`os_trace_relay sent an unknown frame 0x${kind.toString(16)}`);
      // The reply's length is big-endian, an entry's little-endian.
      const end = FRAME_HEADER + (kind === REPLY_FRAME ? bytes.readUInt32BE(1) : bytes.readUInt32LE(1));
      if (bytes.length < end) break;
      const frame = bytes.subarray(FRAME_HEADER, end);
      if (kind === REPLY_FRAME) this.#start(frame);
      else {
        const entry = decodeTraceEntry(frame, this.#wants);
        if (entry !== undefined) this.#onEntry(entry);
      }
      bytes = bytes.subarray(end);
    }
    this.#rest = Buffer.from(bytes);
  }

  #start(frame: Buffer): void {
    if (this.#started) throw new Error("os_trace_relay answered StartActivity twice");
    this.#started = true;
    const reply = parseBinaryPlist(frame);
    const status = isPlainObject(reply) ? (reply as Record<string, unknown>).Status : undefined;
    if (status !== "RequestSuccessful") throw new Error(`os_trace_relay refused to stream: ${String(status ?? "no status")}`);
    this.#onStarted();
  }
}
