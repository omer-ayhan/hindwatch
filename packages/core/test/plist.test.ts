import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodeXmlPlist, parseBinaryPlist, parsePlist, parseXmlPlist } from "@hindwatch/core";
import { OS_TRACE_LOG } from "./helpers.js";
import { test } from "./timed.js";

/** Every type a binary plist holds, written by plutil from an XML plist. */
const PLIST_TYPES = fileURLToPath(new URL("../../../fixtures/plist-types.bplist", import.meta.url));

const EVERY_TYPE = {
  ascii: "RequestSuccessful",
  unicode: "Über ü😀",
  empty: "",
  small: 7,
  wide: 1_099_511_627_776,
  negative: -42,
  real: 1793362313.701932,
  yes: true,
  no: false,
  data: Buffer.from([0, 1, 2, 0xff]),
  date: "2026-10-30T12:00:00.000Z",
  list: Array.from({ length: 17 }, (_, index) => index),
  nested: { a: ["x"], b: {} },
};

test("a binary plist written by plutil reads back with every type, counts past 15 included", async () => {
  assert.deepEqual(parseBinaryPlist(await readFile(PLIST_TYPES)), EVERY_TYPE);
});

test("os_trace_relay's real reply to StartActivity reads as its status", async () => {
  const recorded = await readFile(OS_TRACE_LOG);
  const reply = recorded.subarray(5, 5 + recorded.readUInt32BE(1));
  assert.deepEqual(parsePlist(reply), { Status: "RequestSuccessful" });
});

test("an XML plist round-trips, with what XML must escape", () => {
  const { date, ...value } = EVERY_TYPE;
  const tricky = { ...value, date, markup: "<a & b> 'q' \"d\"", "key <&>": "v" };
  const xml = encodeXmlPlist(tricky);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.deepEqual(parseXmlPlist(xml), tricky);
  assert.deepEqual(parsePlist(Buffer.from(xml)), tricky);
});

test("an XML plist as Apple writes it reads: indented, with empty elements, entities and wrapped data", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>DeviceList</key>
\t<array/>
\t<key>Empty</key>
\t<dict/>
\t<key>Name</key>
\t<string>Owner&#8217;s iPhone &amp; &#x1F600;</string>
\t<key>None</key>
\t<string/>
\t<key>Data</key>
\t<data>
\tAAEC
\t/w==
\t</data>
\t<key>Real</key>
\t<real>-1.5</real>
</dict>
</plist>
`;
  assert.deepEqual(parseXmlPlist(xml), { DeviceList: [], Empty: {}, Name: "Owner’s iPhone & 😀", None: "", Data: Buffer.from([0, 1, 2, 0xff]), Real: -1.5 });
});

test("what isn't a plist is refused, not read as one", () => {
  assert.throws(() => parseXmlPlist("<plist><dict><key>a</key>"), /not an XML plist: it ends early/);
  assert.throws(() => parseXmlPlist("<plist><dict><string>a</string></dict></plist>"), /not an XML plist: <string> where a dict key belongs/);
  assert.throws(() => parseXmlPlist("<plist><blob/></plist>"), /not an XML plist: unknown <blob>/);
  assert.throws(() => parseBinaryPlist(Buffer.from("bplist00")), /not a binary plist/);
  assert.throws(() => parseBinaryPlist(Buffer.alloc(64)), /not a binary plist/);
  const bplist = Buffer.from(readFileSync(PLIST_TYPES));
  const pastTheEnd = Buffer.from(bplist);
  pastTheEnd.writeBigUInt64BE(BigInt(bplist.length * 2), bplist.length - 8);
  assert.throws(() => parseBinaryPlist(pastTheEnd), /^Error: not a binary plist: /, "an offset table past the end");
  const wideOffsets = Buffer.from(bplist);
  wideOffsets[bplist.length - 32 + 6] = 16;
  assert.throws(() => parseBinaryPlist(wideOffsets), /binary plist integers of 16 bytes are not supported/);
});
