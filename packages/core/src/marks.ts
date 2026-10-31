import { RpcError } from "./protocol.js";
import type { Query } from "./query.js";

/** A point in the arrival order: every event after `id` came in after the mark was set. */
export interface Mark {
  readonly name: string;
  readonly id: number;
  /** Host time the mark was set. */
  readonly ts: number;
}

/** Starts with a letter, so a mark name is never mistaken for a time. */
const MARK_NAME = /^[A-Za-z][\w.-]{0,63}$/;

export function isMarkName(value: string): boolean {
  return MARK_NAME.test(value);
}

/**
 * Marks per client id (gate 6), so two agents can both mark "fix". They live as long as the
 * daemon and its buffer, and are cut on arrival order, which an app reload doesn't touch.
 */
export class Marks {
  readonly #byClient = new Map<string, Map<string, Mark>>();

  /** Setting a name again moves it. */
  set(clientId: string, name: string, lastId: number, now = Date.now()): Mark {
    if (!isMarkName(name)) throw new RpcError(`mark names start with a letter and use letters, digits, _ . -: ${name}`);
    const mark: Mark = { name, id: lastId, ts: now };
    const marks = this.#byClient.get(clientId) ?? new Map<string, Mark>();
    marks.set(name, mark);
    this.#byClient.set(clientId, marks);
    return mark;
  }

  list(clientId: string): Mark[] {
    return [...(this.#byClient.get(clientId)?.values() ?? [])];
  }

  get(clientId: string, name: string): Mark {
    const mark = this.#byClient.get(clientId)?.get(name);
    if (mark === undefined) throw new RpcError(`no mark ${name} for client ${clientId}; set it with \`hindwatch mark ${name}\``);
    return mark;
  }

  /** Turns a query's mark names into the arrival-order window they stand for. */
  resolve(clientId: string, query: Query): Query {
    const { sinceMark, untilMark, ...rest } = query;
    const since = sinceMark === undefined ? undefined : this.get(clientId, sinceMark).id;
    const until = untilMark === undefined ? undefined : this.get(clientId, untilMark).id;
    return {
      ...rest,
      sinceId: since === undefined ? rest.sinceId : Math.max(since, rest.sinceId ?? 0),
      untilId: until === undefined ? rest.untilId : Math.min(until, rest.untilId ?? Infinity),
    };
  }
}
