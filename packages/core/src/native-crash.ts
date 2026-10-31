import type { Detector } from "./plugin.js";
import { ANR_BUFFER, ANR_PREFIX, ANR_TAG } from "./sources/android.js";
import { isAppleSource } from "./sources/apple.js";

/** Android's tag and first line for an uncaught Java/Kotlin exception; the exception follows a "Process:" line. */
const JAVA_CRASH_TAG = "AndroidRuntime";
const JAVA_CRASH_START = "FATAL EXCEPTION";
const JAVA_CRASH_PROCESS = "Process:";
/** bionic's line in the crashing process for a native signal crash. */
const NATIVE_CRASH_TAG = "libc";
const NATIVE_CRASH_START = "Fatal signal";

const firstLine = (msg: string) => msg.split("\n", 1)[0] ?? "";

/** A Java crash's exception line, which follows FATAL EXCEPTION and the Process: line in the same entry. */
function exceptionLine(msg: string): string | undefined {
  return msg.split("\n").find((line, index) => index > 0 && !line.startsWith(JAVA_CRASH_PROCESS));
}

/**
 * Raises "crash" for Android Java and native crashes and iOS crash reports, and "anr"
 * for Android ANRs. A Java crash is titled by its exception line, or by its first line when the
 * entry was cut before it.
 */
export function nativeCrashDetector(): Detector {
  return {
    name: "native-crash",
    detect(event) {
      if (isAppleSource(event.source)) {
        return event.attrs.crashReport === undefined ? undefined : { kind: "crash", title: firstLine(event.msg) };
      }
      if (event.source !== "android") return undefined;
      const tag = event.attrs.tag;
      if (tag === JAVA_CRASH_TAG && event.msg.startsWith(JAVA_CRASH_START)) {
        return { kind: "crash", title: exceptionLine(event.msg) || firstLine(event.msg) };
      }
      if (tag === NATIVE_CRASH_TAG && event.msg.startsWith(NATIVE_CRASH_START)) return { kind: "crash", title: firstLine(event.msg) };
      if (tag === ANR_TAG && event.attrs.buffer === ANR_BUFFER && event.msg.startsWith(ANR_PREFIX)) return { kind: "anr", title: firstLine(event.msg) };
      return undefined;
    },
  };
}
