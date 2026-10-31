import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BufferLimits } from "./buffer.js";
import type { PluginFactory, PluginManifest } from "./plugin.js";
import type { AndroidOptions } from "./sources/android.js";
import { resolveRoot } from "./paths.js";
import { IOS_MIN_LEVEL } from "./sources/apple.js";
import type { IosOptions } from "./sources/ios.js";
import type { IosSimOptions } from "./sources/ios-sim.js";
import { isLevel, LEVELS, type Level } from "./schema.js";
import { errorMessage, isErrnoException, isPlainObject } from "./util.js";

export const CONFIG_FILE = "hindwatch.config.json";
export const REACT_NATIVE_PLUGIN = "@hindwatch/plugin-react-native";

export const DEFAULT_LOG_TIME_SPAN_MS = 30 * 60_000;

/**
 * Capped ring for events dropped at ingest by noise rules. Lets wait_for/logs --include-muted
 * still see recent muted matches without putting them in the main buffer.
 */
export const DEFAULT_MUTED_BUFFER: BufferLimits = {
  maxEvents: 2_000,
  maxAgeMs: DEFAULT_LOG_TIME_SPAN_MS,
  maxEventsPerSource: 2_000,
};
export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_CLOCK_RESYNC_MS = 60_000;

export interface PluginRef {
  readonly module: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** Built-in sources to run, keyed by source name. */
export interface SourcesConfig {
  readonly android?: AndroidOptions | undefined;
  readonly "ios-sim"?: IosSimOptions | undefined;
  readonly ios?: IosOptions | undefined;
}

export interface Config {
  readonly sources: SourcesConfig;
  readonly plugins: readonly PluginRef[];
  readonly logTimeSpan: number;
  /** Idle time with no attached clients and no requests before the daemon stops itself. */
  readonly idleMs: number;
  /**
   * Extra stack-frame plumbing patterns (regex source) beyond the built-in list. Matched on file
   * path or method name. Use for project-specific noise (e.g. `my-lib/`).
   */
  readonly plumbing: readonly string[];
  /** The config file it was read from, when there is one. */
  readonly file?: string | undefined;
  /** Set when there is no config file and the project was recognised from its package.json. */
  readonly detected?: ZeroConfig | undefined;
}

export type ProjectKind = "expo" | "bare-rn";

export interface ZeroConfig {
  readonly kind: ProjectKind;
  /** The package.json the kind was read from. */
  readonly packageJson: string;
}

export class InvalidConfigError extends Error {
  override readonly name = "InvalidConfigError";
}

/** The project's package.json is there but doesn't parse, and there is no config file to go on instead. */
export class PackageJsonError extends InvalidConfigError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path} doesn't parse: ${message}`);
  }
}

/** The root has nothing the daemon could capture, or is a folder no project should be served from. */
export class NotStartableError extends InvalidConfigError {}

function positiveInteger(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidConfigError(`${key} must be a positive integer`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || value === "")) {
    throw new InvalidConfigError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = optionalString(record, key, path);
  if (value === undefined) throw new InvalidConfigError(`${path}.${key} is required`);
  return value;
}

function parseAndroid(value: Record<string, unknown>): AndroidOptions {
  const path = "sources.android";
  return {
    package: requiredString(value, "package", path),
    serial: optionalString(value, "serial", path),
    clockResyncMs: positiveInteger(value.clockResyncMs, `${path}.clockResyncMs`, DEFAULT_CLOCK_RESYNC_MS),
  };
}

function optionalLevel(record: Record<string, unknown>, key: string, path: string): Level | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isLevel(value)) {
    throw new InvalidConfigError(`${path}.${key} must be one of ${LEVELS.join(", ")}`);
  }
  return value;
}

function parseIosSim(value: Record<string, unknown>): IosSimOptions {
  const path = 'sources["ios-sim"]';
  return {
    bundleId: requiredString(value, "bundleId", path),
    process: optionalString(value, "process", path),
    device: optionalString(value, "device", path),
    minLevel: optionalLevel(value, "minLevel", path) ?? IOS_MIN_LEVEL,
  };
}

