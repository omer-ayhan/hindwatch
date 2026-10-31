import type { Detector } from "@hindwatch/core";

const UNHANDLED_REJECTION = /possible unhandled promise rejection|uncaught \(in promise/i;
const MAX_TITLE_CHARS = 200;

function title(msg: string): string {
  return (msg.split("\n", 1)[0] ?? "").slice(0, MAX_TITLE_CHARS);
}

/**
 * Raises "redbox" for an uncaught JS exception and "unhandled-rejection" for React Native's
 * rejection warnings. Deliberately minimal until the M3 incident engine.
 */
export const redboxDetector: Detector = {
  name: "redbox",
  detect(event) {
    if (event.source !== "react-native") return undefined;
    if (UNHANDLED_REJECTION.test(event.msg)) return { kind: "unhandled-rejection", title: title(event.msg) };
    if (event.attrs.exception === true) return { kind: "redbox", title: title(event.msg) };
    return undefined;
  },
};
