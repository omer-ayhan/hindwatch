import assert from "node:assert/strict";
import {
  displayFile,
  isAppFrame,
  isLibraryFrame,
  isPlumbingFrame,
  framesInText,
  parseErrorStack,
  parseJvmStack,
  stripAnsi,
} from "@hindwatch/core";
import { test } from "./timed.js";

const BUNDLE =
  "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true&hot=false:375590:12";

test("parseErrorStack reads V8/Hermes at-lines and skips native / InternalBytecode", () => {
  const msg = [
    "Error: boom",
    "    at BillingError (" + BUNDLE.replace(":375590:12", "") + ":375590:12)",
    "    at refresh (src/api.ts:12:9)",
    "    at next (native)",
    "    at tryCallOne (address at InternalBytecode.js:1:1296)",
    "    at onPress (/app/src/Screen.tsx:42:19)",
  ].join("\n");
  const frames = parseErrorStack(msg);
  assert.deepEqual(
    frames.map((f) => [f.methodName, f.file.includes("entry.bundle"), f.lineNumber, f.column]),
    [
      ["BillingError", true, 375590, 12],
      ["refresh", false, 12, 9],
      ["onPress", false, 42, 19],
    ],
  );
});

test("framesInText keeps Java frames of the package a suffixed application id was made from, and no wider one", () => {
  const trace = [
    "java.lang.IllegalStateException: boom",
    "\tat com.example.app.MainActivity.onCreate(MainActivity.kt:12)",
    "\tat com.example.Shared.run(Shared.kt:3)",
    "\tat com.Root.run(Root.kt:1)",
  ].join("\n");
  assert.deepEqual(
    framesInText(trace, "com.example.app.debug").map((frame) => [frame.methodName, frame.collapse]),
    [
      ["com.example.app.MainActivity.onCreate", false],
      ["com.example.Shared.run", true],
      ["com.Root.run", true],
    ],
  );
});

test("parseJvmStack reads Java frames as Android logs them and skips Native Method frames", () => {
  const trace = [
    "FATAL EXCEPTION: main",
    "java.lang.IllegalStateException: boom",
    "\tat com.example.Screen.onCreate(Screen.kt:42)",
    "\tat android.app.ActivityThread.-$$Nest$mthrowRemoteServiceException(Unknown Source:0)",
    "\tat java.lang.reflect.Method.invoke(Native Method)",
    "Caused by: java.io.IOException: down",
    "\t... 12 more",
  ].join("\n");
  assert.deepEqual(parseJvmStack(trace), [
    { methodName: "com.example.Screen.onCreate", file: "Screen.kt", lineNumber: 42 },
    { methodName: "android.app.ActivityThread.-$$Nest$mthrowRemoteServiceException", file: "Unknown Source", lineNumber: 0 },
  ]);
  assert.deepEqual(parseErrorStack(trace), [], "the JS parser leaves Java frames alone");
});

test("framesInText collapses Java frames outside the app's package and reads JS stacks as they are", () => {
  const trace = "java.lang.IllegalStateException: boom\n\tat android.os.Handler.dispatchMessage(Handler.java:110)\n\tat com.example.Screen.onCreate(Screen.kt:42)";
  assert.deepEqual(
    framesInText(trace, "com.example").map((frame) => [frame.methodName, frame.collapse]),
    [["android.os.Handler.dispatchMessage", true], ["com.example.Screen.onCreate", false]],
  );
  assert.deepEqual(framesInText("Error: x\n    at f (src/a.ts:1:2)", "com.example").map((frame) => frame.file), ["src/a.ts"]);
});

test("isAppFrame skips collapsed, plumbing and node_modules library source; keeps Metro bundles", () => {
  assert.equal(isAppFrame({ file: "/app/src/A.tsx", collapse: false }), true);
  assert.equal(isAppFrame({ file: "/app/src/A.tsx", collapse: true }), false);
  assert.equal(
    isAppFrame({
      file: "/app/node_modules/react-native/Libraries/Core/ExceptionsManager.js",
      methodName: "reportException",
    }),
    false,
  );
  assert.equal(isPlumbingFrame({ file: "/x/node_modules/react-devtools-core/backend.js" }), true);
  assert.equal(isLibraryFrame({ file: "/app/node_modules/lodash/index.js" }), true);
  assert.equal(isLibraryFrame({ file: BUNDLE.replace(/:\d+:\d+$/, "") }), false);
  assert.equal(isAppFrame({ file: BUNDLE.replace(/:\d+:\d+$/, ""), methodName: "BillingError" }), true);
  assert.equal(isAppFrame({ file: "/app/node_modules/lodash/index.js" }), false);
});

test("stripAnsi removes Metro color codes; displayFile shortens bundle URLs", () => {
  assert.equal(stripAnsi("\u001b[31merr\u001b[0m at \u001b[36mfoo\u001b[0m"), "err at foo");
  assert.equal(displayFile(BUNDLE.replace(/:\d+:\d+$/, "")), "entry.bundle");
  assert.equal(displayFile("/app/src/Screen.tsx"), "/app/src/Screen.tsx");
});

test("Libraries/Core/console.js is plumbing; an app console.js is not; bugbubble needs config", () => {
  assert.equal(isPlumbingFrame({ file: "/app/node_modules/react-native/Libraries/Core/console.js" }), true);
  assert.equal(
    isPlumbingFrame({ file: "/app/node_modules/@react-native/js-polyfills/console.js" }),
    true,
  );
  assert.equal(
    isPlumbingFrame({
      file: "http://127.0.0.1:8081/node_modules/@react-native/js-polyfills/console.js",
      methodName: "methodName",
    }),
    true,
  );
  assert.equal(isAppFrame({ file: "/app/node_modules/@react-native/js-polyfills/console.js" }), false);
  assert.equal(isPlumbingFrame({ file: "/app/src/utils/console.js" }), false);
  assert.equal(isPlumbingFrame({ file: "/app/node_modules/bugbubble/index.js" }), false);
  assert.equal(isPlumbingFrame({ file: "/app/node_modules/bugbubble/index.js" }, ["bugbubble"]), true);
  assert.equal(isAppFrame({ file: "/app/src/utils/console.js" }), true);
  assert.equal(isAppFrame({ file: "/app/node_modules/bugbubble/index.js" }, ["bugbubble"]), false);
});

test("displayFile relativizes absolute paths under the project root", () => {
  assert.equal(displayFile("/Users/x/app/src/Screen.tsx", "/Users/x/app"), "src/Screen.tsx");
  assert.equal(displayFile("/Users/x/other/Screen.tsx", "/Users/x/app"), "/Users/x/other/Screen.tsx");
  assert.equal(displayFile("src/Screen.tsx", "/Users/x/app"), "src/Screen.tsx");
});

