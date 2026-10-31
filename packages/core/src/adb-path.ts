import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";

export interface AdbLookup {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
  readonly isExecutable: (path: string) => Promise<boolean>;
}

export interface AdbCandidate {
  readonly path: string;
  /** Where the candidate came from, for doctor's detail. */
  readonly from: "PATH" | "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "Android Studio's default SDK";
}

export function defaultAdbLookup(env: NodeJS.ProcessEnv = process.env): AdbLookup {
  return {
    platform: process.platform,
    env,
    homedir: userInfo().homedir,
    isExecutable: (path) => access(path, constants.X_OK).then(() => true, () => false),
  };
}

/** In lookup order: PATH, $ANDROID_HOME, $ANDROID_SDK_ROOT, then Android Studio's default SDK on macOS. */
export function adbCandidates({ platform, env, homedir }: Omit<AdbLookup, "isExecutable">): AdbCandidate[] {
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir): AdbCandidate => ({ path: join(dir, "adb"), from: "PATH" }));
  const sdk = (home: string | undefined, from: AdbCandidate["from"]): AdbCandidate[] =>
    home === undefined || home === "" ? [] : [{ path: join(home, "platform-tools", "adb"), from }];
  return [
    ...onPath,
    ...sdk(env.ANDROID_HOME, "ANDROID_HOME"),
    ...sdk(env.ANDROID_SDK_ROOT, "ANDROID_SDK_ROOT"),
    ...(platform === "darwin" ? sdk(join(homedir, "Library", "Android", "sdk"), "Android Studio's default SDK") : []),
  ];
}

/** The adb both the daemon and doctor use: the first executable candidate, or undefined. */
export async function resolveAdb(lookup: AdbLookup = defaultAdbLookup()): Promise<AdbCandidate | undefined> {
  for (const candidate of adbCandidates(lookup)) {
    if (await lookup.isExecutable(candidate.path)) return candidate;
  }
  return undefined;
}
