export { EventBuffer, type BufferLimits, type EvictedUpTo } from "./buffer.js";
export { ClockTracker, Clocks, sampleClock, type ClockSample, type ClockTrackerDeps, type NormalizedTime } from "./clock.js";
export {
  attach,
  call,
  cliClientId,
  ensureDaemon,
  status,
  DaemonExitedError,
  DaemonNotRunningError,
  DEFAULT_CLIENT,
  SocketCollisionError,
} from "./client.js";
export { checkRuntimeDir, daemonPaths, ensureRuntimeDir, resolveRoot, runtimeDir, socketPath } from "./paths.js";
export { adbCandidates, defaultAdbLookup, resolveAdb, type AdbCandidate, type AdbLookup } from "./adb-path.js";
export {
  askAdbServer,
  runProgram,
  defaultDoctorDeps,
  runDoctor,
  DEFAULT_METRO_PORT,
  MIN_NODE_MAJOR,
  type DoctorCheck,
  type DoctorDeps,
  type DoctorReport,
} from "./doctor.js";
export {
  CONFIG_FILE,
  DEFAULT_LOG_TIME_SPAN_MS,
  DEFAULT_MUTED_BUFFER,
  REACT_NATIVE_PLUGIN,
  detectProject,
  loadConfig,
  loadPlugin,
  NotStartableError,
  PackageJsonError,
  parseConfig,
  startConfig,
  capturingPlugins,
  type Config,
  type PluginRef,
  type ProjectKind,
  type ZeroConfig,
  type SourcesConfig,
} from "./config.js";
export {
  PluginHost,
  IncompatiblePluginError,
  DEFAULT_SILENT_AFTER_MS,
  type PluginHostDeps,
  type SourceActivity,
} from "./host.js";
export { DeviceIdentity } from "./device-identity.js";
export { IncidentStore, type IncidentRecord } from "./incidents.js";
export {
  displayFile,
  isAppFrame,
  isLibraryFrame,
  isMetroBundle,
  isPlumbingFrame,
  framesInText,
  parseErrorStack,
  parseJvmStack,
  stripAnsi,
  type ParsedFrame,
} from "./stack.js";
export {
  CONTEXT_WINDOW_MS,
  INCIDENT_PARTS,
  incidentDetail,
  incidentPart,
  isIncidentPart,
  listIncidents,
  type IncidentDetail,
  type IncidentList,
  type IncidentPart,
} from "./incident-view.js";
export { Ingest, MAX_MSG_CHARS, type EventPatch, type RedactedEvent } from "./ingest.js";
export {
  PLUGIN_API_VERSION,
  type Detector,
  type Enricher,
  type Incident,
  type PluginFactory,
  type PluginManifest,
  type Source,
  type SourceContext,
  type SourceHealth,
} from "./plugin.js";
export { CLIENTS_ATTACHED, RpcError, type DaemonStatus, type RpcNotice } from "./protocol.js";
export { DEFAULT_BUDGET_CHARS, MIN_BUDGET_CHARS } from "./budget.js";
export { evictedGap, type Gap } from "./gaps.js";
export { streamExport, type ExportEnd } from "./export.js";
export { describeGap, textLine, EXPORT_FORMATS, INVALID_PATH, type ExportFormat } from "./export-file.js";
export { DEFAULT_WAIT_MS, eventsForQuery, expectEvents, mayLandInWindow, waitFor, waitResult, type Expectation, type ExpectResult, type WaitResult } from "./verify.js";
export { Marks, isMarkName, type Mark } from "./marks.js";
export { matches, parseQuery, resolveStale, runPatternQuery, runQuery, type EventFilter, type MuteFilter, type MuteTarget, type PatternResult, type Query, type QueryResult } from "./query.js";
export {
  compactAttrs,
  compactQueryPage,
  formatCompactFrame,
  shortenBundlesInText,
  toCompactEvent,
  type CompactDisplay,
  type CompactEvent,
  type QueryEnvelope,
} from "./compact-event.js";
export { collapse, patternId, templateOf, type Pattern } from "./patterns.js";
export { NOISE_FILE, MUTE_REFRESH_MS, NoiseFile, ruleId, parseNoise, type NoiseRule } from "./noise.js";
export { ChildLedger } from "./children.js";
export { CappedLog, MAX_LOG_BYTES, pruneStaleLogs, rotateIfFull, STALE_LOG_MS } from "./log-file.js";
export { SUPERVISOR_NAME, supervisedRunner, type ProcessRunner } from "./proc.js";
export {
  androidSource,
  nextPollMs,
  parseDeviceDate,
  ANR_BUFFER,
  ANR_PREFIX,
  ANR_TAG,
  isAnrReport,
  type AndroidDeps,
  type AndroidOptions,
} from "./sources/android.js";
export { parseLogcatEntries, type LogcatEntry } from "./sources/logcat.js";
export { APPLE_SOURCES, IOS_MIN_LEVEL, crashMessage, isAppleSource, parseCrashReport, streamLevelFor, type AppleSource, type CrashReport } from "./sources/apple.js";
export { bootedUdid, iosSimSource, parseSimLogLine, type IosSimDeps, type IosSimOptions, type SimLogLine } from "./sources/ios-sim.js";
export { crashReportFiles, iosSource, pickDevice, type IosDeps, type IosOptions } from "./sources/ios.js";
export { decodeTraceEntry, startActivityRequest, TraceFrames, type TraceEntry } from "./sources/os-trace.js";
export { encodeXmlPlist, parseBinaryPlist, parsePlist, parseXmlPlist, type PlistValue } from "./sources/plist.js";
export { ByteReader, DeviceError, listDevices, Lockdown, muxFrame, plistFrame, readPairRecord, RefusedError, USB, type MuxDevice, type PairRecord } from "./sources/usbmux.js";
export { Redactor, DEFAULT_RULES, luhnOk, type RedactionRule } from "./redact.js";
export { LEVELS, SCHEMA_VERSION, parseRawEvent, type DebugEvent, type Level, type RawEvent } from "./schema.js";

export { HINDWATCH_VERSION } from "./version.js";
export { nativeCrashDetector } from "./native-crash.js";
