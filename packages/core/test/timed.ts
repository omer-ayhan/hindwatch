import { test as nodeTest, type TestContext } from "node:test";

/** About ten times the slowest test, so only a hang reaches it. */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * node:test with a per-test timeout. Node's --test-timeout only times a whole file, so a hang
 * would fail as the file instead of the test; this names the test.
 */
export function test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void> {
  return nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}
