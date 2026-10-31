import { constants, fchmodSync, openSync } from "node:fs";
import { isErrnoException } from "./util.js";

const WRITE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

/**
 * Opens path for truncate-write, owner-only, refusing a symlink rather than writing through it.
 * Callers that need a domain-specific error (export, stderr) catch and rewrite the message.
 */
export function openOwnerOnly(path: string, mode = 0o600): number {
  try {
    const fd = openSync(path, WRITE_NOFOLLOW, mode);
    fchmodSync(fd, mode);
    return fd;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ELOOP") {
      throw new Error(`refusing to open ${path}: it is a symlink`);
    }
    throw error;
  }
}
