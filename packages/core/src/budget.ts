/** Every response is held to a character budget on its compact JSON, so no tokenizer is needed. */
export const DEFAULT_BUDGET_CHARS = 8_000;
/** Below this an incident's header no longer fits with its title and trigger line. */
export const MIN_BUDGET_CHARS = 1_000;

export function budgetOf(requested: number | undefined): number {
  return Math.max(requested ?? DEFAULT_BUDGET_CHARS, MIN_BUDGET_CHARS);
}

export function sizeOf(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Cuts text so it and its marker take at most max characters as JSON. Always adds the marker. */
export function cutText(text: string, max: number, marker: (cut: number) => string): string {
  let keep = Math.max(0, Math.min(text.length, max - 2 - marker(text.length).length));
  // JSON escapes can make the kept part longer than its length, so shrink until it fits.
  while (keep > 0 && sizeOf(text.slice(0, keep) + marker(text.length - keep)) > max) keep = Math.floor(keep * 0.9);
  return text.slice(0, keep) + marker(text.length - keep);
}

/** Text as is if it fits in max characters (as JSON), else cut with a `…[+N chars]` marker. */
export function clipText(text: string, max: number): string {
  return sizeOf(text) <= max ? text : cutText(text, max, (cut) => `…[+${cut} chars]`);
}

/**
 * Takes items in order while the whole response built from them stays within budget. `build`
 * must be cheap to call twice; items are measured once each.
 */
export function fitPage<T, R>(items: readonly T[], budget: number, build: (page: readonly T[]) => R): { page: T[]; result: R } {
  const page: T[] = [];
  let used = sizeOf(build([]));
  for (const item of items) {
    const size = sizeOf(item) + 1;
    if (used + size > budget) break;
    page.push(item);
    used += size;
  }
  let result = build(page);
  // The envelope can grow once something is left out (a next cursor), so trim to be exact.
  while (page.length > 0 && sizeOf(result) > budget) {
    page.pop();
    result = build(page);
  }
  return { page, result };
}

/**
 * Like fitPage, but measures `sizeOf(build(page))` so compaction / hoisting in `build`
 * is what the budget sees — not the raw item size.
 *
 * Exponential probe + binary search (O(log n) builds) instead of one build per item.
 * Same page as the linear scan when size grows with prefix length while a next-cursor
 * is still present; the rare all-items size drop is handled the same (never skips past
 * the first over-budget prefix).
 */
export function fitByBuild<T, R>(items: readonly T[], budget: number, build: (page: readonly T[]) => R): { page: T[]; result: R } {
  let good = 0;
  let step = 1;
  while (good + step <= items.length && sizeOf(build(items.slice(0, good + step))) <= budget) {
    good += step;
    step *= 2;
  }
  let left = good + 1;
  let right = Math.min(good + step, items.length);
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (sizeOf(build(items.slice(0, mid))) <= budget) {
      good = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  const page = items.slice(0, good) as T[];
  let result = build(page);
  while (page.length > 0 && sizeOf(result) > budget) {
    page.pop();
    result = build(page);
  }
  return { page, result };
}

