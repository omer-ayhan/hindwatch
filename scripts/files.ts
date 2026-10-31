import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeDir } from "@hindwatch/core";

/** Every file in the runtime folder, and every hindwatch-* entry in the temp dir. */
export async function ourFiles(): Promise<Set<string>> {
  const runtime = runtimeDir();
  const inRuntime = (await readdir(runtime).catch(() => [])).map((name) => join(runtime, name));
  const inTemp = (await readdir(tmpdir())).map((name) => join(tmpdir(), name)).filter((path) => /\/hindwatch/.test(path));
  return new Set([...inRuntime, ...inTemp]);
}

/** Files of ours that weren't there before. */
export async function filesAddedSince(before: ReadonlySet<string>): Promise<string[]> {
  return [...(await ourFiles())].filter((path) => !before.has(path)).sort();
}
