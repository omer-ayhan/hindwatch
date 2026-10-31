import { isPlainObject } from "./util.js";

/** Newline-delimited JSON over the daemon's Unix socket. */
export interface RpcRequest {
  readonly method: string;
  readonly params: unknown;
}

export type RpcResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

/** Pushed to attached clients, never in reply to a request. */
export type RpcNotice =
  | { readonly notice: "stopping" }
  /** An incident was raised or raised again; its count and last trigger moved. */
  | { readonly notice: "incident"; readonly id: number };

export function parseNotice(value: unknown): RpcNotice | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.notice === "stopping") return { notice: "stopping" };
  if (value.notice === "incident" && typeof value.id === "number") return { notice: "incident", id: value.id };
  return undefined;
}

/** The daemon's first line on every connection, before any request: which root it serves. */
export interface RpcHello {
  readonly hello: { readonly root: string };
}

export function parseHello(value: unknown): string {
  if (!isPlainObject(value) || !isPlainObject(value.hello) || typeof value.hello.root !== "string") {
    throw new RpcError("malformed daemon greeting");
  }
  return value.hello.root;
}

export const CLIENTS_ATTACHED = "CLIENTS_ATTACHED";

export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function parseRequest(value: unknown): RpcRequest {
  if (!isPlainObject(value) || typeof value.method !== "string") {
    throw new RpcError("request must be { method, params }");
  }
  return { method: value.method, params: value.params ?? {} };
}

export function parseResponse(value: unknown): RpcResponse {
  if (isPlainObject(value) && value.ok === true) return { ok: true, result: value.result };
  if (isPlainObject(value) && value.ok === false && typeof value.error === "string") {
    return typeof value.code === "string"
      ? { ok: false, error: value.error, code: value.code }
      : { ok: false, error: value.error };
  }
  throw new RpcError("malformed daemon response");
}

export interface DaemonStatus {
  readonly pid: number;
  readonly root: string;
  readonly startedAt: number;
  readonly events: number;
  readonly attachedClients: number;
  /** Package version (hindwatch@…). Present on current daemons. */
  readonly version?: string;
  /** Running source names, e.g. ios-sim, metro. */
  readonly sources?: readonly string[];
  /** Per source that finished start: emit counts since attach, plus optional health. */
  readonly sourceActivity?: readonly {
    readonly name: string;
    readonly events: number;
    readonly attachedAt: number;
    readonly lastEventAt?: number;
    readonly health?: { readonly status: "waiting" | "live" | "idle"; readonly detail: string };
  }[];
  /** Problems agents should notice: waiting (no device/sim/Metro), quiet, or possibly deaf. */
  readonly warnings?: readonly string[];
  /** Events held, and how long the timeline is kept. */
  readonly buffer?: {
    readonly size: number;
    readonly logTimeSpan: number;
  };
  /** Events dropped at ingest by noise rules (never entered the buffer). */
  readonly mutedDropped?: number;
  /** Events currently held in the capped muted side-buffer (for --include-muted). */
  readonly mutedBuffered?: number;
  /** Oldest event still held, absent when the buffer is empty. */
  readonly oldestEvent?: { readonly id: number; readonly ts: number };
}

export function parseStatus(value: unknown): DaemonStatus {
  if (
    !isPlainObject(value) ||
    typeof value.pid !== "number" ||
    typeof value.root !== "string" ||
    typeof value.startedAt !== "number" ||
    typeof value.events !== "number" ||
    typeof value.attachedClients !== "number"
  ) {
    throw new RpcError("malformed daemon status");
  }
  return value as unknown as DaemonStatus;
}
