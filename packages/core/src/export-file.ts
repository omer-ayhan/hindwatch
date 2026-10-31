import { createWriteStream } from "node:fs";
import { openOwnerOnly as openOwnerOnlyFd } from "./owner-file.js";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openVerified } from "./client.js";
import { RpcError, parseResponse } from "./protocol.js";
import type { Gap } from "./gaps.js";
import type { DebugEvent } from "./schema.js";
import { isErrnoException } from "./util.js";

export const EXPORT_FORMATS = ["jsonl", "text"] as const;

/** The code on every refused export target. */
export const INVALID_PATH = "INVALID_PATH";
const refuse = (out: string, why: string) => new RpcError(`refusing to export to ${out}: ${why}`, INVALID_PATH);
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportSummary {
  readonly out: string;
  readonly format: ExportFormat;
  readonly events: number;
  readonly gaps: number;
  readonly end: "done" | "interrupted" | "stopping";
}

export function describeGap(gap: Gap): string {
  const when = gap.reason === "evicted" ? "before the export reached them" : "while the export fell behind";
  return `gap: events ${gap.fromId}-${gap.toId} were evicted from the buffer ${when} (newest missing at ${new Date(gap.toTs).toISOString()})`;
}

export function textLine(event: DebugEvent): string {
  const msg = event.msg.replaceAll("\n", "\n\t");
  return `${new Date(event.ts).toISOString()} ${event.source} ${event.level.toUpperCase()} ${event.app}[${event.pid ?? "-"}] ${msg}`;
}

/** Opens the export target owner-only, refusing a symlink there rather than writing through it. */
function openOwnerOnly(out: string): number {
  try {
    return openOwnerOnlyFd(out);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("it is a symlink")) throw refuse(out, "it is a symlink");
    throw error;
  }
}

/**
 * Resolves an export target, given relative to the project root, to a real path inside it. The
 * folder is resolved through any symlink so a linked directory can't carry the file out of the root.
 */
export async function exportTarget(root: string, out: string): Promise<string> {
  if (isAbsolute(out) || out.split(/[\\/]/).includes("..")) {
    throw refuse(out, 'give a path inside the project root, without ".."');
  }
  const realRoot = await realpath(root);
  const folder = await realpath(dirname(resolve(realRoot, out))).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === "ENOENT") throw refuse(out, "its folder doesn't exist");
    throw error;
  });
  const inside = relative(realRoot, folder);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw refuse(out, "its folder resolves outside the project root");
  }
  return join(folder, basename(out));
}

export interface ExportRequest {
  readonly root: string;
  readonly params: Record<string, unknown>;
  /** Relative to the project root when confined (see exportTarget), else to the current folder. */
  readonly out: string;
  /** Keeps the file inside the project root, for callers that aren't the user at a shell. */
  readonly confined: boolean;
  readonly format: ExportFormat;
  /** Ends the export cleanly, as Ctrl-C does. */
  readonly signal: AbortSignal;
  readonly warn: (message: string) => void;
}

/**
 * Writes the daemon's export stream to a file the CLI opens itself, owner-only (gate 2): the
 * daemon never writes to a caller's path. A full disk or slow file pauses the socket, which
 * the daemon sees as backpressure and answers with a gap line instead of waiting.
 */
export async function exportToFile({ root, params, out, confined, format, signal, warn }: ExportRequest): Promise<ExportSummary> {
  const shown = confined ? resolve(root, out) : resolve(out);
  const target = confined ? await exportTarget(root, out) : shown;
  const socket = await openVerified(root);
  let fd: number;
  try {
    fd = openOwnerOnly(target);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  const file = createWriteStream(target, { fd });
  let pending = "";
  let replied = false;
  let end: ExportSummary["end"] | undefined;
  let events = 0;
  let gaps = 0;

  // Lines already read from the socket still arrive after it pauses, and all wait on one drain.
  let draining = false;
  const write = (text: string) => {
    if (file.write(text) || draining) return;
    draining = true;
    socket.pause();
    file.once("drain", () => {
      draining = false;
      socket.resume();
    });
  };
  const onLine = (line: string) => {
    if (!replied) {
      const reply = parseResponse(JSON.parse(line));
      if (!reply.ok) throw new RpcError(reply.error, reply.code);
      replied = true;
    } else if (line.startsWith('{"end":')) {
      end ??= "done";
    } else if (line.startsWith('{"notice":')) {
      end ??= "stopping";
    } else if (line.startsWith('{"gap":')) {
      gaps++;
      const message = describeGap((JSON.parse(line) as { gap: Gap }).gap);
      warn(message);
      write(format === "jsonl" ? `${line}\n` : `# ${message}\n`);
    } else {
      events++;
      write(format === "jsonl" ? `${line}\n` : `${textLine(JSON.parse(line) as DebugEvent)}\n`);
    }
  };

  return new Promise((resolve, reject) => {
    let failure: unknown;
    const interrupt = () => {
      end ??= "interrupted";
      socket.destroy();
    };
    signal.addEventListener("abort", interrupt, { once: true });
    socket.write(`${JSON.stringify({ method: "export", params })}\n`);
    socket.on("error", (error) => {
      failure ??= error;
    });
    socket.on("data", (data: string) => {
      pending += data;
      try {
        for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          onLine(line);
        }
      } catch (error) {
        failure ??= error;
        socket.destroy();
      }
    });
    socket.on("close", () => {
      signal.removeEventListener("abort", interrupt);
      file.end(() => {
        if (end !== undefined && failure === undefined) resolve({ out: shown, format, events, gaps, end });
        else reject(failure ?? new Error("the daemon ended the export before it was complete"));
      });
    });
  });
}
