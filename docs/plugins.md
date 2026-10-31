# Plugins

A plugin adds sources, enrichers and detectors to the daemon. The react-native plugin is one: a Metro source, a symbolicating enricher and a redbox detector.

The contracts below are the ones in `packages/core/src/plugin.ts`. The `hindwatch` package exports them, and nothing else:

```ts
import { PLUGIN_API_VERSION } from "hindwatch";
import type { ClockSample, DebugEvent, Detector, Enricher, EventPatch, Incident, PluginFactory, PluginManifest, RawEvent, RedactedEvent, Source, SourceContext } from "hindwatch";
```

A plugin that imports from `hindwatch` needs it installed in the project: `npm install --save-dev hindwatch`.

## API version

```ts
export const PLUGIN_API_VERSION = "0.1";
```

Every plugin states the version it targets in `apiVersion`. The daemon refuses a plugin whose version doesn't match its own, with an error like this:

```
my-plugin targets plugin API 0.2, but this core speaks 0.1
```

0.x is unstable. Any breaking change bumps it.

## Plugins see only redacted events

The core redacts every event before a plugin sees it:

1. A source emits a raw event.
2. The core validates and redacts it.
3. Enrichers get the redacted event. What an enricher returns is redacted again.
4. The event is stored.
5. Detectors get the stored event.

So no plugin can read an unredacted value, or add one. Enrichers and detectors get copies, so editing the event in place changes nothing. Plugin log lines are redacted too. No plugin can turn redaction off.

## The factory

A plugin is an ES module whose default export is a factory. The factory gets the options from the config file and returns a manifest:

```ts
export type PluginFactory = (
  options: Readonly<Record<string, unknown>>,
) => PluginManifest | Promise<PluginManifest>;

export interface PluginManifest {
  readonly name: string;
  readonly apiVersion: string;
  readonly sources: readonly Source[];
  readonly enrichers?: readonly Enricher[] | undefined;
  readonly detectors?: readonly Detector[] | undefined;
}
```

Throw from the factory if the options are wrong. The CLI and `doctor` report the error before any daemon starts; if a running daemon reloads a bad factory, the error goes to its log.

A plugin module must be side-effect free at import, and so must its factory. The CLI and `doctor` import the module and call the factory only to read the manifest; they never call a source's `start`. Only the daemon does. Spawn processes, open sockets and watch files in `start`, never at import or in the factory.

## Source

A source produces events.

```ts
export interface Source {
  readonly name: string;
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
}

export interface SourceContext {
  /** Project root the daemon serves. */
  readonly root: string;
  /** Aborted when the daemon stops this source. */
  readonly signal: AbortSignal;
  /** Hands one event to the core, which validates, redacts and timestamps it. */
  emit(event: RawEvent): void;
  /** Records a device clock reading so device time can be mapped onto host time. */
  setClockSample(deviceId: string, sample: ClockSample): void;
  log(message: string): void;
}
```

The event a source emits:

```ts
export interface RawEvent {
  readonly source: string;
  readonly deviceId: string;
  readonly app: string;
  readonly level: "verbose" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly msg: string;
  readonly pid?: number | undefined;
  /** Device clock in epoch ms. Absent when the source has none. */
  readonly deviceTs?: number | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}
```

`ClockSample` is `{ deviceTs, hostTs }`, both epoch ms. Call `setClockSample` when you read the device clock. The core then maps `deviceTs` onto the host clock. Without a sample, or without `deviceTs`, the event gets the host time and `estimated: true`.

The core checks every event. One that doesn't fit the schema is dropped and counted in `status` as `invalidEvents`.

Stop work when `ctx.signal` aborts or `stop()` is called.

## Enricher

An enricher adds to an event after redaction.

```ts
export interface Enricher {
  readonly name: string;
  enrich(event: RedactedEvent): EventPatch | undefined | Promise<EventPatch | undefined>;
}

export interface EventPatch {
  readonly msg?: string | undefined;
  /** Merged over the event's attrs. */
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}
```

`RedactedEvent` is the stored event without its `id`. Return a patch, or `undefined` to leave the event alone.

- Enrichers run in order. Each sees the output of the one before.
- An enricher that throws or takes more than 2 seconds is skipped for that event. The error goes to the daemon log.
- Each source has at most 1000 events waiting for enrichers. Past that, events are stored without enrichment and counted in `status` as `unenrichedEvents`.

## Detector

A detector looks at each stored event and may raise an incident.

```ts
export interface Incident {
  readonly kind: string;
  readonly title: string;
}

export interface Detector {
  readonly name: string;
  detect(event: DebugEvent): Incident | undefined;
}
```

`detect` is synchronous. A new incident is also added to the timeline as an event, with `attrs.incident`. A repeat of the same incident only bumps its `count`. A detector that throws is logged and skipped.

`DebugEvent` is the stored event. It has everything in `RawEvent`, plus `id`, `ts`, `hostTs`, `estimated`, `sessionId` and `schemaVersion`.

## Installing a plugin in a project

1. Install the plugin package in the project:

   ```sh
   npm install --save-dev hindwatch-plugin-example
   ```

2. List it in `hindwatch.config.json`:

   ```json
   {
     "plugins": [
       "hindwatch-plugin-example",
       { "module": "./tools/my-plugin.js", "options": { "file": "app.jsonl" } }
     ]
   }
   ```

An entry is a module name or `{ "module", "options" }`. A bare name resolves through the project's `node_modules`. A path starting with `.`, or an absolute path, resolves against the project root.

`npx hindwatch` runs plain Node, so a plugin must be JavaScript, not TypeScript.

A config file turns zero-config off. List `@hindwatch/plugin-react-native` too if you want Metro's JS logs.

`status` lists the loaded plugins under `plugins`.

## A minimal plugin

This is the fixture plugin from `packages/plugin-fixture`, cut down to plain JavaScript. It replays a JSONL file once on start. Save it as `tools/my-plugin.js`:

```js
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PLUGIN_API_VERSION } from "hindwatch";

export default function createPlugin(options) {
  if (typeof options.file !== "string") throw new Error("my-plugin: options.file must be a path");
  return {
    name: "my-plugin",
    apiVersion: PLUGIN_API_VERSION,
    sources: [
      {
        name: "replay",
        async start(ctx) {
          const text = await readFile(resolve(ctx.root, options.file), "utf8");
          for (const line of text.split("\n")) {
            if (line.trim() === "" || ctx.signal.aborted) continue;
            ctx.emit({ source: "replay", deviceId: "replay", app: "com.example.app", level: "info", ...JSON.parse(line) });
          }
        },
        async stop() {},
      },
    ],
  };
}
```

Each line of the file is an event, such as:

```json
{"level": "error", "msg": "TypeError: Cannot read property 'name' of undefined", "attrs": {"exception": true}}
```

The config entry is the second one in the example above.

## A detector

[`examples/crash-detector/index.js`](../examples/crash-detector/index.js) is a plugin with no sources and one detector. It raises a `crash` incident for each event with `attrs.exception` set. It imports `PLUGIN_API_VERSION` from `hindwatch`, like your plugins will. The tests and the demo project load that file, and `npm run smoke:pack` copies it unchanged into a project that installs the packed tarball.

Copy it to `tools/crash-detector.js` and add it after the replay plugin:

```json
{
  "plugins": [
    { "module": "./tools/my-plugin.js", "options": { "file": "app.jsonl" } },
    { "module": "./tools/crash-detector.js" }
  ]
}
```

Then:

```sh
npx hindwatch start
npx hindwatch incidents
```
