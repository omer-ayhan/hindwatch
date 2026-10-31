import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { ByteReader, encodeXmlPlist, muxFrame, parsePlist, plistFrame, type PlistValue } from "@hindwatch/core";
import { testIdentity, type TestIdentity } from "./helpers.js";

export interface FakeDevice {
  readonly udid: string;
  readonly connection: "USB" | "Network";
}

export interface FakeUsbmuxdOptions {
  readonly devices: readonly FakeDevice[];
  /** Pair records by udid; a device without one isn't paired. */
  readonly paired: ReadonlySet<string>;
  /** Installed apps' bundle folders, by bundle id. */
  readonly installed: ReadonlyMap<string, string>;
  /** The device clock, in epoch ms, as lockdownd reports it. */
  readonly deviceNow: () => number;
  /** What os_trace_relay sends once asked to stream. */
  readonly relay: Buffer;
  /** Sign in over TLS, as a real device does, with the pair record holding this device's certificate or another's. */
  readonly tls?: { readonly pairedWith: "device" | "other" };
  /** The device no longer trusts the Mac, though the Mac keeps its pair record. */
  readonly forgotten?: boolean;
  /** A request it never answers. */
  readonly ignores?: string;
}

/** The device's, the Mac's and another device's certificates, made once per test run. */
let identities: Promise<TestIdentity[]> | undefined;

const LOCKDOWN_PORT = 62078;
const SERVICE_PORTS: Readonly<Record<string, number>> = { "com.apple.os_trace_relay": 50001, "com.apple.mobile.installation_proxy": 50002 };

async function plistRequest(reader: ByteReader): Promise<Record<string, PlistValue>> {
  return parsePlist(await reader.read((await reader.read(4)).readUInt32BE(0))) as Record<string, PlistValue>;
}

/**
 * usbmuxd on a socket of its own, with lockdownd, installation_proxy and os_trace_relay behind it,
 * speaking their wire formats, signed in over TLS when asked to.
 */
export async function fakeUsbmuxd(options: FakeUsbmuxdOptions) {
  const dir = await mkdtemp(join(tmpdir(), "hw-mux-"));
  const path = join(dir, "usbmuxd");
  const requests: string[] = [];
  const open = new Set<Socket>();
  const [device, host, other] = await (identities ??= Promise.all(["device", "host", "other"].map(testIdentity)));
  const record = {
    HostID: "HOST",
    SystemBUID: "BUID",
    HostCertificate: host!.cert,
    HostPrivateKey: host!.key,
    DeviceCertificate: options.tls?.pairedWith === "other" ? other!.cert : device!.cert,
  };

  /** The connection from here on: over TLS when the device signs in with it. */
  const secured = (socket: Socket, reader: ByteReader): { stream: Duplex; reader: ByteReader } => {
    if (options.tls === undefined) return { stream: socket, reader };
    const stream = new TLSSocket(reader.release() as Socket, { isServer: true, key: device!.key, cert: device!.cert }).on("error", () => {});
    return { stream, reader: new ByteReader(stream) };
  };

  const lockdown = async (socket: Socket, first: ByteReader) => {
    let { stream, reader }: { stream: Duplex; reader: ByteReader } = { stream: socket, reader: first };
    const reply = (message: Record<string, PlistValue>) => stream.write(plistFrame(message));
    for (;;) {
      const request = await plistRequest(reader);
      const name = String(request.Request);
      requests.push(`lockdown ${name}${request.Key === undefined ? "" : ` ${String(request.Key)}`}${request.Service === undefined ? "" : ` ${String(request.Service)}`}`);
      if (name === options.ignores) continue;
      if (name === "StartSession" && options.forgotten === true) reply({ Request: name, Error: "InvalidHostID" });
      else if (name === "StartSession") {
        reply({ Request: name, SessionID: "S", EnableSessionSSL: options.tls !== undefined });
        ({ stream, reader } = secured(socket, reader));
      } else if (name === "GetValue" && request.Key === "TimeIntervalSince1970") reply({ Request: name, Value: options.deviceNow() / 1000 });
      else if (name === "StartService") reply({ Request: name, Port: SERVICE_PORTS[String(request.Service)]!, EnableServiceSSL: options.tls !== undefined });
      else reply({ Request: name, Error: "UnsupportedRequest" });
    }
  };

  const relay = async (socket: Socket, reader: ByteReader) => {
    const service = secured(socket, reader);
    const request = await plistRequest(service.reader);
    requests.push(`relay ${String(request.Request)}`);
    service.stream.write(options.relay);
  };

  const installationProxy = async (socket: Socket, reader: ByteReader) => {
    const service = secured(socket, reader);
    const request = await plistRequest(service.reader);
    const command = String(request.Command);
    requests.push(`installation_proxy ${command}`);
    if (command === options.ignores) return;
    const wanted = ((request.ClientOptions as Record<string, PlistValue>).BundleIDs as string[]).filter((id) => options.installed.has(id));
    service.stream.write(plistFrame({ Status: "Complete", LookupResult: Object.fromEntries(wanted.map((id) => [id, { Path: options.installed.get(id)! }])) }));
  };

  const services: Readonly<Record<number, (socket: Socket, reader: ByteReader) => Promise<void>>> = {
    [LOCKDOWN_PORT]: lockdown,
    [SERVICE_PORTS["com.apple.os_trace_relay"]!]: relay,
    [SERVICE_PORTS["com.apple.mobile.installation_proxy"]!]: installationProxy,
  };

  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket)).on("error", () => {});
    const reader = new ByteReader(socket);
    void (async () => {
      const length = (await reader.read(16)).readUInt32LE(0);
      const message = parsePlist(await reader.read(length - 16)) as Record<string, PlistValue>;
      requests.push(`mux ${String(message.MessageType)}`);
      if (message.MessageType === "ListDevices") {
        const list = options.devices.map((device, index) => ({ DeviceID: index + 1, MessageType: "Attached", Properties: { SerialNumber: device.udid, ConnectionType: device.connection } }));
        socket.end(muxFrame({ DeviceList: list }));
      } else if (message.MessageType === "ReadPairRecord") {
        const paired = options.paired.has(String(message.PairRecordID));
        socket.end(muxFrame(paired ? { PairRecordData: Buffer.from(encodeXmlPlist(record)) } : { MessageType: "Result", Number: 2 }));
      } else if (message.MessageType === "Connect") {
        const port = Number(message.PortNumber);
        const service = services[((port & 0xff) << 8) | (port >> 8)];
        socket.write(muxFrame({ MessageType: "Result", Number: service === undefined ? 3 : 0 }));
        if (service === undefined) socket.end();
        else await service(socket, reader);
      }
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    /** Ends every connection, as unplugging the device does. */
    unplug: () => {
      for (const socket of open) socket.destroy();
    },
    async close() {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
