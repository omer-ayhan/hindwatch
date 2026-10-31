---
name: hindwatch
description: Opt-in Hindwatch MCP workflows for React Native / mobile crash debug and fix verification. Load when using Hindwatch tools; not always-apply.
---

# Hindwatch agent workflows

Server `instructions` stay short (mark → repro → expect). This file holds the longer playbooks.

## Orientation

- Crash / red screen / ANR → `incidents`, then `incident`. Do not start with unfiltered `logs`.
- Noisy window overview → `patterns` (same filters as logs). Drill one pattern with `logs` + `pattern`, or `mute` it.
- "What just happened?" → `logs` with `order: "desc"` and a narrow filter (mark / level / text). Never page the whole buffer.
- Answers are compact JSON under a char budget. Pass a result's `next` as `cursor`. Missing `next` means no further page (MCP omits nulls).

## Verify a fix

1. `mark` with a name (e.g. `fix`).
2. Ask the user to reproduce; wait until they confirm (or `wait_for` for a known success/error line).
3. `expect` with `since` set to that mark: `absent` for the error text, or `present` for a success log.
4. Optionally `incidents` with `sinceId` from before the repro to catch a new crash.

Muted events do not count toward `matched` / `ok` unless `includeMuted`. The `muted` count still shows how many matches noise hid; `absent` with `muted > 0` adds a `warning` so a silent false-pass is visible. A failed expect is a tool error that still carries the matches.

## Debug a crash the user can reproduce

1. `incidents` — note `lastId`. `mark` name `repro`.
2. User reproduces (or `wait_for` level error since `repro`).
3. `incidents` with `sinceId: lastId`, then `incident` on the new id. Use `part` only for names in `omittedParts`.
4. If no incident: `patterns` and filtered `logs` since `repro`, level warn+.
5. Explain from trigger, stack, and code frame.

## Mute noise

- Prefer `patternId` / `patternIds` from `patterns`, or iOS `subsystem` with `category` (category alone is refused).
- Mutes drop at ingest; only the last ~2k muted events are recoverable via `includeMuted`.
- `mute` returns only what that call muted; list all rules with `noise`; undo with `unmute` + rule id.

## Filters worth remembering

- `since` / `until`: mark name, epoch ms, or ISO time.
- `stale: false` = live only (ts at/after daemon start); `stale: true` = pre-start replay only.
- `sinceLast`: only events this session has not read (asc only; reject with `order: "desc"`).
- `export` when the user wants a file to share — not for on-screen debugging.
