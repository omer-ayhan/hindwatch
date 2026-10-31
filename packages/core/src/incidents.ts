import { clipText } from "./budget.js";
import { templateOf } from "./patterns.js";
import type { DebugEvent } from "./schema.js";

const MAX_TITLE_CHARS = 200;
const DEFAULT_MAX_INCIDENTS = 500;

export interface IncidentRecord {
  /** Sequential from 1. What `hindwatch incident <id>` and `incident://<id>` take. */
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly detector: string;
  /** The first event that raised it. Kept here, so the incident outlives its trigger's eviction. */
  readonly trigger: DebugEvent;
  /** Times the same incident was raised again in the same session (a crash loop, a re-render). */
  count: number;
  lastTs: number;
  lastTriggerId: number;
}

export interface Raised {
  readonly record: IncidentRecord;
  readonly isNew: boolean;
}

/** Incidents by id. The same kind and title in the same session fold into one, with a count. */
export class IncidentStore {
  readonly #records: IncidentRecord[] = [];
  readonly #byKey = new Map<string, IncidentRecord>();
  readonly #max: number;
  readonly #listeners = new Set<(raised: Raised) => void>();
  #nextId = 1;

  constructor(max = DEFAULT_MAX_INCIDENTS) {
    this.#max = max;
  }

  /** Title, kind and detector must already be redacted. */
  raise(detector: string, kind: string, title: string, trigger: DebugEvent): Raised {
    const key = `${trigger.sessionId}\u0000${kind}\u0000${templateOf(title)}`;
    const known = this.#byKey.get(key);
    if (known !== undefined) {
      known.count++;
      known.lastTs = Math.max(known.lastTs, trigger.ts);
      known.lastTriggerId = trigger.id;
      return this.#tell({ record: known, isNew: false });
    }
    const record: IncidentRecord = {
      id: this.#nextId++,
      kind,
      title: clipText(title, MAX_TITLE_CHARS),
      detector,
      trigger,
      count: 1,
      lastTs: trigger.ts,
      lastTriggerId: trigger.id,
    };
    this.#records.push(record);
    this.#byKey.set(key, record);
    if (this.#records.length > this.#max) {
      const evicted = this.#records.shift()!;
      for (const [k, r] of this.#byKey) if (r === evicted) this.#byKey.delete(k);
    }
    return this.#tell({ record, isNew: true });
  }

  /** Calls listener after every raise, new or repeated. Returns the unsubscribe. */
  onRaised(listener: (raised: Raised) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #tell(raised: Raised): Raised {
    for (const listener of this.#listeners) listener(raised);
    return raised;
  }

  get(id: number): IncidentRecord | undefined {
    return this.#records.find((record) => record.id === id);
  }

  list(): readonly IncidentRecord[] {
    return this.#records;
  }
}
