import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { call, DaemonNotRunningError, ensureDaemon, attach, type Attachment } from "./client.js";
import { budgetOf, DEFAULT_BUDGET_CHARS, MIN_BUDGET_CHARS, sizeOf } from "./budget.js";
import { runDoctor } from "./doctor.js";
import { EXPORT_FORMATS, exportTarget, exportToFile } from "./export-file.js";
import { INCIDENT_PARTS, type IncidentList } from "./incident-view.js";
import { RpcError, type DaemonStatus, type RpcNotice } from "./protocol.js";
import { daemonNote, queryOf, requests, send, type DaemonRequest, type Filters } from "./requests.js";
import { isMarkName } from "./marks.js";
import { LEVELS } from "./schema.js";
import { DEFAULT_WAIT_MS } from "./verify.js";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage, omitEmpty } from "./util.js";
import { HINDWATCH_VERSION } from "./version.js";

const SERVER_INFO = { name: "hindwatch", version: HINDWATCH_VERSION };

const INSTRUCTIONS = `Hindwatch: one redacted timeline of Metro, Android logcat, and iOS simulator and iPhone logs.
Crash/ANR → incidents, then incident. Overview → patterns (or incidents). Recent → logs with order "desc". Never page unfiltered logs.
Verify a fix: mark → user repro → expect. Compact JSON under a char budget; pass "next" as "cursor".`;

/** Hard max for MCP tool descriptions (tool-description-quality). */
export const MAX_TOOL_DESCRIPTION_CHARS = 280;

const log = (message: string) => process.stderr.write(`hindwatch mcp: ${message}\n`);

const instant = z
  .union([z.string(), z.number().int().nonnegative()])
  .describe("A mark name set with the mark tool, epoch ms, or an ISO 8601 time");

const filterShape = {
  sinceId: z.number().int().nonnegative().optional().describe("Only events after this event id"),
  since: instant.optional(),
  until: instant.optional(),
  sources: z.array(z.string().min(1)).optional().describe("Only these sources, by the names status lists"),
  level: z.enum(LEVELS).optional().describe("Minimum level"),
  app: z.string().optional().describe("Bundle or package id"),
  includeMuted: z.boolean().optional().describe("Also show events the project's noise rules mute"),
  stale: z
    .boolean()
    .optional()
    .describe("false = live only (ts at/after daemon start); true = pre-start replay only"),
  order: z.enum(["asc", "desc"]).optional().describe('Page order: "desc" = newest first (use for "what just happened"); "asc" = oldest first (default). Not with sinceLast.'),
};

const budget = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`Character budget for the answer (default ${DEFAULT_BUDGET_CHARS}, min ${MIN_BUDGET_CHARS})`);
const cursor = z.string().optional().describe('A previous result\'s "next", to continue where it stopped');
const text = z.string().optional().describe("Case-insensitive text the event message must contain");

/** Opt out of the auto status companion on verify/noise tools. Default ON (omit or true). */
const contextFlag = z
  .boolean()
  .optional()
  .describe("false skips the auto status companion (default true)");

/** Chars held back from the primary answer so the companion fits the same budget. */
const COMPANION_RESERVE = 700;
const COMPANION_TOP = 3;

const logsInput = z.object({ ...filterShape, pattern: z.string().optional().describe("Only events of this pattern id"), text, sinceLast: z.boolean().optional().describe('Only events this session hasn\'t read yet (asc only; reject with order "desc")'), budget, cursor }).strict();
const patternsInput = z.object({ ...filterShape, text, budget, cursor }).strict();
const waitForInput = z
  .object({ ...filterShape, text, timeoutMs: z.number().int().positive().optional().describe(`How long to wait (default ${DEFAULT_WAIT_MS})`), budget, context: contextFlag })
  .strict();
const expectInput = z
  .object({ ...filterShape, expect: z.enum(["absent", "present"]), text, timeoutMs: z.number().int().positive().optional().describe(`How long to wait for events still being processed (default ${DEFAULT_WAIT_MS})`), budget, context: contextFlag })
  .strict();
const markInput = z
  .object({ name: z.string().refine(isMarkName, "mark names start with a letter and use letters, digits, _ . -").describe("Starts with a letter; letters, digits, _ . -") })
  .strict();
const incidentsInput = z.object({ sinceId: z.number().int().nonnegative().optional().describe("Only incidents after this id: a previous result's lastId"), budget, cursor }).strict();
const incidentInput = z
  .object({ id: z.number().int().positive(), part: z.enum(INCIDENT_PARTS).optional().describe("One part in full instead of the one-call view"), budget, cursor })
  .strict();
