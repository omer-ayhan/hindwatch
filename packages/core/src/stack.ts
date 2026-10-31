/**
 * Shared stack helpers: parse Error.message stacks, decide which frames are app vs plumbing,
 * strip ANSI from Metro code frames, and shorten Metro bundle URLs for display.
 */
import { isAbsolute, relative, sep } from "node:path";


export interface ParsedFrame {
  readonly methodName: string;
  readonly file: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly collapse?: boolean;
}

/** CSI color / style sequences Metro leaves in code frames. */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * V8 / Hermes `at fn (file:line:col)` lines. Skips `(native)` and `address at …` frames — those
 * never symbolicate and are never the app origin.
 */
const AT_FRAME =
  /^\s*at\s+(?:(?<method>.+?)\s+\()?(?<file>.+):(?<line>\d+):(?<col>\d+)\)?\s*$/;

export function parseErrorStack(text: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const line of text.split("\n")) {
    const m = AT_FRAME.exec(line);
    if (m?.groups === undefined) continue;
    const file = m.groups["file"]!;
    if (file === "native" || file.startsWith("address at ")) continue;
    frames.push({
      methodName: m.groups["method"]?.trim() || "<anonymous>",
      file,
      lineNumber: Number(m.groups["line"]),
      column: Number(m.groups["col"]),
    });
  }
  return frames;
}

/** JVM `at pkg.Class.method(File.java:line)` lines; `(Native Method)` frames have no line and are skipped. */
const JVM_FRAME = /^\s*at\s+(?<method>[^\s(]+)\((?<file>[^:()]+):(?<line>\d+)\)\s*$/;

/** The frames of a Java or Kotlin stack trace, as Android logs it. */
export function parseJvmStack(text: string): Omit<ParsedFrame, "column">[] {
  return text.split("\n").flatMap((line) => {
    const groups = JVM_FRAME.exec(line)?.groups;
    return groups === undefined ? [] : [{ methodName: groups["method"]!, file: groups["file"]!, lineNumber: Number(groups["line"]) }];
  });
}

/**
 * True when a JVM method is the app's own: in a package of its application id, or in the one an
 * id with a suffix (com.example.app.debug) was made from.
 */
function isAppMethod(method: string, app: string): boolean {
  const pkg = method.split(".").filter((part, index, parts) => index < parts.length - 2 && /^[a-z]/.test(part)).join(".");
  return pkg === app || pkg.startsWith(`${app}.`) || pkg === app.slice(0, app.lastIndexOf("."));
}

/**
 * The frames of a stack trace written into a message: a JS Error's, or else a Java one, whose
 * frames outside the app's packages are collapsed like Metro's library frames.
 */
export function framesInText(text: string, app: string): (ParsedFrame | Omit<ParsedFrame, "column">)[] {
  const js = parseErrorStack(text);
  if (js.length > 0) return js;
  return parseJvmStack(text).map((frame) => ({ ...frame, collapse: !isAppMethod(frame.methodName, app) }));
}

/** Metro serves the app as `name.bundle//&platform=…`; keep that as the compiled app, not a library. */
export function isMetroBundle(file: string): boolean {
  return /\.bundle(?:\/\/|$|\?)/i.test(file);
}

/**
 * Console / LogBox / devtools / Hermes internals — never the frame an agent should open.
 * Matched on file path or method name. `console.js` is limited to RN's Libraries/Core and
 * `@react-native/js-polyfills` paths (RN 0.86+) so an app file named console.js is not hidden.
 * Project-specific names belong in `plumbing` in hindwatch.config.json, not in these defaults.
 */
const PLUMBING_RE =
  /Libraries\/Core\/console\.js$|@react-native\/js-polyfills\/console\.js|js-polyfills\/console\.js$|InternalBytecode\.js|react-devtools|ExceptionsManager|setUpDeveloperTools|setUpJsDevSupport|ConsoleInterceptor|promiseRejectionTracking|Libraries\/LogBox|Libraries\/Core\/Timers\/JSTimers/i;

const extraPlumbingCache = new Map<string, RegExp>();

function extraPlumbingRe(extra: readonly string[]): RegExp {
  const key = extra.join("\0");
  let re = extraPlumbingCache.get(key);
  if (re === undefined) {
    re = new RegExp(extra.map((p) => `(?:${p})`).join("|"), "i");
    extraPlumbingCache.set(key, re);
  }
  return re;
}

export function isPlumbingFrame(
  frame: { file?: unknown; methodName?: unknown; functionName?: unknown },
  plumbing: readonly string[] = [],
): boolean {
  const file = typeof frame.file === "string" ? frame.file : "";
  const method =
    typeof frame.methodName === "string" ? frame.methodName : typeof frame.functionName === "string" ? frame.functionName : "";
  if (PLUMBING_RE.test(file) || PLUMBING_RE.test(method)) return true;
  if (plumbing.length === 0) return false;
  const extra = extraPlumbingRe(plumbing);
  return extra.test(file) || extra.test(method);
}

/** node_modules library source (after symbolicate), not the Metro .bundle URL that happens to live under node_modules. */
export function isLibraryFrame(frame: { file?: unknown }): boolean {
  const file = typeof frame.file === "string" ? frame.file : "";
  if (file === "" || isMetroBundle(file)) return false;
  return /[/\\]node_modules[/\\]/.test(file);
}

/**
 * App frames: not Metro-collapsed, not console plumbing, not node_modules library source.
 * Bundle URLs count as app until symbolicate rewrites them.
 */
export function isAppFrame(
  frame: {
    file?: unknown;
    methodName?: unknown;
    functionName?: unknown;
    collapse?: unknown;
  },
  plumbing: readonly string[] = [],
): boolean {
  if (frame.collapse === true) return false;
  if (isPlumbingFrame(frame, plumbing)) return false;
  if (isLibraryFrame(frame)) return false;
  return true;
}

/**
 * Drop Metro's `//&platform=…` query junk so a frame fits a summary line.
 * When `root` is set, absolute paths under that project root are shown relative to it.
 */
export function displayFile(file: string, root?: string): string {
  let shown = file;
  const cut = file.indexOf(".bundle//");
  if (cut !== -1) {
    const base = file.slice(0, cut + ".bundle".length);
    const slash = base.lastIndexOf("/");
    shown = slash === -1 ? base : base.slice(slash + 1);
  }
  if (root === undefined || root === "" || !isAbsolute(shown)) return shown;
  const rel = relative(root, shown);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return shown;
  return rel.split(sep).join("/");
}
