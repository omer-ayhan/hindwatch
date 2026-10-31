#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { DaemonNotRunningError, call, cliClientId, ensureDaemon, status } from "./client.js";
import { commandOf, commandUsage, hasOwnHelp, OPTIONS, usage } from "./cli-commands.js";
import { CONFIG_FILE } from "./config.js";
import { EXPORT_FORMATS, exportToFile, type ExportFormat } from "./export-file.js";
import { clearStale, runDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { RpcError } from "./protocol.js";
import { resolveRoot } from "./paths.js";
import { daemonNote, ensureAndSend, queryOf, requests, UsageError, type DaemonRequest } from "./requests.js";
import { errorMessage } from "./util.js";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function findRoot(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return resolveRoot(explicit);
  const cwd = resolveRoot(process.cwd());
  for (let dir = cwd; ; dir = dirname(dir)) {
    if ((await exists(join(dir, CONFIG_FILE))) || (await exists(join(dir, "package.json")))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

function toNumber(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`--${flag} must be a number`);
  return number;
}

let pretty = false;

/** Compact by default, so what the budget measures is what lands on stdout. */
function print(value: unknown): void {
  process.stdout.write(`${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
}

function optionalPositional(positionals: readonly string[], what: string): string | undefined {
  if (positionals.length > 1) throw new UsageError(`expected at most one ${what}`);
  return positionals[0];
}

function positional(positionals: readonly string[], what: string): string {
  const [value, ...extra] = positionals;
  if (value === undefined || extra.length > 0) throw new UsageError(`expected exactly one ${what}`);
  return value;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  const { values } = parsed;
  const [command, ...positionals] = parsed.positionals;
  pretty = values.pretty === true;
  const known = command === undefined ? undefined : commandOf(command);
  if (command === undefined || values.help === true) {
    process.stdout.write(`${known !== undefined && hasOwnHelp(known) ? commandUsage(known) : usage()}\n`);
    return values.help === true ? 0 : 2;
  }
  if (known?.argument === undefined && positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const root = await findRoot(values.root);
  const clientId = values.client ?? cliClientId();
  let order: "asc" | "desc" | undefined;
  if (values.order === "asc" || values.order === "desc") order = values.order;
  else if (values.order !== undefined) throw new UsageError("--order must be asc or desc");
  let stale: boolean | undefined;
  if (values.stale === "true" || values.stale === "false") stale = values.stale === "true";
  else if (values.stale !== undefined) throw new UsageError("--stale must be true or false");
  const filters = (text?: string) => ({
    sinceId: toNumber("since-id", values["since-id"]),
    since: values.since,
    until: values.until,
    sources: values.source?.flatMap((list) => list.split(",")).filter((name) => name !== ""),
    level: values.level,
    order,
    app: values.app,
    pattern: values.pattern,
    includeMuted: values["include-muted"],
    stale,
    cursor: values.cursor,
    text,
  });
  const read = async (request: DaemonRequest) => {
    const result = await ensureAndSend(root, request, toNumber("budget", values.budget));
    print(result);
    return request.held?.(result) === false ? 1 : 0;
  };

  switch (command) {
    case "__daemon":
      await runDaemon(root);
      return 0;
    case "mcp": {
      // Loaded only here, so the daemon and every other command stay free of the SDK.
      const { serveMcp } = await import("./mcp.js");
      serveMcp(root);
      return 0;
    }
    case "start": {
      const ensured = await ensureDaemon(root);
      print({ ...ensured.status, ...daemonNote(ensured) });
      return 0;
    }
    case "doctor": {
      const report = await runDoctor(root);
      print(report);
      return report.ok ? 0 : 1;
    }
    case "status":
      try {
        print({ running: true, ...(await status(root)) });
      } catch (error) {
        if (!(error instanceof DaemonNotRunningError)) throw error;
        print({ running: false, root });
      }
      return 0;
    case "stop":
    case "exit":
      try {
        print(await call(root, "stop", { clientId, force: values.force === true }));
      } catch (error) {
        if (!(error instanceof DaemonNotRunningError)) throw error;
        print({ stopping: false, running: false, cleared: await clearStale(root) });
      }
      return 0;
    case "logs":
      return read(requests.logs(clientId, filters(), values["since-last"] === true));
    case "patterns":
      return read(requests.patterns(clientId, filters()));
    case "mark":
      return read(requests.mark(clientId, positional(positionals, "mark name")));
    case "marks":
      return read(requests.marks(clientId));
    case "export": {
      if (values.out === undefined) throw new UsageError("export needs --out <file>");
      const format = (values.format ?? "jsonl") as ExportFormat;
      if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`);
      if (values.follow === true && values.until !== undefined) throw new UsageError("--follow can't take --until");
      const query = queryOf({ ...filters(), cursor: undefined });
      const note = daemonNote(await ensureDaemon(root));
      const interrupt = new AbortController();
      process.once("SIGINT", () => interrupt.abort());
      const summary = await exportToFile({
        root,
        params: { clientId, query, follow: values.follow === true },
        out: values.out,
        confined: false,
        format,
        signal: interrupt.signal,
        warn: (message) => process.stderr.write(`hindwatch: warning: ${message}\n`),
      });
      print({ ...summary, ...note });
      return 0;
    }
    case "wait-for": {
      const text = optionalPositional(positionals, "text");
      const timeoutMs = toNumber("timeout", values.timeout);
      return read(requests.waitFor(clientId, filters(text), timeoutMs));
    }
    case "expect": {
      if (values.absent === values.present) throw new UsageError("expect needs exactly one of --absent or --present");
      const expect = values.absent === true ? "absent" : "present";
      return read(requests.expect(clientId, expect, filters(optionalPositional(positionals, "text")), toNumber("timeout", values.timeout)));
    }
    case "incidents":
      return read(requests.incidents(toNumber("since-id", values["since-id"]), values.cursor));
    case "incident": {
      const id = toNumber("incident id", positional(positionals, "incident id"))!;
      return read(requests.incident(id, values.part, values.cursor));
    }
    case "mute":
      return read(requests.mute(positional(positionals, "pattern id"), values["all-sources"] === true));
    case "unmute":
      return read(requests.unmute(positional(positionals, "rule id")));
    case "noise":
      return read(requests.noise());
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || (error instanceof TypeError && "code" in error);
    print({ error: errorMessage(error), ...(error instanceof RpcError && error.code ? { code: error.code } : {}) });
    process.exitCode = usage ? 2 : 1;
  },
);
