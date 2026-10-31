/** A property list value. Dates read as their ISO string. */
export type PlistValue = string | number | boolean | Buffer | readonly PlistValue[] | { readonly [key: string]: PlistValue };

const XML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const escapeXml = (text: string) => text.replace(/[&<>]/g, (char) => XML_ESCAPES[char]!);

function unescapeXml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? entity;
  });
}

function xmlValue(value: PlistValue): string {
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  if (Buffer.isBuffer(value)) return `<data>${value.toString("base64")}</data>`;
  if (Array.isArray(value)) return `<array>${value.map(xmlValue).join("")}</array>`;
  const entries = Object.entries(value as Record<string, PlistValue>);
  return `<dict>${entries.map(([key, item]) => `<key>${escapeXml(key)}</key>${xmlValue(item)}`).join("")}</dict>`;
}

export function encodeXmlPlist(value: PlistValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xmlValue(value)}</plist>\n`;
}

/** An XML plist's top value. Throws on anything else. */
export function parseXmlPlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)([\w]+)[^>]*?(\/?)>|<[?!][^>]*>|([^<]+)/g)].filter((token) => token[2] !== undefined || token[4] !== undefined);
  let at = 0;
  const fail = (why: string): never => {
    throw new Error(`not an XML plist: ${why}`);
  };
  const next = () => tokens[at++] ?? fail("it ends early");
  const skipText = () => {
    while (tokens[at]?.[4] !== undefined) at++;
  };
  const text = (tag: string) => {
    let content = "";
    for (let token = next(); token[2] !== tag || token[1] !== "/"; token = next()) content += token[4] ?? fail(`<${token[2]}> inside <${tag}>`);
    return unescapeXml(content);
  };
  const value = (): PlistValue => {
    skipText();
    const [, closing, tag, empty] = next();
    if (closing === "/") return fail(`unexpected </${tag}>`);
    switch (tag) {
      case "true":
      case "false":
        if (empty !== "/") text(tag!);
        return tag === "true";
      case "dict": {
        const dict: Record<string, PlistValue> = {};
        if (empty === "/") return dict;
        for (;;) {
          skipText();
          const [, close, keyTag] = next();
          if (close === "/" && keyTag === "dict") return dict;
          if (keyTag !== "key") return fail(`<${keyTag}> where a dict key belongs`);
          const key = text("key");
          dict[key] = value();
        }
      }
      case "array": {
        const array: PlistValue[] = [];
        if (empty === "/") return array;
        for (;;) {
          skipText();
          if (tokens[at]?.[1] === "/" && tokens[at]?.[2] === "array") {
            at++;
            return array;
          }
          array.push(value());
        }
      }
      case "string":
      case "date":
        return empty === "/" ? "" : text(tag);
      case "integer":
      case "real":
        return Number(text(tag));
      case "data":
        return Buffer.from(empty === "/" ? "" : text(tag).replace(/\s/g, ""), "base64");
      case "plist": {
        const top = value();
        skipText();
        return top;
      }
      default:
        return fail(`unknown <${tag}>`);
    }
  };
  return value();
}

const BINARY_MAGIC = "bplist00";
/** Seconds from the Unix epoch to Core Data's, which binary plist dates count from. */
const APPLE_EPOCH_S = 978_307_200;

/** A binary plist's top value. Throws on a truncated or unsupported one. */
export function parseBinaryPlist(bytes: Buffer): PlistValue {
  if (bytes.length < BINARY_MAGIC.length + 32 || bytes.toString("latin1", 0, BINARY_MAGIC.length) !== BINARY_MAGIC) {
    throw new Error("not a binary plist");
  }
  const trailer = bytes.subarray(bytes.length - 32);
  const offsetSize = trailer[6]!;
  const refSize = trailer[7]!;
  const objectCount = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTable = Number(trailer.readBigUInt64BE(24));
  const uint = (at: number, size: number) => {
    if (size === 8) return Number(bytes.readBigUInt64BE(at));
    if (size > 6) throw new Error(`binary plist integers of ${size} bytes are not supported`);
    return bytes.readUIntBE(at, size);
  };
  const offsetOf = (ref: number) => {
    if (ref >= objectCount) throw new Error(`binary plist object ${ref} is out of range`);
    return uint(offsetTable + ref * offsetSize, offsetSize);
  };
  const object = (ref: number, depth: number): PlistValue => {
    if (depth > objectCount) throw new Error("binary plist objects form a cycle");
    const at = offsetOf(ref);
    const marker = bytes[at]!;
    const [kind, info] = [marker >> 4, marker & 0x0f];
    // A count of 15 or more follows the marker as an integer object.
    const count = (): [number, number] => {
      if (info !== 0x0f) return [info, at + 1];
      const size = 1 << (bytes[at + 1]! & 0x0f);
      return [uint(at + 2, size), at + 2 + size];
    };
    switch (kind) {
      case 0x0:
        if (info === 0x08 || info === 0x09) return info === 0x09;
        throw new Error(`binary plist marker 0x${marker.toString(16)} is not supported`);
      case 0x1: {
        const size = 1 << info;
        return size === 8 ? Number(bytes.readBigInt64BE(at + 1)) : uint(at + 1, size);
      }
      case 0x2:
        return info === 2 ? bytes.readFloatBE(at + 1) : bytes.readDoubleBE(at + 1);
      case 0x3:
        return new Date((bytes.readDoubleBE(at + 1) + APPLE_EPOCH_S) * 1000).toISOString();
      case 0x4: {
        const [length, start] = count();
        return Buffer.from(bytes.subarray(start, start + length));
      }
      case 0x5: {
        const [length, start] = count();
        return bytes.toString("latin1", start, start + length);
      }
      case 0x6: {
        const [length, start] = count();
        return Buffer.from(bytes.subarray(start, start + length * 2)).swap16().toString("utf16le");
      }
      case 0xa: {
        const [length, start] = count();
        return Array.from({ length }, (_, index) => object(uint(start + index * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const [length, start] = count();
        const dict: Record<string, PlistValue> = {};
        for (let index = 0; index < length; index++) {
          const key = object(uint(start + index * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new Error("binary plist dict key is not a string");
          dict[key] = object(uint(start + (length + index) * refSize, refSize), depth + 1);
        }
        return dict;
      }
      default:
        throw new Error(`binary plist marker 0x${marker.toString(16)} is not supported`);
    }
  };
  try {
    return object(topObject, 0);
  } catch (error) {
    // Offsets and sizes that point past the data surface as RangeError or TypeError.
    if (error instanceof RangeError || error instanceof TypeError) throw new Error(`not a binary plist: ${error.message}`);
    throw error;
  }
}

/** Either kind of plist, told apart by the binary one's magic. */
export function parsePlist(bytes: Buffer): PlistValue {
  return bytes.toString("latin1", 0, BINARY_MAGIC.length) === BINARY_MAGIC ? parseBinaryPlist(bytes) : parseXmlPlist(bytes.toString("utf8"));
}
