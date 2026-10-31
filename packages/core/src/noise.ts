import { readFileSync, statSync } from "node:fs";
import { rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, REACT_NATIVE_PLUGIN, detectProject } from "./config.js";
import { patternId, templateOf } from "./patterns.js";
import type { MuteFilter } from "./query.js";
import type { DebugEvent } from "./schema.js";
import { errorMessage, isErrnoException, isPlainObject } from "./util.js";

/**
 * Pre-fold path for mute rules. Mute now lives under `mute` in hindwatch.config.json.
 * Still read once for migration; writes always go to the config file.
 */
export const NOISE_FILE = "hindwatch.noise.json";

/** How often peekFilter re-stats the config (and legacy) file for hand edits. */
export const MUTE_REFRESH_MS = 1_000;

/**
 * Mutes by pattern template, or by iOS `subsystem` / `category` attrs (ios-sim, ios).
 * Valid shapes: template alone; subsystem alone; category alone; or subsystem+category (AND).
 * Template must not combine with subsystem/category.
 */
export interface NoiseRule {
  readonly template?: string | undefined;
  readonly subsystem?: string | undefined;
  readonly category?: string | undefined;
  readonly source?: string | undefined;
}

export class InvalidNoiseError extends Error {
  override readonly name = "InvalidNoiseError";
}

function ruleKind(rule: NoiseRule): "template" | "subsystem" | "category" | "scoped" {
  const hasT = rule.template !== undefined;
  const hasS = rule.subsystem !== undefined;
  const hasC = rule.category !== undefined;
  if (hasT) {
    if (hasS || hasC) throw new InvalidNoiseError("template rules cannot also set subsystem or category");
    return "template";
  }
  if (hasS && hasC) return "scoped";
  if (hasS) return "subsystem";
  if (hasC) return "category";
  throw new InvalidNoiseError("each mute rule needs template, subsystem, category, or subsystem+category");
}

/** The id `unmute` takes. For a rule with a source it equals the pattern id it was muted by. */
export function ruleId(rule: NoiseRule): string {
  const kind = ruleKind(rule);
  const source = rule.source ?? "*";
  if (kind === "template") return patternId(source, rule.template!);
  if (kind === "scoped") return patternId(source, `subsystem:${rule.subsystem!}/category:${rule.category!}`);
  if (kind === "subsystem") return patternId(source, `subsystem:${rule.subsystem!}`);
  return patternId(source, `category:${rule.category!}`);
}

export function parseNoise(value: unknown): NoiseRule[] {
  if (!isPlainObject(value) || !Array.isArray(value.mute)) {
    throw new InvalidNoiseError(`${CONFIG_FILE} mute must be { "mute": [...] }`);
  }
  return value.mute.map((rule, index): NoiseRule => {
    if (!isPlainObject(rule)) throw new InvalidNoiseError(`mute[${index}] must be an object`);
    if (rule.source !== undefined && (typeof rule.source !== "string" || rule.source === "")) {
      throw new InvalidNoiseError(`mute[${index}].source must be a non-empty string`);
    }
    const template = rule.template;
    const subsystem = rule.subsystem;
    const category = rule.category;
    const bad =
      (template !== undefined && (typeof template !== "string" || template === "")) ||
      (subsystem !== undefined && (typeof subsystem !== "string" || subsystem === "")) ||
      (category !== undefined && (typeof category !== "string" || category === ""));
    if (bad) throw new InvalidNoiseError(`mute[${index}] template/subsystem/category must be a non-empty string`);
    const hasT = typeof template === "string";
    const hasS = typeof subsystem === "string";
    const hasC = typeof category === "string";
    if (hasT && (hasS || hasC)) {
      throw new InvalidNoiseError(`mute[${index}] template cannot combine with subsystem or category`);
    }
    if (!hasT && !hasS && !hasC) {
      throw new InvalidNoiseError(`mute[${index}] needs template, subsystem, category, or subsystem+category`);
    }
    const base = hasT
      ? { template: template as string }
      : hasS && hasC
        ? { subsystem: subsystem as string, category: category as string }
        : hasS
          ? { subsystem: subsystem as string }
          : { category: category as string };
    return rule.source === undefined ? base : { ...base, source: rule.source };
  });
}

