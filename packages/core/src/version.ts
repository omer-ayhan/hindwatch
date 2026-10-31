import { readFileSync } from "node:fs";

/**
 * Package identity shared by status, doctor and MCP: the published package's version. The npm
 * build writes it in as a literal, since the package's manifest isn't next to the built file.
 */
export const HINDWATCH_VERSION: string = (JSON.parse(readFileSync(new URL("../../hindwatch/package.json", import.meta.url), "utf8")) as { version: string }).version;