const muteInput = z
  .object({
    patternId: z.string().optional().describe("One pattern id from patterns"),
    patternIds: z.array(z.string()).min(1).optional().describe("Several pattern ids to mute in one call"),
    subsystem: z.string().min(1).optional().describe("iOS subsystem to mute (prefer with category)"),
    category: z.string().min(1).optional().describe("iOS category; requires subsystem (category alone is refused)"),
    source: z.string().min(1).optional().describe("Limit subsystem mute to this source (e.g. ios-sim, ios)"),
    allSources: z.boolean().optional().describe("Mute for every source, not just each pattern's own"),
    context: contextFlag,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPattern = value.patternId !== undefined || value.patternIds !== undefined;
    const hasBothPatterns = value.patternId !== undefined && value.patternIds !== undefined;
    if (hasBothPatterns) {
      ctx.addIssue({ code: "custom", message: "provide patternId or patternIds, not both" });
    }
    if (value.category !== undefined && value.subsystem === undefined) {
      ctx.addIssue({ code: "custom", message: "category requires subsystem; category alone is refused" });
    }
    if (value.subsystem !== undefined && hasPattern) {
      ctx.addIssue({ code: "custom", message: "provide patternId/patternIds or subsystem, not both" });
    }
    if (!hasPattern && value.subsystem === undefined) {
      ctx.addIssue({ code: "custom", message: "provide patternId, patternIds, or subsystem" });
    }
  });
const unmuteInput = z.object({ ruleId: z.string(), context: contextFlag }).strict();
const stopInput = z.object({ force: z.boolean().optional().describe("Stop even though other clients are attached") }).strict();
const exportInput = z
  .object({ ...filterShape, out: z.string().min(1).describe("File to write, relative to the project root"), format: z.enum(EXPORT_FORMATS).optional() })
  .strict();
const noInput = z.object({}).strict();
const noiseInput = z.object({ context: contextFlag }).strict();

const answer = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(omitEmpty(value)) }],
  ...(isError ? { isError: true } : {}),
});

const failure = (error: unknown): CallToolResult =>
  answer({ error: errorMessage(error), ...(error instanceof RpcError && error.code ? { code: error.code } : {}) }, true);

/** Our code for input that doesn't match a tool's schema. */
export const INVALID_INPUT = "INVALID_INPUT";

/**
 * A tool's schema as tools/list shows it, with checking left to the handler: the SDK's own check
 * answers in plain text, ours in the CLI's {error, code} shape.
 */
function listedOnly(schema: z.ZodType): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return { "~standard": { version: 1, vendor: standard.vendor, validate: (value) => ({ value }), jsonSchema: standard.jsonSchema } };
}

