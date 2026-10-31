import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, NotStartableError, PackageJsonError, REACT_NATIVE_PLUGIN, capturingPlugins, detectProject, loadConfig, loadPlugin, parseConfig, startConfig } from "@hindwatch/core";
import { CRASH_DETECTOR_PLUGIN, IDLE_SOURCE_PLUGIN } from "./helpers.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/projects/${name}`, import.meta.url));

async function withRoot(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hindwatch-config-"));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** startConfig only counts plugins, so this one need not exist. */
const ONE_SOURCE = JSON.stringify({ plugins: ["./a-source.js"] });

test("with no config file, an Expo or bare React Native project gets the react-native plugin", async () => {
  for (const name of ["expo", "bare-rn"] as const) {
    const config = await loadConfig(fixture(name));
    assert.deepEqual(config.detected, { kind: name, packageJson: join(fixture(name), "package.json") }, name);
    assert.deepEqual(config.plugins, [{ module: REACT_NATIVE_PLUGIN, options: {} }], name);
    assert.deepEqual(config.sources, {}, name);
  }
});

test("a project that depends on neither gets no plugins", async () => {
  const config = await loadConfig(fixture("plain"));
  assert.deepEqual([config.detected, config.plugins], [undefined, []]);
});

test("expo as a devDependency is still Expo, and expo wins over react-native", async () => {
  await withRoot({ "package.json": JSON.stringify({ dependencies: { "react-native": "0.81.4" }, devDependencies: { expo: "~54.0.0" } }) }, async (root) => {
    assert.equal((await detectProject(root))?.kind, "expo");
  });
});

test("a config file wins over detection, even an empty one", async () => {
  const expo = await readFile(join(fixture("expo"), "package.json"), "utf8");
  await withRoot({ "package.json": expo, [CONFIG_FILE]: "{}" }, async (root) => {
    const config = await loadConfig(root);
    assert.deepEqual([config.detected, config.plugins], [undefined, []]);
    await assert.rejects(startConfig(root), { message: `nothing to capture in ${root}: ${join(root, CONFIG_FILE)} names no sources or plugins; add a source to ${CONFIG_FILE}` });
  });
});

test("a missing or odd package.json is not a React Native project", async () => {
  await withRoot({}, async (root) => assert.equal(await detectProject(root), undefined));
  await withRoot({ "package.json": JSON.stringify({ dependencies: ["expo"] }) }, async (root) => assert.equal(await detectProject(root), undefined));
});

test("with no config file, a package.json that doesn't parse is an error naming the file", async () => {
  await withRoot({ "package.json": "{ not json" }, async (root) => {
    const path = join(root, "package.json");
    await assert.rejects(loadConfig(root), (error) => error instanceof PackageJsonError && error.path === path && error.message.startsWith(`${path} doesn't parse: `));
    await assert.rejects(startConfig(root), PackageJsonError);
  });
  await withRoot({ "package.json": "{ not json", [CONFIG_FILE]: ONE_SOURCE }, async (root) => assert.equal((await startConfig(root)).file, join(root, CONFIG_FILE)));
});

test("a daemon starts only when its config, file or detected, names a source", async () => {
  await withRoot({}, async (home) => {
    assert.equal((await startConfig(fixture("expo"), home)).detected?.kind, "expo");
    await assert.rejects(startConfig(fixture("plain"), home), {
      name: "InvalidConfigError",
      message: `nothing to capture in ${fixture("plain")}: there is no ${CONFIG_FILE} and ${join(fixture("plain"), "package.json")} depends on neither expo nor react-native; add a source to ${CONFIG_FILE}`,
    });
    const empty = join(home, "app");
    await mkdir(empty);
    await assert.rejects(startConfig(empty, home), (error) => error instanceof NotStartableError && /there is no package\.json; add a source to hindwatch\.config\.json$/.test(error.message));
    await writeFile(join(empty, CONFIG_FILE), "{}");
    await assert.rejects(startConfig(empty, home), (error) => error instanceof NotStartableError && error.message === `nothing to capture in ${empty}: ${join(empty, CONFIG_FILE)} names no sources or plugins; add a source to ${CONFIG_FILE}`);
    await writeFile(join(empty, CONFIG_FILE), ONE_SOURCE);
    assert.equal((await startConfig(empty, home)).plugins.length, 1);
  });
});

test("the home folder and / alone never get a daemon, but a project kept there does", async () => {
  await withRoot({}, async (home) => {
    const real = await realpath(home);
    await assert.rejects(startConfig(home, home), { message: `${home} is your home folder, with no ${CONFIG_FILE} or package.json; run hindwatch from your project folder or pass --root <dir>` });
    await assert.rejects(startConfig(real, home), { message: /^\S+ is your home folder/ });
    await assert.rejects(startConfig("/", home), { message: `/ is the filesystem root, with no ${CONFIG_FILE} or package.json; run hindwatch from your project folder or pass --root <dir>` });
    await writeFile(join(home, "package.json"), "{}");
    await assert.rejects(startConfig(home, home), { message: /^nothing to capture in / });
    await writeFile(join(home, CONFIG_FILE), ONE_SOURCE);
    assert.equal((await startConfig(home, home)).file, join(home, CONFIG_FILE));
  });
});

test("a project that doesn't install the react-native plugin gets the bundled one; other bare names still have to be installed", async () => {
  await withRoot({}, async (root) => {
    const manifest = await loadPlugin(root, { module: REACT_NATIVE_PLUGIN, options: { port: 1 } });
    assert.equal(manifest.name, "react-native");
    await assert.rejects(loadPlugin(root, { module: "@hindwatch/not-a-plugin", options: {} }), { code: "MODULE_NOT_FOUND" });
  });
});

test("only sources count: a config whose plugins bring just detectors or enrichers refuses, a built-in or plugin source starts", async () => {
  const enricher = `export default () => ({ name: "tagger", apiVersion: "0.1", sources: [], enrichers: [{ name: "tag", enrich: () => undefined }] });\n`;
  await withRoot({ "tagger.js": enricher, "idle.js": IDLE_SOURCE_PLUGIN }, async (root) => {
    const refuses = async (plugins: unknown[], names: string) => {
      await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins }));
      const config = await startConfig(root);
      await assert.rejects(capturingPlugins(root, config), (error) =>
        error instanceof NotStartableError &&
        error.message === `nothing to capture in ${root}: ${join(root, CONFIG_FILE)} has no source, only plugins without one (${names}); add a source to ${CONFIG_FILE}`);
    };
    await refuses([CRASH_DETECTOR_PLUGIN], "crash-detector");
    await refuses(["./tagger.js"], "tagger");
    await refuses([CRASH_DETECTOR_PLUGIN, "./tagger.js"], "crash-detector, tagger");

    await writeFile(join(root, CONFIG_FILE), JSON.stringify({ plugins: [CRASH_DETECTOR_PLUGIN, "./idle.js"] }));
    assert.deepEqual((await capturingPlugins(root, await startConfig(root))).map((plugin) => plugin.name), ["crash-detector", "idle"]);
    await writeFile(join(root, CONFIG_FILE), JSON.stringify({ sources: { android: { package: "com.example" } }, plugins: [CRASH_DETECTOR_PLUGIN] }));
    assert.deepEqual((await capturingPlugins(root, await startConfig(root))).map((plugin) => plugin.name), ["crash-detector"]);
  });
});

test("plumbing defaults empty and rejects bad regex; parseConfig exposes it", () => {
  assert.deepEqual(parseConfig({}).plumbing, []);
  assert.deepEqual(parseConfig({ plumbing: ["bugbubble", "my-lib/"] }).plumbing, ["bugbubble", "my-lib/"]);
  assert.throws(() => parseConfig({ plumbing: "bugbubble" }), /plumbing must be a list/);
  assert.throws(() => parseConfig({ plumbing: [""] }), /non-empty string/);
  assert.throws(() => parseConfig({ plumbing: ["("] }), /not a valid regex/);
});
