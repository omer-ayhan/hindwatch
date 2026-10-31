import { BUILTIN_SOURCE_NAMES } from "./config.js";

/**
 * One canonical deviceId per app session for the RN ↔ native pair. Metro's logicalDeviceId and
 * the simulator UDID (or adb serial) are different strings for the same phone; the host rewrites
 * the later one onto the preferred id so a session never carries two device ids.
 *
 * Native (simulator UDID / adb serial) wins over Metro's logical id, including when Metro emitted
 * first — agents get a stable id across daemon restarts that begin with either source.
 *
 * Only `react-native` pairs with the built-in native sources. Other sources (fixtures, probes) never
 * merge, so two real devices that share an app id stay distinct.
 */
export class DeviceIdentity {
  readonly #byApp = new Map<string, { canonical: string; kind: "native" | "rn" }>();
  /** Raw id → canonical. Used for clock samples, which arrive without an app. */
  readonly #alias = new Map<string, string>();

  /** Remap a raw device id when an alias is already known; otherwise leave it alone. */
  remap(deviceId: string): string {
    return this.#alias.get(deviceId) ?? deviceId;
  }

  /**
   * Bind a reported (app, deviceId, source) onto the app's canonical id when this emission is the
   * RN ↔ native pair. Native UDID/serial is preferred; when native joins after RN, the canonical
   * flips and `aliasedFrom` is the previous (Metro) id so the host can move clock offsets.
   */
  bind(
    app: string,
    deviceId: string,
    source: string,
  ): { readonly canonical: string; readonly aliasedFrom?: string } {
    const kind = sourceKind(source);
    if (kind === "other") return { canonical: this.remap(deviceId) };

    const state = this.#byApp.get(app);
    if (state === undefined) {
      this.#byApp.set(app, { canonical: deviceId, kind });
      this.#alias.set(deviceId, deviceId);
      return { canonical: deviceId };
    }
    if (deviceId === state.canonical || this.#alias.get(deviceId) === state.canonical) {
      return { canonical: state.canonical };
    }
    const pairs =
      (state.kind === "native" && kind === "rn") || (state.kind === "rn" && kind === "native");
    if (!pairs) return { canonical: deviceId };

    // Prefer native: if RN was first, flip canonical onto the UDID/serial.
    if (state.kind === "rn" && kind === "native") {
      const previous = state.canonical;
      state.canonical = deviceId;
      state.kind = "native";
      for (const [raw, canon] of this.#alias) {
        if (canon === previous) this.#alias.set(raw, deviceId);
      }
      this.#alias.set(previous, deviceId);
      this.#alias.set(deviceId, deviceId);
      return { canonical: deviceId, aliasedFrom: previous };
    }

    this.#alias.set(deviceId, state.canonical);
    return { canonical: state.canonical, aliasedFrom: deviceId };
  }
}

function sourceKind(source: string): "native" | "rn" | "other" {
  if ((BUILTIN_SOURCE_NAMES as readonly string[]).includes(source)) return "native";
  if (source === "react-native") return "rn";
  return "other";
}