function parseIos(value: Record<string, unknown>): IosOptions {
  const path = "sources.ios";
  return {
    bundleId: requiredString(value, "bundleId", path),
    device: optionalString(value, "device", path),
    minLevel: optionalLevel(value, "minLevel", path) ?? IOS_MIN_LEVEL,
    clockResyncMs: positiveInteger(value.clockResyncMs, `${path}.clockResyncMs`, DEFAULT_CLOCK_RESYNC_MS),
  };
}

function parsePlumbing(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidConfigError("plumbing must be a list of regex strings");
  return value.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern === "") {
      throw new InvalidConfigError(`plumbing[${index}] must be a non-empty string`);
    }
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new InvalidConfigError(`plumbing[${index}] is not a valid regex`);
    }
    return pattern;
  });
}

const BUILTIN_SOURCES = { android: parseAndroid, "ios-sim": parseIosSim, ios: parseIos } as const;
export const BUILTIN_SOURCE_NAMES = Object.keys(BUILTIN_SOURCES) as (keyof SourcesConfig)[];

function parseSources(value: unknown): SourcesConfig {
  if (!isPlainObject(value)) throw new InvalidConfigError("sources must be an object");
  const sources: Record<string, unknown> = {};
  for (const [name, options] of Object.entries(value)) {
    if (!Object.hasOwn(BUILTIN_SOURCES, name)) {
      throw new InvalidConfigError(`sources.${name} is not a built-in source (${Object.keys(BUILTIN_SOURCES).join(", ")})`);
    }
    if (!isPlainObject(options)) throw new InvalidConfigError(`sources.${name} must be an object`);
    sources[name] = BUILTIN_SOURCES[name as keyof typeof BUILTIN_SOURCES](options);
  }
  return sources as SourcesConfig;
}

export function parseConfig(value: unknown): Config {
  if (!isPlainObject(value)) throw new InvalidConfigError(`${CONFIG_FILE} must contain an object`);
  const { sources = {}, plugins = [], logTimeSpan, idleMs, plumbing } = value;
  if (!Array.isArray(plugins)) throw new InvalidConfigError("plugins must be a list");
  return {
    sources: parseSources(sources),
    plugins: plugins.map((ref, index): PluginRef => {
      if (typeof ref === "string") return { module: ref, options: {} };
      if (!isPlainObject(ref) || typeof ref.module !== "string") {
        throw new InvalidConfigError(`plugins[${index}] must be a module name or { module, options }`);
      }
      const options = ref.options ?? {};
      if (!isPlainObject(options)) throw new InvalidConfigError(`plugins[${index}].options must be an object`);
      return { module: ref.module, options };
    }),
    logTimeSpan: positiveInteger(logTimeSpan, "logTimeSpan", DEFAULT_LOG_TIME_SPAN_MS),
    idleMs: positiveInteger(idleMs, "idleMs", DEFAULT_IDLE_MS),
    plumbing: parsePlumbing(plumbing),
  };
}

async function readPackageJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PackageJsonError(path, errorMessage(error));
  }
}

/**
 * Expo when package.json depends on expo, bare React Native when it depends on react-native
 * alone. A missing package.json is not a React Native project; one that doesn't parse is an error.
 */
export async function detectProject(root: string): Promise<ZeroConfig | undefined> {
  const packageJson = join(root, "package.json");
  const manifest = await readPackageJson(packageJson);
  if (!isPlainObject(manifest)) return undefined;
  const depends = (name: string) =>
    [manifest.dependencies, manifest.devDependencies].some((deps) => isPlainObject(deps) && Object.hasOwn(deps, name));
  if (depends("expo")) return { kind: "expo", packageJson };
  if (depends("react-native")) return { kind: "bare-rn", packageJson };
  return undefined;
}

/** With no config file, an Expo or React Native project gets the react-native plugin on its defaults. */
export async function loadConfig(root: string): Promise<Config> {
  const file = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    const detected = await detectProject(root);
    return detected === undefined ? parseConfig({}) : { ...parseConfig({ plugins: [REACT_NATIVE_PLUGIN] }), detected };
  }
  try {
    return { ...parseConfig(JSON.parse(text)), file };
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidConfigError(`${CONFIG_FILE}: ${error.message}`);
    throw error;
  }
}

