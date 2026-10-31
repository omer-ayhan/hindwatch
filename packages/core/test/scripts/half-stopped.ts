/**
 * A daemon's stop cut short: records a child in the root's ledger, hands the ledger off, stops the
 * child and waits until its group is gone, then prints "ready" and never drains, so a kill -9 lands
 * after the children exited but before the hand-off file is deleted.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ChildLedger, daemonPaths, supervisedRunner } from "@hindwatch/core";

const [root, tag] = process.argv.slice(2);
if (root === undefined || tag === undefined) throw new Error("usage: half-stopped <root> <tag>");
const file = daemonPaths(root).children;
const ledger = new ChildLedger(file);
const abort = new AbortController();
let up!: () => void;
const streaming = supervisedRunner(ledger).stream("/bin/sh", ["-c", `echo up; exec sleep 300 # ${tag}`], () => up(), abort.signal);
await new Promise<void>((resolve) => (up = resolve));
let recorded: { pid: number }[] = [];
while (recorded.length === 0) {
  recorded = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
  await delay(10);
}

await ledger.handOff();
abort.abort();
await streaming;
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
while (recorded.some(({ pid }) => groupAlive(pid))) await delay(10);
process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
