import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isErrnoException } from "./util.js";

export interface DaemonPaths {
  readonly socket: string;
  readonly lock: string;
  readonly log: string;
  /** The daemon's stderr, for what Node prints itself; emptied at each start. */
  readonly stderr: string;
  /** Long-lived children of the daemon, for the next one to sweep. */
  readonly children: string;
}

/** What each file of a daemon adds to its root hash. */
export const DAEMON_SUFFIX = { socket: ".sock", lock: ".lock", log: ".log", stderr: ".stderr", children: ".children.json" } as const;

/** macOS caps a Unix socket path at 104 bytes, the terminating NUL included. */
const MAX_SOCKET_BYTES = 103;
const HASH_CHARS = 16;
/** Below this a shortened socket name could collide between roots. */
const MIN_SOCKET_HASH_CHARS = 8;

/**
 * Per-user folder, the same in every shell. $TMPDIR and $XDG_RUNTIME_DIR differ between a
 * terminal, an IDE and a launchd or ssh session, and a different folder would give the same root
 * a second daemon. It lives in the home folder from the user database, not $HOME, and not in /tmp,
 * which others can write to and macOS clears of files unused for three days, a live socket
 * included. HINDWATCH_RUNTIME_DIR, an absolute path, replaces it; the test and perf runs use it to
 * keep out of the real one.
 */
export function runtimeDir(): string {
  const override = process.env.HINDWATCH_RUNTIME_DIR;
  if (override !== undefined && isAbsolute(override)) return override;
  return join(userInfo().homedir, ".hindwatch", "run");
}

/** The socket for a root hash, its name shortened when the folder leaves too little room. */
export function socketPath(dir: string, hash: string): string {
  const room = MAX_SOCKET_BYTES - Buffer.byteLength(join(dir, DAEMON_SUFFIX.socket));
  if (room < MIN_SOCKET_HASH_CHARS) {
    throw new Error(`${dir} is too long a path for a Unix socket (macOS allows ${MAX_SOCKET_BYTES + 1} bytes)`);
  }
  return join(dir, `${hash.slice(0, Math.min(room, hash.length))}${DAEMON_SUFFIX.socket}`);
}

/**
 * The one way a project root is named: absolute, with symlinks resolved, so /var/x and
 * /private/var/x are the same root. The CLI, the client and the daemon all go through it.
 */
export function resolveRoot(root: string): string {
  return realpathSync.native(resolve(root));
}

/** One set of files per project root, named by a hash of the resolved root so any path fits. */
export function daemonPaths(root: string): DaemonPaths {
  const hash = createHash("sha256").update(resolveRoot(root)).digest("hex").slice(0, HASH_CHARS);
  const dir = runtimeDir();
  const base = join(dir, hash);
  return {
    socket: socketPath(dir, hash),
    lock: `${base}${DAEMON_SUFFIX.lock}`,
    log: `${base}${DAEMON_SUFFIX.log}`,
    stderr: `${base}${DAEMON_SUFFIX.stderr}`,
    children: `${base}${DAEMON_SUFFIX.children}`,
  };
}

/**
 * Creates the runtime folder as 0700, then refuses to go on unless it is a real directory (not a
 * symlink), owned by the current user, with no group or other permissions. There is no fallback:
 * a folder someone else could reach must not hold the socket.
 */
export async function ensureRuntimeDir(dir: string = runtimeDir()): Promise<string> {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  });
  await checkRuntimeDir(dir);
  return dir;
}

/** The runtime folder check alone, creating nothing: throws unless the folder is safe to hold a socket. */
export async function checkRuntimeDir(dir: string = runtimeDir()): Promise<void> {
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`refusing to start: ${dir} must be a directory, not a symlink, owned by the current user with mode 0700`);
  }
}