function attrString(event: Pick<DebugEvent, "attrs"> | { readonly attrs?: Readonly<Record<string, unknown>> }, key: string): string | undefined {
  const attrs = event.attrs;
  if (attrs === undefined || typeof attrs !== "object") return undefined;
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

export function muteFilter(rules: readonly NoiseRule[]): MuteFilter {
  if (rules.length === 0) return () => false;
  const templateIds = new Set<string>();
  const subsystems = new Map<string, Set<string> | "any">();
  const categories = new Map<string, Set<string> | "any">();
  /** subsystem + category AND-match → source scope */
  const scoped = new Map<string, Set<string> | "any">();
  const addScope = (bucket: Map<string, Set<string> | "any">, key: string, source: string | undefined) => {
    if (source === undefined) {
      bucket.set(key, "any");
      return;
    }
    const cur = bucket.get(key);
    if (cur === "any") return;
    const set = cur ?? new Set<string>();
    set.add(source);
    bucket.set(key, set);
  };
  for (const rule of rules) {
    const kind = ruleKind(rule);
    if (kind === "template") {
      templateIds.add(ruleId(rule));
      continue;
    }
    if (kind === "scoped") {
      addScope(scoped, `${rule.subsystem!}\u0000${rule.category!}`, rule.source);
      continue;
    }
    if (kind === "subsystem") addScope(subsystems, rule.subsystem!, rule.source);
    else addScope(categories, rule.category!, rule.source);
  }
  const matchScoped = (bucket: Map<string, Set<string> | "any">, value: string | undefined, source: string): boolean => {
    if (value === undefined) return false;
    const scope = bucket.get(value);
    if (scope === undefined) return false;
    return scope === "any" || scope.has(source);
  };
  return (event) => {
    const sub = attrString(event, "subsystem");
    const cat = attrString(event, "category");
    if (sub !== undefined && cat !== undefined && matchScoped(scoped, `${sub}\u0000${cat}`, event.source)) return true;
    if (matchScoped(subsystems, sub, event.source)) return true;
    if (matchScoped(categories, cat, event.source)) return true;
    if (templateIds.size === 0) return false;
    const template = templateOf(event.msg);
    return templateIds.has(patternId(event.source, template)) || templateIds.has(patternId("*", template));
  };
}

interface CachedMute {
  readonly configMtimeMs: number | undefined;
  readonly legacyMtimeMs: number | undefined;
  readonly rules: NoiseRule[];
}

export interface NoiseFileOpts {
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/**
 * Project mute rules, stored as `mute` in hindwatch.config.json. Writes are serialized and atomic.
 * A sync peek drives ingest-time drops so muted noise never enters the buffer; hand edits refresh
 * that peek within MUTE_REFRESH_MS (mtime check), without waiting for a query.
 *
 * A malformed or half-written file keeps the last good rules on the emit path and surfaces a status
 * warning; rules()/mute/unmute still throw so the noise tool reports the bad file clearly.
 * Legacy hindwatch.noise.json is read until the first write/migrate, then removed.
 */
export class NoiseFile {
  readonly #root: string;
  readonly #configPath: string;
  readonly #legacyPath: string;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  #cached: CachedMute | undefined;
  #peek: MuteFilter = () => false;
  #writes: Promise<unknown> = Promise.resolve();
  #lastCheckAt = 0;
  #invalidWarning: string | undefined;
  #invalidError: InvalidNoiseError | undefined;
  #loggedInvalid = false;
  #migrated = false;

  constructor(root: string, opts: NoiseFileOpts = {}) {
    this.#root = root;
    this.#configPath = join(root, CONFIG_FILE);
    this.#legacyPath = join(root, NOISE_FILE);
    this.#log = opts.log ?? (() => {});
    this.#now = opts.now ?? Date.now;
  }

  /** Status line when the mute source is invalid and last-good rules are in use. */
  warning(): string | undefined {
    return this.#invalidWarning;
  }

  /**
   * Mute filter for the emit path. Never throws: a bad file keeps the last good rules.
   * Re-reads at most once per MUTE_REFRESH_MS when the config (or legacy) mtime changes.
   */
  peekFilter(): MuteFilter {
    try {
      this.#refreshFromDisk({ throwOnInvalid: false });
    } catch {
      // Ingest must never see InvalidNoiseError / unexpected IO — keep last peek.
    }
    return this.#peek;
  }

  async rules(): Promise<NoiseRule[]> {
    await this.#migrateIfNeeded();
    this.#refreshFromDisk({ throwOnInvalid: true });
    return this.#cached?.rules ?? [];
  }

  async filter(): Promise<MuteFilter> {
    return muteFilter(await this.rules());
  }

  /** Adds the rule unless an equal one is there. Resolves with the rules as written. */
  mute(rule: NoiseRule): Promise<NoiseRule[]> {
    return this.muteMany([rule]);
  }

  /** Adds each rule unless an equal one is there. One write for the whole batch. */
  muteMany(added: readonly NoiseRule[]): Promise<NoiseRule[]> {
    return this.#update((rules) => {
      const ids = new Set(rules.map(ruleId));
      const next = [...rules];
      for (const rule of added) {
        const id = ruleId(rule);
        if (ids.has(id)) continue;
        next.push(rule);
        ids.add(id);
      }
      return next;
    });
  }

  /** Removes every rule with this id. Resolves with the rules as written. */
  unmute(id: string): Promise<NoiseRule[]> {
    return this.#update((rules) => rules.filter((rule) => ruleId(rule) !== id));
  }

  /**
   * Pulls mute out of a legacy hindwatch.noise.json into config when needed, then deletes the
   * legacy file. Safe to call more than once. Called from rules()/writes so the emit path stays sync.
   */
  async #migrateIfNeeded(): Promise<void> {
    if (this.#migrated) return;
    this.#migrated = true;
    let legacyText: string | undefined;
    try {
      legacyText = readFileSync(this.#legacyPath, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
    let legacyRules: NoiseRule[];
    try {
      legacyRules = parseNoise(JSON.parse(legacyText));
    } catch (error) {
      // Leave the broken legacy file; config path stays authoritative. Surface on next rules().
      this.#log(`legacy ${NOISE_FILE} is invalid (${errorMessage(error)}); mute lives in ${CONFIG_FILE}`);
      return;
    }

    let doc: Record<string, unknown> = {};
    let configExists = false;
    try {
      const text = readFileSync(this.#configPath, "utf8");
      configExists = true;
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new InvalidNoiseError(`${CONFIG_FILE} must contain an object`);
      doc = { ...parsed };
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) {
        if (error instanceof SyntaxError) {
          this.#log(`${CONFIG_FILE} is invalid; cannot migrate ${NOISE_FILE}: ${error.message}`);
          return;
        }
        throw error;
      }
    }

    if (Array.isArray(doc.mute)) {
      // Config already owns mute — drop the leftover noise file.
      await unlink(this.#legacyPath).catch(() => {});
      this.#log(`removed leftover ${NOISE_FILE}; mute is in ${CONFIG_FILE}`);
      return;
    }

    if (!configExists) {
      const detected = await detectProject(this.#root);
      if (detected !== undefined) doc.plugins = [REACT_NATIVE_PLUGIN];
    }
    doc.mute = legacyRules;
    const temp = `${this.#configPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`);
    await rename(temp, this.#configPath);
    await unlink(this.#legacyPath).catch(() => {});
    this.#log(`migrated mute rules from ${NOISE_FILE} into ${CONFIG_FILE}`);
    this.#cached = undefined;
    this.#lastCheckAt = 0;
  }

  /** Sync mtime check + optional re-parse. Shared by peekFilter and rules(). */
  #refreshFromDisk(opts: { throwOnInvalid: boolean }): void {
    const now = this.#now();
    if (this.#lastCheckAt !== 0 && now - this.#lastCheckAt < MUTE_REFRESH_MS) {
      if (opts.throwOnInvalid && this.#invalidError !== undefined) throw this.#invalidError;
      return;
    }
    this.#lastCheckAt = now;

    const configStat = this.#stat(this.#configPath);
    const legacyStat = this.#stat(this.#legacyPath);
    if (
      this.#cached !== undefined &&
      this.#cached.configMtimeMs === configStat &&
      this.#cached.legacyMtimeMs === legacyStat &&
      this.#invalidError === undefined
    ) {
      return;
    }

    try {
      const { rules } = this.#readRules(configStat, legacyStat);
      this.#cached = { configMtimeMs: configStat, legacyMtimeMs: legacyStat, rules };
      this.#peek = muteFilter(rules);
      this.#invalidWarning = undefined;
      this.#invalidError = undefined;
      this.#loggedInvalid = false;
    } catch (error) {
      const invalid =
        error instanceof InvalidNoiseError
          ? error
          : error instanceof SyntaxError
            ? new InvalidNoiseError(`${CONFIG_FILE}: ${error.message}`)
            : error instanceof Error && error.name === "InvalidNoiseError"
              ? (error as InvalidNoiseError)
              : undefined;
      if (invalid === undefined) throw error;
      this.#invalidError = invalid;
      this.#invalidWarning = `mute rules invalid, using last good rules (${invalid.message})`;
      if (!this.#loggedInvalid) {
        this.#loggedInvalid = true;
        this.#log(this.#invalidWarning);
      }
      // Keep last good #cached / #peek. Remember mtimes so we don't re-parse the same bad bytes
      // every throttle window — a fix bumps mtime and retries.
      if (this.#cached !== undefined) {
        this.#cached = {
          configMtimeMs: configStat,
          legacyMtimeMs: legacyStat,
          rules: this.#cached.rules,
        };
      }
      if (opts.throwOnInvalid) throw invalid;
    }
  }

  #stat(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  #readRules(
    configMtime: number | undefined,
    legacyMtime: number | undefined,
  ): { rules: NoiseRule[] } {
    if (configMtime !== undefined) {
      const parsed = JSON.parse(readFileSync(this.#configPath, "utf8")) as unknown;
      if (!isPlainObject(parsed)) throw new InvalidNoiseError(`${CONFIG_FILE} must contain an object`);
      if (parsed.mute !== undefined) return { rules: parseNoise({ mute: parsed.mute }) };
      // Config without mute: fall through to legacy if present.
    }
    if (legacyMtime !== undefined) {
      const parsed = JSON.parse(readFileSync(this.#legacyPath, "utf8")) as unknown;
      return { rules: parseNoise(parsed) };
    }
    return { rules: [] };
  }

  #update(change: (rules: NoiseRule[]) => NoiseRule[]): Promise<NoiseRule[]> {
    const write = this.#writes.then(async () => {
      await this.#migrateIfNeeded();
      // Fresh read for the tool path — must see a currently-bad file as an error.
      this.#lastCheckAt = 0;
      const current = await this.rules();
      const rules = change(current);

      let doc: Record<string, unknown> = {};
      let configExists = false;
      try {
        const text = readFileSync(this.#configPath, "utf8");
        configExists = true;
        const parsed = JSON.parse(text);
        if (!isPlainObject(parsed)) throw new InvalidNoiseError(`${CONFIG_FILE} must contain an object`);
        doc = { ...parsed };
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          // create below
        } else if (error instanceof SyntaxError) {
          throw new InvalidNoiseError(`${CONFIG_FILE}: ${error.message}`);
        } else {
          throw error;
        }
      }
      if (!configExists) {
        const detected = await detectProject(this.#root);
        if (detected !== undefined) doc.plugins = [REACT_NATIVE_PLUGIN];
      }
      doc.mute = rules;
      const temp = `${this.#configPath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`);
      await rename(temp, this.#configPath);
      await unlink(this.#legacyPath).catch(() => {});
      // Same-second writes can share an mtime; record what we know and reset the throttle.
      let configMtime: number | undefined;
      try {
        configMtime = statSync(this.#configPath).mtimeMs;
      } catch {
        configMtime = undefined;
      }
      this.#cached = { configMtimeMs: configMtime, legacyMtimeMs: undefined, rules };
      this.#peek = muteFilter(rules);
      this.#invalidWarning = undefined;
      this.#invalidError = undefined;
      this.#loggedInvalid = false;
      this.#lastCheckAt = this.#now();
      return rules;
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}

