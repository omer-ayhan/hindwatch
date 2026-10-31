import { DEFAULT_BUDGET_CHARS, MIN_BUDGET_CHARS } from "./budget.js";
import { CONFIG_FILE } from "./config.js";
import { EXPORT_FORMATS } from "./export-file.js";
import { INCIDENT_PARTS } from "./incident-view.js";
import { LEVELS } from "./schema.js";
import { DEFAULT_WAIT_MS } from "./verify.js";

export const OPTIONS = {
  root: { type: "string" },
  client: { type: "string" },
  force: { type: "boolean" },
  "since-last": { type: "boolean" },
  "since-id": { type: "string" },
  timeout: { type: "string" },
  out: { type: "string" },
  format: { type: "string" },
  follow: { type: "boolean" },
  absent: { type: "boolean" },
  present: { type: "boolean" },
  since: { type: "string" },
  until: { type: "string" },
  source: { type: "string", multiple: true },
  level: { type: "string" },
  order: { type: "string" },
  app: { type: "string" },
  budget: { type: "string" },
  cursor: { type: "string" },
  pattern: { type: "string" },
  "include-muted": { type: "boolean" },
  stale: { type: "string" },
  "all-sources": { type: "boolean" },
  part: { type: "string" },
  pretty: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface Flag {
  readonly name: keyof typeof OPTIONS;
  /** What the flag takes, as help shows it. */
  readonly arg?: string;
  readonly text: string;
}

const CURSOR: Flag = { name: "cursor", arg: "<cursor>", text: 'continue from a previous result\'s "next"' };
const TIMEOUT = (what: string): Flag => ({ name: "timeout", arg: "<ms>", text: `${what} (default ${DEFAULT_WAIT_MS})` });

/** The filters of the timeline's reads: logs, patterns, wait-for, expect and export. */
const FILTERS: readonly Flag[] = [
  { name: "since-id", arg: "<id>", text: "only events after this id" },
  { name: "since", arg: "<at>", text: "window start: a mark name, epoch ms or an ISO time on the normalized timeline" },
  { name: "until", arg: "<at>", text: "window end, like --since" },
  { name: "source", arg: "<names>", text: "comma list or repeatable" },
  { name: "level", arg: "<level>", text: `minimum level: ${LEVELS.join(", ")}` },
  { name: "order", arg: "<asc|desc>", text: "page order (desc = newest first)" },
  { name: "app", arg: "<id>", text: "bundle or package id" },
  { name: "include-muted", text: `also show what mute[] in ${CONFIG_FILE} mutes` },
  { name: "stale", arg: "<bool>", text: "false = live only (at/after daemon start); true = pre-start replay only" },
];

const BUDGET: Flag = { name: "budget", arg: "<chars>", text: `character budget for the compact JSON on stdout (default ${DEFAULT_BUDGET_CHARS}, min ${MIN_BUDGET_CHARS})` };
const PRETTY: Flag = { name: "pretty", text: "indent the JSON (the budget applies to the compact form)" };

const GLOBAL: readonly Flag[] = [
  { name: "root", arg: "<dir>", text: `project root (default: nearest dir with ${CONFIG_FILE} or package.json)` },
  { name: "client", arg: "<id>", text: 'client id (default: $HINDWATCH_CLIENT, the terminal session, or "default")' },
];

const MCP_SETUP = [
  "mcp setup (the server's working directory picks the project; add --root <dir> to pin one):",
  '  Cursor       .cursor/mcp.json: {"mcpServers":{"hindwatch":{"command":"npx","args":["-y","hindwatch","mcp","--root","${workspaceFolder}"]}}}',
  "  Claude Code  claude mcp add hindwatch -- npx -y hindwatch mcp",
  "  Codex        codex mcp add hindwatch -- npx -y hindwatch mcp",
];

interface Command {
  /** The command and its arguments, as the usage line shows them. */
  readonly usage: string;
  readonly summary: string;
  /** The positional argument it takes, if any. */
  readonly argument?: string;
  readonly flags?: readonly Flag[];
  readonly filters?: boolean;
  /** What it prints on stdout: the daemon's answer under the output budget, other JSON (the default), or nothing. */
  readonly output?: "budgeted" | "json" | "none";
  readonly details?: readonly string[];
}

/** Every command, in the order help lists them; "exit" is "stop". */
export const COMMANDS: Readonly<Record<string, Command>> = {
  start: { usage: "start", summary: "start the project's daemon (safe to repeat)" },
  status: { usage: "status", summary: "show the daemon's state" },
  doctor: { usage: "doctor", summary: "check what the config needs is installed and reachable (exit 1 if not); starts nothing" },
  stop: {
    usage: "stop | exit",
    summary: "stop the daemon and drop its buffer",
    flags: [{ name: "force", text: "stop even though other clients are attached" }],
  },
  logs: {
    usage: "logs [filters]",
    summary: "read the unified timeline",
    filters: true,
    output: "budgeted",
    flags: [
      { name: "since-last", text: "only events this client hasn't read yet (not with --order desc)" },
      { name: "pattern", arg: "<id>", text: "only events of this pattern, by an id from patterns" },
      CURSOR,
    ],
  },
  mark: {
    usage: "mark <name>",
    summary: "mark this point of the timeline, for --since/--until (per client)",
    argument: "mark name",
    output: "budgeted",
    details: ["a name starts with a letter and uses letters, digits, _ . -"],
  },
  marks: { usage: "marks", summary: "list this client's marks", output: "budgeted" },
  "wait-for": {
    usage: "wait-for [text] [filters]",
    summary: "wait for the next matching event (exit 1 on timeout)",
    argument: "text",
    filters: true,
    output: "budgeted",
    flags: [TIMEOUT("how long to wait")],
  },
  expect: {
    usage: "expect --absent|--present [text] [filters]",
    summary: "check the window once queued events have landed (exit 1 if it doesn't hold)",
    argument: "text",
    filters: true,
    output: "budgeted",
    flags: [
      { name: "absent", text: "hold when nothing matches" },
      { name: "present", text: "hold when something matches" },
      TIMEOUT("how long to wait for events still being processed"),
    ],
  },
  export: {
    usage: "export --out <file> [filters]",
    summary: "write the window to a file (owner-only), redacted; warns on any gap",
    filters: true,
    flags: [
      { name: "out", arg: "<file>", text: "the file to write" },
      { name: "format", arg: `<${EXPORT_FORMATS.join("|")}>`, text: `${EXPORT_FORMATS[0]} (default) is the full event schema, one event per line` },
      { name: "follow", text: "keep appending until Ctrl-C (not with --until)" },
    ],
  },
  patterns: {
    usage: "patterns [filters]",
    summary: "the timeline folded into repeated-line patterns with counts, most frequent first",
    filters: true,
    output: "budgeted",
    flags: [CURSOR],
  },
  incidents: {
    usage: "incidents",
    summary: "incidents, oldest first",
    output: "budgeted",
    flags: [{ name: "since-id", arg: "<id>", text: "only incidents after this id: a previous result's lastId" }, CURSOR],
  },
  incident: {
    usage: "incident <id>",
    summary: "one incident: trigger, stack, code, first error and what led up to it",
    argument: "incident id",
    output: "budgeted",
    flags: [{ name: "part", arg: `<${INCIDENT_PARTS.join("|")}>`, text: "one part in full (context pages with --cursor)" }, CURSOR],
  },
  mute: {
    usage: "mute <pattern-id>",
    summary: `add the pattern to mute[] in ${CONFIG_FILE}, for its source`,
    argument: "pattern id",
    output: "budgeted",
    flags: [{ name: "all-sources", text: "mute it for every source" }],
  },
  unmute: { usage: "unmute <rule-id>", summary: "remove a mute rule", argument: "rule id", output: "budgeted" },
  noise: { usage: "noise", summary: "list the mute rules", output: "budgeted" },
  mcp: { usage: "mcp", summary: "serve the MCP tools, incident resources and prompts on stdio", output: "none", details: MCP_SETUP },
};

const ALIASES: Readonly<Record<string, string>> = { exit: "stop" };

/** The command a name runs, aliases included. */
export function commandOf(name: string): Command | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : Object.hasOwn(ALIASES, name) ? COMMANDS[ALIASES[name]!] : undefined;
}

