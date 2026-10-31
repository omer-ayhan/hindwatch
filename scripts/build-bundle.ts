/**
 * Builds the publishable `hindwatch` package: core and the react-native plugin, compiled by tsc
 * into packages/hindwatch/dist with the source tree's layout. The plugin's `@hindwatch/core`
 * imports become relative, so the package needs nothing from npm beyond its dependencies. The
 * build fails if any other bare import is left, or if the CLI's static imports reach the MCP SDK,
 * which only `hindwatch mcp` may load. Declarations are kept only for what the plugin contract
 * entry, core/src/plugin-api, needs.
 */
import { execFileSync } from "node:child_process";
import { chmod, copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = join(repo, "packages/hindwatch");
const dist = join(pkg, "dist");
const cli = join(dist, "core/src/cli.js");
const coreIndex = join(dist, "core/src/index.js");
const apiTypes = join(dist, "core/src/plugin-api.d.ts");
const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  repository: { url: string };
};
const MCP_ONLY = ["@modelcontextprotocol/server", "zod"];

// Static `import … from` / `export … from` and bare `import "x"`; `import("x")` is matched apart.
const STATIC = /^\s*(?:import|export)\s(?:[^"']*?\sfrom\s)?["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

async function filesEndingIn(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => join(entry.parentPath, entry.name));
}
const jsFiles = (dir: string) => filesEndingIn(dir, ".js");

function specifiers(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

await rm(dist, { recursive: true, force: true });
execFileSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", join(pkg, "tsconfig.json")], { stdio: "inherit" });

const problems: string[] = [];

// Declarations the contract entry reaches stay; the rest would only advertise internals.
const typesKept = new Set<string>();
const typesQueue = [apiTypes];
for (let file = typesQueue.shift(); file !== undefined; file = typesQueue.shift()) {
  if (typesKept.has(file)) continue;
  typesKept.add(file);
  for (const specifier of [...specifiers(await readFile(file, "utf8"), STATIC), ...specifiers(await readFile(file, "utf8"), DYNAMIC)]) {
    if (specifier.startsWith(".")) typesQueue.push(resolve(dirname(file), specifier).replace(/\.js$/, ".d.ts"));
    else if (!specifier.startsWith("node:")) problems.push(`${relative(dist, file)} imports ${specifier}; the contract's types must not reach a package`);
  }
}
for (const file of await filesEndingIn(dist, ".d.ts")) if (!typesKept.has(file)) await rm(file);

for (const file of await jsFiles(dist)) {
  let text = await readFile(file, "utf8");
  const toCore = relative(dirname(file), coreIndex);
  text = text.replace(/(["'])@hindwatch\/core\1/g, JSON.stringify(toCore.startsWith(".") ? toCore : `./${toCore}`));
  await writeFile(file, text);
  for (const specifier of [...specifiers(text, STATIC), ...specifiers(text, DYNAMIC)]) {
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    if (!Object.hasOwn(manifest.dependencies, packageOf(specifier))) problems.push(`${relative(dist, file)} imports ${specifier}, which the package doesn't depend on`);
  }
}

// Walk the CLI's static imports: anything reachable loads in every command, the daemon included.
const seen = new Set<string>();
const queue = [cli];
for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
  if (seen.has(file)) continue;
  seen.add(file);
  for (const specifier of specifiers(await readFile(file, "utf8"), STATIC)) {
    if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    else if (MCP_ONLY.includes(packageOf(specifier))) problems.push(`${relative(dist, file)} statically imports ${specifier}, so every command would load it`);
  }
}
if (seen.has(join(dist, "core/src/mcp.js"))) problems.push("core/src/mcp.js is statically reachable from the CLI");

if (problems.length > 0) {
  console.error(`build-bundle: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
// The source reads the version from the manifest; the built package keeps it as a literal.
await writeFile(join(dist, "core/src/version.js"), `export const HINDWATCH_VERSION = ${JSON.stringify(manifest.version)};\n`);
await chmod(cli, 0o755);
await copyFile(join(repo, "LICENSE"), join(pkg, "LICENSE"));

// npm renders the README outside the repo, so relative links and images point at GitHub instead.
// HEAD resolves to the default branch on both hosts, so no branch name is baked in.
const { pathname: slug } = new URL(manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
const absolute = (path: string, image: boolean) =>
  /^(?:[a-z]+:|#|\/\/)/i.test(path)
    ? path
    : new URL(`${slug}/${image ? "" : "blob/"}HEAD/${path.replace(/^\.\//, "")}`, image ? "https://raw.githubusercontent.com" : "https://github.com").href;
const readme = (await readFile(join(repo, "README.md"), "utf8"))
  .replace(/\b(src|srcset)="([^"]+)"/g, (_m, attr: string, path: string) => `${attr}="${absolute(path, true)}"`)
  .replace(/\bhref="([^"]+)"/g, (_m, path: string) => `href="${absolute(path, false)}"`)
  .replace(/(!?)\]\(([^)\s]+)\)/g, (_m, bang: string, path: string) => `${bang}](${absolute(path, bang === "!")})`);
await writeFile(join(pkg, "README.md"), readme);
console.error(
  `build-bundle: ${(await jsFiles(dist)).length} files in ${relative(repo, dist)}, ${seen.size} statically loaded by the CLI, none of them the MCP SDK; ${typesKept.size} declaration files for the plugin contract`,
);
