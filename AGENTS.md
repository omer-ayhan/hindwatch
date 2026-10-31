# AGENTS.md

Hindwatch runs one background daemon per project root. It records Android logcat, iOS simulator and iPhone logs and React Native (Metro) into one redacted timeline, and serves it to agents over a JSON CLI and an MCP server.

## Layout

- `packages/core`: the daemon, CLI (`src/cli.ts`), MCP server (`src/mcp.ts`), the built-in `android`, `ios-sim` and `ios` sources, ingest, redaction, incidents and the plugin contract (`src/plugin.ts`, exported for plugins by `src/plugin-api.ts`). Tests are in `test/`, and timing-sensitive ones are in `test/serial/`.
- `packages/plugin-react-native`: Metro, CDP and symbolication. Core knows it only by package name.
- `packages/plugin-fixture`: a replay plugin for tests and perf.
- `packages/hindwatch`: the published package. `npm run build` bundles core and the react-native plugin into `dist/`.
- `examples/crash-detector`: the example detector that the tests, docs and demo load.
- `scripts`: perf, the pack and live smoke tests, and the leftover check.
- `docs`, `fixtures`: user docs and recorded logs for tests.
- `PLAN.md` is gitignored and belongs to the owner. Read it for design answers, but never edit or commit it.

## Commands

- `npm run typecheck`
- `npm test`: the parallel tests, then `test/serial/` one at a time, wrapped in the leftover check.
- `npm run perf`: the CPU, memory, kill -9 and stop budgets on a replay, also wrapped in the leftover check.
- `npm run smoke:pack`: packs `hindwatch`, installs the tarball in a temp project and drives the CLI and MCP.
- `npm run build -w hindwatch`: builds `packages/hindwatch/dist`. `npm install`, `npm test` and `npm pack` run it too, because `examples/crash-detector` imports `hindwatch` and the workspace resolves that to `dist`.
- `npm audit`

The leftover check (`scripts/no-leftovers.ts`) gives the command its own runtime folder through `HINDWATCH_RUNTIME_DIR`. It fails on any process left behind and on any file except daemon logs (`.log`, `.log.1`, `.stderr`). Run the checks before every commit; all must pass.

## Hard rules

- Core vs plugins: device and framework specifics beyond the built-in sources go in plugins, written against the contract in `plugin.ts`. `PLUGIN_API_VERSION` stays `"0.1"`. The `hindwatch` package exports only the contract types and `PLUGIN_API_VERSION`.
- In `mcp` mode, stdout carries JSON-RPC only. Logs and diagnostics go to stderr.
- One code path: the CLI and the MCP server build their daemon requests in `requests.ts` and talk to the same daemon. Don't give either surface its own logic.
- The MCP SDK loads lazily, through the `import("./mcp.js")` in the CLI, so other commands never load it. The build checks this. Use SDK v2 (`@modelcontextprotocol/server`) only.
- Limits are fixed and change only with the owner's sign-off:
  - daemon RSS ≤ 150 MB;
  - steady CPU ≤ 10% of one core;
  - idle CPU ≤ 0.5%;
  - children gone ≤ 5 s after the daemon dies;
  - redaction of a 1 MB line < 50 ms, with 1 MB taking ≤ 20x as long as 100 KB.
- Redaction before anything leaves: every event and every enricher patch goes through `Ingest` (`prepare`, `applyPatch`), which redacts it before it is buffered and before plugins, the CLI, MCP or an export see it.
- No new dependencies without asking first.
- New tests assert ratios or ordering, not absolute times.

## Device safety

- Never erase or reset a simulator. Shut down only emulators or simulators you booted.
- Never run `adb kill-server` or `adb start-server`.
- Don't run `doctor` or anything else against a real Metro on port 8081, or against an app or project you weren't given. The tests use fakes in `packages/core/test/bin`.
- Never touch the real `~/.hindwatch/run`. Tests and perf use an isolated runtime folder.

## Commits

- Local commits only: never push, `npm publish` or rewrite history.
- Keep commits small and focused, each with its tests.
- Write Conventional Commit messages (`feat:`, `fix:`, `feat!:`): releases read them for the version and the release notes.
- Stage by path, never `git add -A`, and check `git log` first.
- Write no comments that restate the code.