type Row = readonly [string, string];

function table(rows: readonly Row[], width = Math.max(...rows.map(([left]) => left.length))): string[] {
  return rows.map(([left, right]) => `  ${left.padEnd(width + 2)}${right}`);
}

const flagRow = (flag: Flag): Row => [`--${flag.name}${flag.arg === undefined ? "" : ` ${flag.arg}`}`, flag.text];

/** Titled flag sections, their columns lined up across all of them; empty sections are left out. */
function flagSections(sections: readonly (readonly [string, readonly Flag[]])[]): string[] {
  const width = Math.max(...sections.flatMap(([, flags]) => flags.map((flag) => flagRow(flag)[0].length)));
  return sections.flatMap(([title, flags]) => section(title, table(flags.map(flagRow), width)));
}

const OUTPUT_FLAGS: Readonly<Record<NonNullable<Command["output"]>, readonly Flag[]>> = { budgeted: [BUDGET, PRETTY], json: [PRETTY], none: [] };

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ["", `${title}:`, ...lines];
}

export function usage(): string {
  const named = (pick: (command: Command) => boolean) => Object.keys(COMMANDS).filter((name) => pick(COMMANDS[name]!)).join(", ");
  return [
    "usage: hindwatch <command> [options]",
    "       hindwatch <command> -h    the options of one command",
    ...section("commands", table(Object.values(COMMANDS).map((command) => [command.usage, command.summary]))),
    ...flagSections([
      [`filters (${named((command) => command.filters === true)})`, FILTERS],
      ["output", OUTPUT_FLAGS.budgeted],
      ["global", GLOBAL],
    ]),
    "",
    ...MCP_SETUP,
  ].join("\n");
}

/** Whether a command has more to say than its line in {@link usage}. */
export function hasOwnHelp(command: Command): boolean {
  return command.argument !== undefined || command.flags !== undefined || command.filters === true || command.details !== undefined;
}

export function commandUsage(command: Command): string {
  return [
    `usage: hindwatch ${command.usage}${command.flags === undefined ? "" : " [options]"}`,
    "",
    command.summary,
    ...(command.details ?? []).flatMap((line, index) => (index === 0 ? ["", line] : [line])),
    ...flagSections([
      ["options", command.flags ?? []],
      ["filters", command.filters === true ? FILTERS : []],
      ["output", OUTPUT_FLAGS[command.output ?? "json"]],
      ["global", GLOBAL],
    ]),
  ].join("\n");
}
