import { PLUGIN_API_VERSION, type PluginFactory } from "@hindwatch/core";

/** The toy feature plugin: an Enricher that prefixes ios-sim messages with their log category. */
const createIosCategoryPlugin: PluginFactory = () => ({
  name: "ios-category",
  apiVersion: PLUGIN_API_VERSION,
  sources: [],
  enrichers: [
    {
      name: "ios-category",
      enrich: (event) =>
        event.source === "ios-sim" && typeof event.attrs.category === "string" && event.attrs.category !== ""
          ? { msg: `[${event.attrs.category}] ${event.msg}` }
          : undefined,
    },
  ],
});

export default createIosCategoryPlugin;