function sameFolder(a: string, b: string): boolean {
  try {
    return resolveRoot(a) === resolveRoot(b);
  } catch {
    return false;
  }
}

function hasBuiltinSource(config: Config): boolean {
  return Object.values(config.sources).some((source) => source !== undefined);
}

/**
 * A built-in source or a plugin that may bring one; a detected project always has the
 * react-native plugin. Which plugins really bring a source, `capturingPlugins` finds out.
 */
function namesSources(config: Config): boolean {
  return hasBuiltinSource(config) || config.plugins.length > 0;
}

/**
 * The config a daemon for this root would run, or why none may start. One rule for a config file
 * and a detected project alike: it must name a source. Without a config file, the home folder or
 * / on its own is refused by name, so a stray cwd can't put a daemon there.
 */
export async function startConfig(root: string, home: string = homedir()): Promise<Config> {
  const config = await loadConfig(root);
  if (namesSources(config)) return config;
  if (config.file !== undefined) {
    throw new NotStartableError(`nothing to capture in ${root}: ${config.file} names no sources or plugins; add a source to ${CONFIG_FILE}`);
  }
  const packageJson = join(root, "package.json");
  const hasPackageJson = await access(packageJson).then(
    () => true,
    () => false,
  );
  const folder = sameFolder(root, "/") ? "the filesystem root" : sameFolder(root, home) ? "your home folder" : undefined;
  if (folder !== undefined && !hasPackageJson) {
    throw new NotStartableError(`${root} is ${folder}, with no ${CONFIG_FILE} or package.json; run hindwatch from your project folder or pass --root <dir>`);
  }
  const why = hasPackageJson ? `${packageJson} depends on neither expo nor react-native` : "there is no package.json";
  throw new NotStartableError(`nothing to capture in ${root}: there is no ${CONFIG_FILE} and ${why}; add a source to ${CONFIG_FILE}`);
}

/**
 * Loads the config's plugins, as the daemon will run them, and refuses when neither a built-in
 * source nor any of them captures events: detectors and enrichers alone have nothing to look at.
 */
export async function capturingPlugins(root: string, config: Config): Promise<PluginManifest[]> {
  const plugins: PluginManifest[] = [];
  for (const ref of config.plugins) plugins.push(await loadPlugin(root, ref));
  if (hasBuiltinSource(config) || plugins.some((plugin) => Array.isArray(plugin.sources) && plugin.sources.length > 0)) return plugins;
  const names = plugins.map((plugin) => plugin.name).join(", ");
  throw new NotStartableError(
    `nothing to capture in ${root}: ${config.file ?? "the detected config"} has no source, only plugins without one (${names}); add a source to ${CONFIG_FILE}`,
  );
}

/** Plugins that ship with hindwatch, at the same place relative to core in the source tree and in the build. */
const BUNDLED_PLUGINS: Readonly<Record<string, string>> = {
  [REACT_NATIVE_PLUGIN]: "../../plugin-react-native/src/index.js",
};

function pluginUrl(root: string, module: string): string {
  if (module.startsWith(".") || isAbsolute(module)) return pathToFileURL(resolve(root, module)).href;
  try {
    return pathToFileURL(createRequire(join(root, CONFIG_FILE)).resolve(module)).href;
  } catch (error) {
    const bundled = BUNDLED_PLUGINS[module];
    if (bundled === undefined || !isErrnoException(error) || error.code !== "MODULE_NOT_FOUND") throw error;
    return new URL(bundled, import.meta.url).href;
  }
}

/**
 * Relative and absolute paths resolve against the project root; bare names through its
 * node_modules, then, for a bundled plugin the project doesn't install, the bundled copy.
 */
export async function loadPlugin(root: string, ref: PluginRef): Promise<PluginManifest> {
  const mod: unknown = await import(pluginUrl(root, ref.module));
  const factory = isPlainObject(mod) ? mod.default : undefined;
  if (typeof factory !== "function") {
    throw new InvalidConfigError(`${ref.module} must default-export a plugin factory`);
  }
  return (factory as PluginFactory)(ref.options);
}
