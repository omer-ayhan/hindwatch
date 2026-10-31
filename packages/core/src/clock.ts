/** A device clock reading paired with the host time it was taken at. */
export interface ClockSample {
  readonly deviceTs: number;
  readonly hostTs: number;
}

/** Reads the device clock and pairs it with the midpoint of the host round trip. */
export async function sampleClock(
  readDeviceClock: () => Promise<number>,
  now: () => number = Date.now,
): Promise<ClockSample> {
  const before = now();
  const deviceTs = await readDeviceClock();
  const after = now();
  return { deviceTs, hostTs: before + (after - before) / 2 };
}

export interface NormalizedTime {
  readonly ts: number;
  readonly estimated: boolean;
}

/** Per-device offsets between each device clock and the host clock. */
export class Clocks {
  readonly #offsets = new Map<string, number>();

  setSample(deviceId: string, sample: ClockSample): void {
    this.#offsets.set(deviceId, sample.deviceTs - sample.hostTs);
  }

  /** Drops a device offset so later events use receipt time until a fresh sample arrives. */
  clearSample(deviceId: string): void {
    this.#offsets.delete(deviceId);
  }

  toHost(deviceId: string, deviceTs: number | undefined, hostTs: number): NormalizedTime {
    const offset = this.#offsets.get(deviceId);
    if (deviceTs === undefined || offset === undefined) return { ts: hostTs, estimated: true };
    return { ts: deviceTs - offset, estimated: false };
  }

  /**
   * Moves an offset onto another device id when the host aliases them. Keeps the destination's
   * sample if it already has one; drops the source either way so a stale raw id cannot win later.
   */
  rekey(from: string, to: string): void {
    if (from === to) return;
    const offset = this.#offsets.get(from);
    if (offset !== undefined && !this.#offsets.has(to)) this.#offsets.set(to, offset);
    this.#offsets.delete(from);
  }
}

export interface ClockTrackerDeps {
  readonly read: () => Promise<number>;
  readonly onSample: (sample: ClockSample) => void;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
}

/**
 * Keeps one device's offset fresh: measured on every (re)attach and then every intervalMs,
 * so drift over a long session can't skew ts. A failed reading keeps the last offset.
 */
export class ClockTracker {
  readonly #deps: ClockTrackerDeps;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ClockTrackerDeps) {
    this.#deps = deps;
  }

  /**
   * Measures now and restarts the periodic timer. Call on every attach.
   * Resolves true when the reading landed; false when it failed (last offset kept unless cleared).
   */
  async resample(): Promise<boolean> {
    this.stop();
    this.#timer = setInterval(() => void this.#measure(), this.#deps.intervalMs);
    this.#timer.unref();
    return this.#measure();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #measure(): Promise<boolean> {
    try {
      this.#deps.onSample(await sampleClock(this.#deps.read));
      return true;
    } catch (error) {
      this.#deps.onError(error);
      return false;
    }
  }
}
