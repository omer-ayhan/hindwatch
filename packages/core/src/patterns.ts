import { createHash } from "node:crypto";
import { clipText } from "./budget.js";
import { levelRank, type DebugEvent, type Level } from "./schema.js";

const MAX_TEMPLATE_CHARS = 300;
const MAX_SAMPLE_CHARS = 160;

// Applied in order to a message's first line. Each starts at a token boundary (lookbehind), so
// every rule stays linear on a long run of token characters.
const VARIABLES: readonly (readonly [RegExp, string])[] = [
  [/(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, "{url}"],
  [/(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi, "{uuid}"],
  // Full ISO-8601 before {num}: otherwise the hour after T is kept (T is a letter lookbehind).
  [/(?<![A-Za-z0-9])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "{iso}"],
  [/(?<![A-Za-z0-9_])0x[0-9a-f]+(?![A-Za-z0-9_])/gi, "{hex}"],
  [/(?<![A-Za-z0-9_])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}(?![A-Za-z0-9_])/gi, "{hex}"],
  [/(?<![A-Za-z0-9_.])\d+(?:\.\d+)*/g, "{num}"],
];

/** "Image load failed https://x/1.png after 30ms" -> "Image load failed {url} after {num}ms". */
export function templateOf(msg: string): string {
  const firstLine = msg.split("\n", 1)[0] ?? "";
  const template = VARIABLES.reduce((text, [pattern, slot]) => text.replace(pattern, slot), firstLine);
  return template.length > MAX_TEMPLATE_CHARS ? `${template.slice(0, MAX_TEMPLATE_CHARS)}…` : template;
}

/** Stable across daemons and restarts, so an id an agent saw can be muted later. */
export function patternId(source: string, template: string): string {
  return `p${createHash("sha1").update(`${source}\u0000${template}`).digest("hex").slice(0, 10)}`;
}

export interface PatternKey {
  readonly id: string;
  readonly template: string;
}

const keys = new WeakMap<DebugEvent, PatternKey>();

/** Memoized per stored event, which never changes. */
export function patternOf(event: DebugEvent): PatternKey {
  let key = keys.get(event);
  if (key === undefined) {
    const template = templateOf(event.msg);
    key = { id: patternId(event.source, template), template };
    keys.set(event, key);
  }
  return key;
}

export interface Pattern {
  readonly id: string;
  readonly template: string;
  readonly source: string;
  /** The most severe level among its events. */
  readonly level: Level;
  readonly count: number;
  readonly firstId: number;
  readonly lastId: number;
  readonly firstTs: number;
  readonly lastTs: number;
  /** The first event's line, when it says more than the template. */
  readonly sample?: string;
}

interface Group {
  key: PatternKey;
  first: DebugEvent;
  last: DebugEvent;
  level: Level;
  count: number;
}

/** Folds events into patterns, in order of each pattern's first event. */
export function collapse(events: readonly DebugEvent[]): Pattern[] {
  const groups = new Map<string, Group>();
  for (const event of events) {
    const key = patternOf(event);
    const group = groups.get(key.id);
    if (group === undefined) {
      groups.set(key.id, { key, first: event, last: event, level: event.level, count: 1 });
      continue;
    }
    group.count++;
    group.last = event;
    if (levelRank(event.level) > levelRank(group.level)) group.level = event.level;
  }
  return [...groups.values()].map(({ key, first, last, level, count }) => {
    const line = first.msg.split("\n", 1)[0] ?? "";
    return {
      id: key.id,
      template: key.template,
      source: first.source,
      level,
      count,
      firstId: first.id,
      lastId: last.id,
      firstTs: first.ts,
      lastTs: last.ts,
      ...(line === key.template ? {} : { sample: clipText(line, MAX_SAMPLE_CHARS) }),
    };
  });
}
