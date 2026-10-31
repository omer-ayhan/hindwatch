import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, resolveAdb, type AdbLookup } from "@hindwatch/core";
import { bareEnv, discardProject, eventually, runCli } from "./helpers.js";
import { test } from "./timed.js";

const SDK = "/sdk/home/platform-tools/adb";
const SDK_ROOT = "/sdk/root/platform-tools/adb";
const STUDIO = "/Users/me/Library/Android/sdk/platform-tools/adb";

function lookup(executable: readonly string[], platform: NodeJS.Platform = "darwin"): AdbLookup {
  return {
    platform,
    env: { PATH: "/a:/b", ANDROID_HOME: "/sdk/home", ANDROID_SDK_ROOT: "/sdk/root" },
    homedir: "/Users/me",
    isExecutable: async (path) => executable.includes(path),
  };
}

test("adb is looked up on PATH, then ANDROID_HOME, then ANDROID_SDK_ROOT, then Android Studio's SDK on macOS only", async () => {
  const all = ["/b/adb", SDK, SDK_ROOT, STUDIO];
  assert.deepEqual(await resolveAdb(lookup(all)), { path: "/b/adb", from: "PATH" });
  assert.deepEqual(await resolveAdb(lookup(["/a/adb", "/b/adb"])), { path: "/a/adb", from: "PATH" });
  assert.deepEqual(await resolveAdb(lookup([SDK, SDK_ROOT, STUDIO])), { path: SDK, from: "ANDROID_HOME" });
  assert.deepEqual(await resolveAdb(lookup([SDK_ROOT, STUDIO])), { path: SDK_ROOT, from: "ANDROID_SDK_ROOT" });
  assert.deepEqual(await resolveAdb(lookup([STUDIO])), { path: STUDIO, from: "Android Studio's default SDK" });
  assert.equal(await resolveAdb(lookup([STUDIO], "linux")), undefined);
  assert.equal(await resolveAdb(lookup([])), undefined);
});

test("the daemon spawns the adb the resolver finds, here one only under ANDROID_HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-adb-path-"));
  t.after(() => discardProject(root));
  const tools = join(root, "sdk", "platform-tools");
  await mkdir(tools, { recursive: true });
  const calls = join(root, "adb-calls");
  // Logs and fails every call, so the source keeps polling and never attaches.
  await writeFile(join(tools, "adb"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`);
  await chmod(join(tools, "adb"), 0o755);
  await writeFile(join(root, CONFIG_FILE), JSON.stringify({ sources: { android: { package: "com.example.adbpath" } } }));

  const env = { ...bareEnv(), PATH: "/usr/bin:/bin", ANDROID_HOME: join(root, "sdk") };
  const started = await runCli(root, ["start"], { env });
  assert.equal(started.code, 0, started.stderr);
  await eventually(async () => (await readFile(calls, "utf8").catch(() => "")).includes("shell pidof com.example.adbpath"), "the ANDROID_HOME adb to be run");
});