function invalidInput(tool: string, error: z.ZodError): CallToolResult {
  const issues = error.issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`));
  return answer({ error: `invalid input for ${tool}: ${issues.join("; ")}`, code: INVALID_INPUT }, true);
}

const incidentUri = (id: number) => `incident://${id}`;

/**
 * One MCP connection's hold on the daemon: its own client id, attached on first use so that
 * building the server has no side effects. When the attachment ends (a stop, or the daemon
 * dying) the next use relaunches and the answer notes that history restarted.
 */
class Session {
  readonly clientId = `mcp-${randomUUID()}`;
  #attachment: Promise<Attachment> | undefined;
  /** Set when an attachment ended: whoever relaunched the daemon, its history is new. */
  #lost = false;
  #closed = false;

  constructor(
    readonly root: string,
    private readonly onNotice: (notice: RpcNotice) => void,
    private readonly onDetached: () => void,
  ) {}

  /** The note to merge into this answer: set when this call had to launch the daemon. */
  async ensure(): Promise<Record<string, unknown>> {
    const ensured = await ensureDaemon(this.root);
    // A stop's successor may already be up while our old attach socket is still closing.
    if (ensured.started && this.#attachment !== undefined) {
      const stale = this.#attachment;
      this.#attachment = undefined;
      this.#lost = true;
      void stale.then((attachment) => attachment.close(), () => {});
    }
    const restarted = ensured.started || (this.#attachment === undefined && this.#lost);
    if (this.#attachment === undefined && !this.#closed) {
      const attaching = attach(this.root, this.clientId, "mcp", this.onNotice);
      this.#attachment = attaching;
      attaching.then(
        (attachment) => {
          if (this.#closed) attachment.close();
          void attachment.closed.then(() => {
            if (this.#attachment === attaching) this.#attachment = undefined;
            this.#lost = true;
            if (!this.#closed) this.onDetached();
          });
        },
        () => {
          if (this.#attachment === attaching) this.#attachment = undefined;
        },
      );
      await attaching;
    }
    return daemonNote({ ...ensured, started: restarted });
  }

  close(): void {
    this.#closed = true;
    void this.#attachment?.then((attachment) => attachment.close(), () => {});
  }
}

function filtersOf(input: Partial<Filters> & { sources?: string[] | undefined }): Filters {
  const { sinceId, since, until, sources, level, app, pattern, includeMuted, stale, cursor, text, order } = input;
  return { sinceId, since, until, sources, level, app, pattern, includeMuted, stale, cursor, text, order };
}

async function allIncidents(session: Session): Promise<IncidentList["incidents"][number][]> {
  await session.ensure();
  const items: IncidentList["incidents"][number][] = [];
  let next: string | undefined;
  do {
    const page = (await send(session.root, requests.incidents(undefined, next), undefined, {})) as unknown as IncidentList;
    items.push(...page.incidents);
    next = page.next ?? undefined;
  } while (next !== undefined);
  return items;
}

/** The server for one connection. Pure: nothing touches the daemon until a request needs it. */
export function createServer(root: string, era: "legacy" | "modern"): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { resources: { subscribe: true, listChanged: true } },
    instructions: INSTRUCTIONS,
  });
  const subscribed = new Set<string>();
  let lastIncident = 0;
  const onNotice = (notice: RpcNotice) => {
    if (notice.notice !== "incident") return;
    const uri = incidentUri(notice.id);
    if (era === "modern" || subscribed.has(uri)) void server.server.sendResourceUpdated({ uri }).catch((error: unknown) => log(errorMessage(error)));
    if (notice.id > lastIncident) {
      lastIncident = notice.id;
      server.sendResourceListChanged();
    }
  };
  const session = new Session(root, onNotice, () => {
    lastIncident = 0;
    if (server.isConnected()) server.sendResourceListChanged();
  });
  server.server.onclose = () => session.close();

  const tool = <S extends z.ZodType>(
    name: string,
    config: { description: string; inputSchema: S; annotations?: ToolAnnotations },
    handle: (input: z.output<S>, ctx: ServerContext) => Promise<CallToolResult>,
  ) => {
    if (config.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
      throw new Error(`tool ${name} description is ${config.description.length} chars (max ${MAX_TOOL_DESCRIPTION_CHARS})`);
    }
    return server.registerTool(name, { ...config, inputSchema: listedOnly(config.inputSchema) }, async (args: unknown, ctx) => {
      const parsed = config.inputSchema.safeParse(args);
      return parsed.success ? handle(parsed.data, ctx) : invalidInput(name, parsed.error);
    });
  };

  const run = async (build: () => DaemonRequest, requested: number | undefined): Promise<CallToolResult> => {
    try {
      const request = build();
      const result = await send(root, request, requested, await session.ensure());
      return answer(result, request.held?.(result) === false);
    } catch (error) {
      return failure(error);
    }
  };

  /** Compact status + open incidents (verify) or top patterns (noise). Best-effort; never fails the tool. */
  const companionOf = async (kind: "verify" | "noise", room: number): Promise<Record<string, unknown> | undefined> => {
    if (room < 40) return undefined;
    try {
      const st = (await call(root, "status")) as DaemonStatus;
      const head: Record<string, unknown> = {
        events: st.events,
        ...(st.sources !== undefined && st.sources.length > 0 ? { sources: st.sources } : {}),
        ...(st.warnings !== undefined && st.warnings.length > 0 ? { warnings: st.warnings } : {}),
      };
      let body: Record<string, unknown> = {};
      const peekBudget = Math.min(2_000, Math.max(MIN_BUDGET_CHARS, room));
      if (kind === "verify") {
        const listed = (await send(root, requests.incidents(undefined, undefined), peekBudget, {})) as unknown as IncidentList;
        const open = listed.incidents.slice(0, COMPANION_TOP).map((item) => ({
          id: item.id,
          title: item.title.length > 80 ? `${item.title.slice(0, 80)}…` : item.title,
          count: item.count,
        }));
        if (open.length > 0) body = { open };
      } else {
        const page = (await send(root, requests.patterns(session.clientId, {}), peekBudget, {})) as {
          patterns?: { id: string; count: number }[];
        };
        const top = (page.patterns ?? []).slice(0, COMPANION_TOP).map((p) => ({ id: p.id, count: p.count }));
        if (top.length > 0) body = { top };
      }
      const companion = { ...head, ...body };
      if (sizeOf({ context: companion }) <= room) return companion;
      if (sizeOf({ context: head }) <= room) return head;
      return undefined;
    } catch {
      return undefined;
    }
  };

  /** Like run, then optionally append a budget-capped context companion (default ON). */
  const runContext = async (
    build: () => DaemonRequest,
    requested: number | undefined,
    context: boolean | undefined,
    kind: "verify" | "noise",
  ): Promise<CallToolResult> => {
    try {
      const request = build();
      const note = await session.ensure();
      const total = budgetOf(requested);
      const include = context !== false;
      const primaryRequested = include ? Math.max(MIN_BUDGET_CHARS, total - COMPANION_RESERVE) : requested;
      const result = await send(root, request, primaryRequested, note);
      const isError = request.held?.(result) === false;
      if (!include) return answer(result, isError);
      const room = total - sizeOf(result);
      const companion = await companionOf(kind, room);
      if (companion === undefined) return answer(result, isError);
      const merged = { ...result, context: companion };
      return sizeOf(merged) <= total ? answer(merged, isError) : answer(result, isError);
    } catch (error) {
      return failure(error);
    }
  };

  tool(
    "status",
    {
      description: "Use first or when other tools fail: starts the daemon if needed; shows sources, buffer, attached clients, and warnings (waiting/quiet/deaf sources). Not for reading logs or verifying a fix.",
      inputSchema: noInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      // stop returns before the peer releases its lock/socket; retry across that window.
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          const note = await session.ensure();
          return answer({ ...(await call(root, "status")) as Record<string, unknown>, ...note });
        } catch (error) {
          if (!(error instanceof DaemonNotRunningError) || Date.now() > deadline) return failure(error);
          await delay(50);
        }
      }
    },
  );
  tool(
    "doctor",
    {
      description:
        "Use when Hindwatch can't see the app or a source stays empty: checks Node, adb/devices, iOS sim tools, Metro, and the runtime folder, each with a fix. Starts nothing. Not for reading the timeline.",
      inputSchema: noInput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const report = await runDoctor(root);
        return answer(report, !report.ok);
      } catch (error) {
        return failure(error);
      }
    },
  );
  tool(
    "incidents",
    {
      description:
        "Use first after a crash, red screen, or ANR: lists incidents oldest-first. Pass lastId as sinceId for only new ones, then open one with incident. Not for browsing routine logs (patterns/logs).",
      inputSchema: incidentsInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => requests.incidents(input.sinceId, input.cursor), input.budget),
  );
  tool(
    "incident",
    {
      description:
        "Use to debug one incident: trigger, top app frames, code frame, prior error, and leading patterns. Ask with part for anything in omittedParts. Not for listing incidents (incidents) or raw logs.",
      inputSchema: incidentInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => requests.incident(input.id, input.part, input.cursor), input.budget),
  );
  tool(
    "logs",
    {
      description:
        "Use to read filtered timeline events. Always narrow (since mark, level, text) \u2014 never unfiltered pages; order \"desc\" for newest-first (not with sinceLast). Prefer patterns/incidents for overview. Not for waiting (wait_for) or verifying a fix (expect).",
      inputSchema: logsInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => requests.logs(session.clientId, filtersOf(input), input.sinceLast === true), input.budget),
  );
  tool(
    "patterns",
    {
      description:
        "Use for an overview of a noisy window: repeated-line patterns with counts (most frequent first). Same filters as logs. Drill one pattern via logs+pattern, or mute it. Not for verifying a fix (expect) or waiting on the next line (wait_for).",
      inputSchema: patternsInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => run(() => requests.patterns(session.clientId, filtersOf(input)), input.budget),
  );
  tool(
    "mark",
    {
      description:
        "Use right before the user reproduces a bug or tests a fix: names this timeline point for since/until on logs, patterns, expect, wait_for. Session-scoped; reusing a name moves it. Not for reading events.",
      inputSchema: markInput,
    },
    async (input) => run(() => requests.mark(session.clientId, input.name), undefined),
  );
  tool(
    "marks",
    { description: "Use to list marks this session has set. Not for creating a mark (mark).", inputSchema: noInput, annotations: { readOnlyHint: true } },
    async () => run(() => requests.marks(session.clientId), undefined),
  );
  tool(
    "wait_for",
    {
      description:
        "Use while the user reproduces: blocks until a matching event arrives (muted skipped unless includeMuted). Timeout \u2192 tool error with matched false. Not for already-buffered checks (expect/logs) or overview (patterns).",
      inputSchema: waitForInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => runContext(() => requests.waitFor(session.clientId, filtersOf(input), input.timeoutMs), input.budget, input.context, "verify"),
  );
  tool(
    "expect",
    {
      description:
        "Use after mark + user repro to verify a fix on the buffered window (set since to the mark). absent = error gone; present = success log appeared. Failures are tool errors that still carry matches. Not for waiting on future lines (wait_for) or browsing (logs/patterns).",
      inputSchema: expectInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => runContext(() => requests.expect(session.clientId, input.expect, filtersOf(input), input.timeoutMs), input.budget, input.context, "verify"),
  );
  tool(
    "mute",
    {
      description:
        "Use when a pattern or iOS subsystem is noise unrelated to the bug (patternId/patternIds, or subsystem[+category]; category alone refused). Returns only this call's mutes \u2014 list all with noise. Not for undoing (unmute) or reading the timeline.",
      inputSchema: muteInput,
    },
    async (input) => {
      const subsystem = input.subsystem;
      if (subsystem !== undefined) {
        return runContext(
          () =>
            requests.mute([], input.allSources === true, {
              subsystem,
              ...(input.category !== undefined ? { category: input.category } : {}),
              ...(input.source !== undefined ? { source: input.source } : {}),
            }),
          undefined,
          input.context,
          "noise",
        );
      }
      const ids = input.patternIds ?? [input.patternId as string];
      return runContext(() => requests.mute(ids, input.allSources === true), undefined, input.context, "noise");
    },
  );
  tool(
    "unmute",
    { description: "Use to undo a mute by rule id from noise. Returns only the id removed; list remaining with noise. Not for adding mutes (mute).", inputSchema: unmuteInput },
    async (input) => runContext(() => requests.unmute(input.ruleId), undefined, input.context, "noise"),
  );
  tool(
    "noise",
    { description: "Use to list mute rules when something expected seems missing. Not for adding or removing rules (mute/unmute).", inputSchema: noiseInput, annotations: { readOnlyHint: true } },
    async (input) => runContext(() => requests.noise(), undefined, input.context, "noise"),
  );
  tool(
    "export",
    {
      description:
        "Use only when the user wants logs as a file to share or attach: writes a redacted filtered window under the project (owner-only). Not for on-screen debugging (logs/patterns).",
      inputSchema: exportInput,
    },
    async (input, ctx) => {
      try {
        const query = queryOf(filtersOf(input));
        await exportTarget(root, input.out);
        const note = await session.ensure();
        const summary = await exportToFile({
          root,
          params: { clientId: session.clientId, query, follow: false },
          out: input.out,
          confined: true,
          format: input.format ?? "jsonl",
          signal: ctx.mcpReq.signal,
          warn: (message) => log(`warning: ${message}`),
        });
        return answer({ ...summary, ...note });
      } catch (error) {
        return failure(error);
      }
    },
  );
  tool(
    "stop",
    {
      description:
        "Use only when the user asks to stop Hindwatch: shuts the daemon and drops its buffer (refuses other clients unless force). Next tool call relaunches. Not for pausing capture temporarily.",
      inputSchema: stopInput,
      annotations: { destructiveHint: true },
    },
    async (input) => {
      try {
        return answer(await call(root, "stop", { clientId: session.clientId, force: input.force === true }));
      } catch (error) {
        if (error instanceof DaemonNotRunningError) return answer({ stopping: false, running: false });
        return failure(error);
      }
    },
  );

  server.registerResource(
    "incident",
    new ResourceTemplate("incident://{id}", {
      list: async () => ({
        resources: (await allIncidents(session)).map((item) => ({
          uri: incidentUri(item.id),
          name: `incident ${item.id}`,
          title: `${item.kind}: ${item.title}`,
          mimeType: "application/json",
        })),
      }),
    }),
    { description: "One incident in the one-call view, updated as it repeats.", mimeType: "application/json" },
    async (uri, variables) => {
      const id = Number(variables.id);
      await session.ensure();
      const detail = await send(root, requests.incident(id, undefined, undefined), undefined, {});
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(detail) }] };
    },
  );
  if (era === "legacy") {
    server.server.setRequestHandler("resources/subscribe", async (request) => {
      await session.ensure();
      subscribed.add(request.params.uri);
      return {};
    });
    server.server.setRequestHandler("resources/unsubscribe", (request) => {
      subscribed.delete(request.params.uri);
      return {};
    });
  }

  server.registerPrompt(
    "debug-this-crash",
    {
      title: "Debug this crash",
      description: "Find the cause of a crash the user can reproduce: mark, reproduce, then read the incident.",
      argsSchema: z.object({ symptom: z.string().optional().describe("What the user saw") }).strict(),
    },
    ({ symptom }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Debug this crash with Hindwatch${symptom ? `: ${symptom}` : ""}.`,
              '1. Call incidents and note lastId. Call mark with name "repro".',
              "2. Ask me to reproduce the crash, and wait until I say I did (or call wait_for with level error and since repro).",
              "3. Call incidents with sinceId set to that lastId, then incident on the new one. Use part only for what omittedParts lists.",
              '4. If no incident was raised, call patterns and logs with since "repro" and level warn.',
              "5. Explain the cause from the trigger, stack and code frame, and propose a fix.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "verify-my-fix",
    {
      title: "Verify my fix",
      description: "Check that a fix holds: mark, reproduce, then expect the error absent.",
      argsSchema: z.object({ error: z.string().describe("Text of the error that must no longer appear") }).strict(),
    },
    ({ error }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Verify my fix with Hindwatch. The error that must be gone: ${JSON.stringify(error)}.`,
              '1. Call mark with name "fix". Call incidents and note lastId.',
              "2. Ask me to reload the app and repeat the steps that used to fail, and wait until I say I did.",
              `3. Call expect with expect "absent", text ${JSON.stringify(error)} and since "fix".`,
              "4. Call incidents with sinceId set to that lastId to catch any other new crash.",
              "5. Report ok or not, quoting the matching events if it failed.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  return server;
}

/** How long requests still running at stdin EOF get to answer before the process ends anyway. */
export const EOF_ANSWER_MS = 5_000;

type RequestId = string | number;

/**
 * Stdio whose stdin EOF waits for the requests already read to be answered, up to EOF_ANSWER_MS,
 * so a client that writes its requests and closes stdin still gets every reply. The SDK's own
 * transport closes at EOF and drops them.
 */
class AnsweringStdio implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  readonly #input = new PassThrough();
  readonly #wire = new StdioServerTransport(this.#input, process.stdout);
  readonly #pending = new Set<RequestId>();
  #ended = false;
  #timer: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    this.#wire.onclose = () => {
      clearTimeout(this.#timer);
      this.onclose?.();
    };
    this.#wire.onerror = (error) => this.onerror?.(error);
    this.#wire.onmessage = (message) => {
      if (isJSONRPCRequest(message)) this.#pending.add(message.id);
      else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") this.#answered(message.params?.requestId as RequestId | undefined);
      this.onmessage?.(message);
    };
    await this.#wire.start();
    const stdin = process.stdin;
    stdin.on("error", (error) => this.#input.destroy(error));
    stdin.once("end", () => this.#eof());
    stdin.once("close", () => this.#eof());
    stdin.pipe(this.#input, { end: false });
  }

  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    try {
      await this.#wire.send(message);
    } finally {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) this.#answered(message.id);
    }
  }

  close(): Promise<void> {
    return this.#wire.close();
  }

  #answered(id: RequestId | undefined): void {
    if (id === undefined || !this.#pending.delete(id)) return;
    if (this.#ended && this.#pending.size === 0) this.#input.end();
  }

  #eof(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#pending.size === 0) {
      this.#input.end();
      return;
    }
    this.#timer = setTimeout(() => {
      log(`stdin closed with ${this.#pending.size} request(s) unanswered after ${EOF_ANSWER_MS} ms`);
      this.#input.end();
    }, EOF_ANSWER_MS);
  }
}

/** Serves MCP on stdin/stdout. stdout carries JSON-RPC only; everything else goes to stderr. */
export function serveMcp(root: string): StdioServerHandle {
  return serveStdio(({ era }) => createServer(root, era), {
    transport: new AnsweringStdio(),
    onerror: (error) => log(errorMessage(error)),
  });
}
