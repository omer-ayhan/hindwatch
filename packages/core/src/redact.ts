import { isPlainObject } from "./util.js";

export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Defaults to "[REDACTED:<name>]". May reference capture groups like $1, or be a replace callback. */
  readonly replacement?: string | ((substring: string, ...args: string[]) => string);
}

/** True when digits (13–19) pass the Luhn check. Used so random ids and most timestamps stay visible. */
export function luhnOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * ISO/IEC 7812: a PAN's first digit is its issuer's industry, and the card networks issue under 2–6.
 * Epoch-ms times (1… until 2033) and counters starting 7–9 that pass Luhn by chance stay visible,
 * and so do airline (1) and fuel (7) cards; a counter starting 2–6 that passes Luhn still reads as a card.
 */
const PAYMENT_INDUSTRY = /^[2-6]/;

/** All-same digit runs pass Luhn but aren't cards. */
function isCardCandidate(digits: string): boolean {
  if (!PAYMENT_INDUSTRY.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnOk(digits);
}

function redactCard(match: string): string {
  const digits = match.replace(/\D/g, "");
  return isCardCandidate(digits) ? "[REDACTED:card]" : match;
}

/** Words that make a key name a secret when it ends with one. */
const SECRET_KEY_WORDS = String.raw`pass(?:word|wd)|secret|token|api[_-]?key|private[_-]?key|credentials?`;

// Every rule starts with a lookbehind for "not inside the same token", so a long run of
// token characters is scanned once instead of from every position (which was quadratic).
export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    name: "private-key",
    // An unterminated block (cut, or a broken log) is redacted through to the end of the string.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g,
  },
  { name: "bearer", pattern: /(?<![A-Za-z0-9_])(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "$1 [REDACTED:bearer]" },
  { name: "basic", pattern: /(?<![A-Za-z0-9_])(Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/g, replacement: "$1 [REDACTED:basic]" },
  // After bearer/basic so "Authorization: Bearer …" keeps the bearer replacement; other schemes land here.
  {
    name: "authorization",
    // [^\s"']+ so a closing quote on `-H "Authorization: …"` is not swallowed.
    pattern: /(?<![A-Za-z0-9_])(Authorization:\s*[A-Za-z][\w+-]*)\s+(?!\[REDACTED)[^\s"']+/gi,
    replacement: "$1 [REDACTED:authorization]",
  },
  { name: "cookie", pattern: /(?<![A-Za-z0-9_])((?:Set-)?Cookie:\s*)[^\r\n]+/gi, replacement: "$1[REDACTED:cookie]" },
  { name: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "aws-key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  {
    name: "vendor-key",
    pattern: /(?<![A-Za-z0-9_])(?:gh[po]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{10,}|xox[a-z](?:-[A-Za-z0-9_-]+)+|AIza[A-Za-z0-9_-]{20,})/g,
  },
  {
    name: "card",
    // 13–19 digits with optional spaces or dashes, not a decimal's fraction; Luhn failure leaves the match unchanged.
    pattern: /(?<!\d\.?)(?:\d[ -]?){12,18}\d(?!\d)/g,
    replacement: redactCard,
  },
  { name: "email", pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    name: "secret",
    // Any key that ends in a secret word (authToken, db_password, x-api-key), then a quoted value
    // whole (escape-aware, \"…\" inside stringified JSON too) or a bare one up to a delimiter.
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*?(?:${SECRET_KEY_WORDS}))(\\?["']?\s*[:=]\s*)` +
        String.raw`(\\"(?:[^\\"\n]|\\[^"\n])*(?:\\")?|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\s"',;&}]+)`,
      "gi",
    ),
    replacement: (_match: string, key: string, separator: string, value: string) => {
      const quote = /^\\?["']/.exec(value)?.[0] ?? "";
      return `${key}${separator}${quote}[REDACTED:secret]${quote}`;
    },
  },
];

const SENSITIVE_KEY = new RegExp(`pass|${SECRET_KEY_WORDS}|authorization|cookie`, "i");

function withGlobalFlag(rule: RedactionRule): RedactionRule {
  const { flags, source } = rule.pattern;
  return flags.includes("g") ? rule : { ...rule, pattern: new RegExp(source, `${flags}g`) };
}

function applyRule(text: string, rule: RedactionRule): string {
  const replacement = rule.replacement ?? `[REDACTED:${rule.name}]`;
  return typeof replacement === "function" ? text.replace(rule.pattern, replacement) : text.replace(rule.pattern, replacement);
}

/** Rules can be added but never removed, so no plugin can turn redaction off. */
export class Redactor {
  readonly #rules: RedactionRule[];

  constructor(extraRules: readonly RedactionRule[] = []) {
    this.#rules = [...DEFAULT_RULES, ...extraRules].map(withGlobalFlag);
  }

  add(rule: RedactionRule): void {
    this.#rules.push(withGlobalFlag(rule));
  }

  redact(text: string): string {
    return this.#rules.reduce((out, rule) => applyRule(out, rule), text);
  }

  /** Redacts strings anywhere in a structure, and any scalar stored under a sensitive key. */
  redactValue(value: unknown, key?: string): unknown {
    if (key !== undefined && SENSITIVE_KEY.test(key) && !isPlainObject(value) && !Array.isArray(value)) {
      return value === null || value === undefined ? value : `[REDACTED:${key}]`;
    }
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactValue(v, k)]));
    }
    return value;
  }
}
