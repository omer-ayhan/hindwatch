import { PLUGIN_API_VERSION } from "hindwatch";

/**
 * A detector-only plugin: raises a "crash" incident for every event marked as an uncaught exception.
 * @type {import("hindwatch").PluginFactory}
 */
export default function createCrashDetectorPlugin() {
  return {
    name: "crash-detector",
    apiVersion: PLUGIN_API_VERSION,
    sources: [],
    detectors: [
      {
        name: "crash",
        detect: (event) => (event.attrs.exception === true ? { kind: "crash", title: event.msg.split("\n", 1)[0] ?? "" } : undefined),
      },
    ],
  };
}
