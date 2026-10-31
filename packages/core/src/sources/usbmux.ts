import { X509Certificate } from "node:crypto";
import { addAbortListener, once } from "node:events";
import { connect as connectSocket, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { Duplex } from "node:stream";
import { isErrnoException, isPlainObject } from "../util.js";
import { encodeXmlPlist, parsePlist, type PlistValue } from "./plist.js";

/** Where macOS's usbmuxd listens: it lists attached iOS devices and tunnels to their ports. */
export const USBMUXD_SOCKET = "/var/run/usbmuxd";
/** lockdownd's port on the device, which starts every other service. */
const LOCKDOWN_PORT = 62078;
const MUX_HEADER = 16;
const MUX_VERSION = 1;
const MUX_PLIST = 8;
const LABEL = "hindwatch";

/** How usbmuxd names an attachment by cable. */
export const USB = "USB";

/** A problem with the iPhone or its pairing that the user fixes; fact says what, fix says how. */
export class DeviceError extends Error {
  constructor(
    readonly fact: string,
    readonly fix: string,
  ) {
    super(`${fact}: ${fix}`);
  }
}

/** lockdownd, or a service it started, answering a request with an error code. */
export class RefusedError extends Error {
  constructor(
    readonly peer: string,
    readonly request: string,
    readonly code: string,
  ) {
    super(`${peer} refused ${request}: ${code}`);
  }
}

/** usbmuxd's Result numbers. */
const MUX_RESULTS: Readonly<Record<number, string>> = {
  1: "bad command",
  2: "no such device",
  3: "the device refused the connection",
  6: "bad protocol version",
};

/** Reads exactly the bytes asked for from a stream, failing when it ends first. */
export class ByteReader {
  #buffered: Buffer = Buffer.alloc(0);
  #wanted: { readonly size: number; readonly resolve: (bytes: Buffer) => void; readonly reject: (error: Error) => void } | undefined;
  #ended: Error | undefined;
  readonly #stream: Duplex;
  readonly #onData = (chunk: Buffer) => {
    this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
    this.#settle();
  };
  readonly #onEnd = (error?: Error) => {
    this.#ended ??= error ?? new Error("the connection closed");
    this.#settle();
  };
  readonly #onClose = () => this.#onEnd();

  constructor(stream: Duplex) {
    this.#stream = stream;
    stream.on("data", this.#onData).on("error", this.#onEnd).on("close", this.#onClose).resume();
  }

  read(size: number): Promise<Buffer> {
    if (this.#wanted !== undefined) throw new Error("one read at a time");
    return new Promise((resolve, reject) => {
      this.#wanted = { size, resolve, reject };
      this.#settle();
    });
  }

  /** Stops reading and hands the stream back paused, with nothing read past what was asked for. */
  release(): Duplex {
    if (this.#buffered.length > 0) throw new Error(`${this.#buffered.length} unread bytes would be lost`);
    this.#stream.pause().off("data", this.#onData).off("error", this.#onEnd).off("close", this.#onClose);
    return this.#stream;
  }

  #settle(): void {
    const wanted = this.#wanted;
    if (wanted === undefined) return;
    if (this.#buffered.length >= wanted.size) {
      this.#wanted = undefined;
      const bytes = this.#buffered.subarray(0, wanted.size);
      this.#buffered = this.#buffered.subarray(wanted.size);
      wanted.resolve(bytes);
    } else if (this.#ended !== undefined) {
      this.#wanted = undefined;
      wanted.reject(this.#ended);
    }
  }
}

export interface MuxDevice {
  /** usbmuxd's id for this attachment, which Connect takes. */
  readonly id: number;
  readonly udid: string;
  /** "USB" or "Network". */
  readonly connection: string;
}

/** What the Mac keeps from pairing with a device: the identity it signs in with, and the device's certificate. */
export interface PairRecord {
  readonly hostId: string;
  readonly systemBuid: string;
  readonly hostCertificate: Buffer;
  readonly hostPrivateKey: Buffer;
  readonly deviceCertificate: Buffer;
}

function field<T>(record: PlistValue, key: string, check: (value: unknown) => value is T, what: string): T {
  const value = isPlainObject(record) ? (record as Record<string, unknown>)[key] : undefined;
  if (!check(value)) throw new Error(`${what} has no ${key}`);
  return value;
}
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isBuffer = (value: unknown): value is Buffer => Buffer.isBuffer(value);

/** lockdownd and the services it starts frame each message as a big-endian length, then an XML plist. */
export function plistFrame(message: Record<string, PlistValue>): Buffer {
  const body = Buffer.from(encodeXmlPlist(message));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** One usbmuxd message: its header (total length, protocol version, plist type, tag), then an XML plist. */
export function muxFrame(message: Record<string, PlistValue>): Buffer {
  const body = Buffer.from(encodeXmlPlist(message));
  const header = Buffer.alloc(MUX_HEADER);
  header.writeUInt32LE(MUX_HEADER + body.length, 0);
  header.writeUInt32LE(MUX_VERSION, 4);
  header.writeUInt32LE(MUX_PLIST, 8);
  header.writeUInt32LE(1, 12);
  return Buffer.concat([header, body]);
}

/** A usbmuxd connection, destroyed on abort for as long as it is open. */
async function connectMux(socketPath: string, signal: AbortSignal): Promise<Socket> {
  const socket = connectSocket({ path: socketPath });
  const unlisten = addAbortListener(signal, () => socket.destroy(signal.reason as Error));
  socket.once("close", () => unlisten[Symbol.dispose]());
  try {
    await once(socket, "connect", { signal });
    return socket;
  } catch (error) {
    socket.destroy();
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
      throw new DeviceError(`usbmuxd is not running: nothing listens on ${socketPath}`, "restart it with sudo launchctl kickstart -k system/com.apple.usbmuxd");
    }
    throw error;
  }
}

/** One request to usbmuxd, on its own connection; a Connect leaves that connection tunnelled to the device. */
async function muxRequest(socketPath: string, message: Record<string, PlistValue>, signal: AbortSignal): Promise<{ reply: PlistValue; socket: Socket; reader: ByteReader }> {
  const socket = await connectMux(socketPath, signal);
  try {
    const reader = new ByteReader(socket);
    socket.write(muxFrame({ MessageType: message.MessageType!, ClientVersionString: LABEL, ProgName: LABEL, kLibUSBMuxVersion: 3, ...message }));
    const header = await reader.read(MUX_HEADER);
    const length = header.readUInt32LE(0);
    if (length < MUX_HEADER || header.readUInt32LE(8) !== MUX_PLIST) throw new Error("usbmuxd sent a reply that isn't a plist message");
    return { reply: parsePlist(await reader.read(length - MUX_HEADER)), socket, reader };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function checkResult(reply: PlistValue, what: string): void {
  const result = isPlainObject(reply) ? (reply as Record<string, unknown>).Number : undefined;
  if (result !== undefined && result !== 0) throw new Error(`usbmuxd ${what} failed: ${MUX_RESULTS[result as number] ?? `result ${String(result)}`}`);
}

/** The devices usbmuxd has attached, one per udid, by USB where a device is on both USB and the network. */
export async function listDevices(socketPath: string, signal: AbortSignal): Promise<MuxDevice[]> {
  const { reply, socket } = await muxRequest(socketPath, { MessageType: "ListDevices" }, signal);
  socket.destroy();
  const byUdid = new Map<string, MuxDevice>();
  for (const entry of field(reply, "DeviceList", Array.isArray, "usbmuxd's device list") as PlistValue[]) {
    const properties = field(entry, "Properties", isPlainObject, "a usbmuxd device");
    const device = {
      id: field(entry, "DeviceID", isNumber, "a usbmuxd device"),
      udid: field(properties as PlistValue, "SerialNumber", isString, "a usbmuxd device"),
      connection: field(properties as PlistValue, "ConnectionType", isString, "a usbmuxd device"),
    };
    if (!byUdid.has(device.udid) || device.connection === USB) byUdid.set(device.udid, device);
  }
  return [...byUdid.values()];
}

export async function readPairRecord(socketPath: string, udid: string, signal: AbortSignal): Promise<PairRecord> {
  const { reply, socket } = await muxRequest(socketPath, { MessageType: "ReadPairRecord", PairRecordID: udid }, signal);
  socket.destroy();
  const data = isPlainObject(reply) ? (reply as Record<string, unknown>).PairRecordData : undefined;
  if (!Buffer.isBuffer(data)) throw new DeviceError(`${udid} is not paired with this Mac`, "unlock it and tap Trust");
  const record = parsePlist(data);
  const what = `the pair record for ${udid}`;
  return {
    hostId: field(record, "HostID", isString, what),
    systemBuid: field(record, "SystemBUID", isString, what),
    hostCertificate: field(record, "HostCertificate", isBuffer, what),
    hostPrivateKey: field(record, "HostPrivateKey", isBuffer, what),
    deviceCertificate: field(record, "DeviceCertificate", isBuffer, what),
  };
}

/** A connection to a port on the device, through usbmuxd. */
async function connectPort(socketPath: string, device: MuxDevice, port: number, signal: AbortSignal): Promise<Duplex> {
  // usbmuxd takes the port in network byte order.
  const portNumber = ((port & 0xff) << 8) | (port >> 8);
  const { reply, socket, reader } = await muxRequest(socketPath, { MessageType: "Connect", DeviceID: device.id, PortNumber: portNumber }, signal);
  try {
    checkResult(reply, `connect to port ${port}`);
    return reader.release();
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Signs in to the device with the Mac's pairing identity, and checks it is the paired device by its
 * certificate. Device certificates name no host and chain to the pairing's own root, so the
 * certificate itself is pinned instead of verifying a chain.
 */
async function secure(stream: Duplex, record: PairRecord, signal: AbortSignal): Promise<Duplex> {
  const socket = connectTls({ socket: stream, cert: record.hostCertificate, key: record.hostPrivateKey, rejectUnauthorized: false });
  try {
    await once(socket, "secureConnect", { signal });
    if (!socket.getPeerCertificate().raw?.equals(new X509Certificate(record.deviceCertificate).raw)) throw new Error("the device's certificate is not the one it paired with");
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Requests and replies in {@link plistFrame}s, one at a time: a reply is matched to its request by order. */
class PlistChannel {
  readonly #reader: ByteReader;
  #last: Promise<unknown> = Promise.resolve();

  constructor(
    readonly stream: Duplex,
    readonly peer: string,
  ) {
    this.#reader = new ByteReader(stream);
  }

  request(message: Record<string, PlistValue>): Promise<Record<string, PlistValue>> {
    const reply = this.#last.catch(() => {}).then(() => this.#exchange(message));
    this.#last = reply;
    return reply;
  }

  async #exchange(message: Record<string, PlistValue>): Promise<Record<string, PlistValue>> {
    const what = String(message.Request ?? message.Command);
    this.stream.write(plistFrame({ Label: LABEL, ...message }));
    const reply = parsePlist(await this.#reader.read((await this.#reader.read(4)).readUInt32BE(0)));
    if (!isPlainObject(reply)) throw new Error(`${this.peer} answered ${what} with something other than a dict`);
    const error = (reply as Record<string, unknown>).Error;
    if (error !== undefined) throw new RefusedError(this.peer, what, String(error));
    return reply as Record<string, PlistValue>;
  }

  release(): Duplex {
    return this.#reader.release();
  }
}

/** A signed-in lockdownd session, which reads device values and starts services. */
export class Lockdown {
  readonly #device: MuxDevice;
  readonly #socketPath: string;
  readonly #record: PairRecord;
  readonly #channel: PlistChannel;

  private constructor(device: MuxDevice, socketPath: string, record: PairRecord, channel: PlistChannel) {
    this.#device = device;
    this.#socketPath = socketPath;
    this.#record = record;
    this.#channel = channel;
  }

  static async open(socketPath: string, device: MuxDevice, record: PairRecord, signal: AbortSignal): Promise<Lockdown> {
    let stream = await connectPort(socketPath, device, LOCKDOWN_PORT, signal);
    try {
      let channel = new PlistChannel(stream, "lockdownd");
      const session = await channel.request({ Request: "StartSession", HostID: record.hostId, SystemBUID: record.systemBuid }).catch((error: unknown) => {
        if (error instanceof RefusedError && error.code === "InvalidHostID") throw new DeviceError(`${device.udid} no longer trusts this Mac`, "unplug it, plug it back in, unlock it and tap Trust");
        throw error;
      });
      if (session.EnableSessionSSL === true) {
        stream = await secure(channel.release(), record, signal);
        channel = new PlistChannel(stream, "lockdownd");
      }
      return new Lockdown(device, socketPath, record, channel);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  async value(key: string): Promise<PlistValue> {
    const reply = await this.#channel.request({ Request: "GetValue", Key: key });
    if (reply.Value === undefined) throw new Error(`lockdownd has no ${key}`);
    return reply.Value;
  }

  /** Starts a service and connects to it, signed in when the service asks for it. */
  async startService(name: string, signal: AbortSignal): Promise<Duplex> {
    const reply = await this.#channel.request({ Request: "StartService", Service: name });
    const port = field(reply, "Port", isNumber, `lockdownd's reply to StartService ${name}`);
    const stream = await connectPort(this.#socketPath, this.#device, port, signal);
    return reply.EnableServiceSSL === true ? secure(stream, this.#record, signal) : stream;
  }

  /** Starts a service that answers plist requests, sends it one, and closes it. */
  async serviceRequest(name: string, message: Record<string, PlistValue>, signal: AbortSignal): Promise<Record<string, PlistValue>> {
    const stream = await this.startService(name, signal);
    try {
      return await new PlistChannel(stream, name).request(message);
    } finally {
      stream.destroy();
    }
  }

  close(): void {
    this.#channel.stream.destroy();
  }
}
