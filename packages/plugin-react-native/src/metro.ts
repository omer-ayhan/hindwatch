/** Metro always runs on this machine, so the plugin never talks to another host. */
export const METRO_HOST = "localhost";

export interface MetroOptions {
  readonly port: number;
  /** How often each app's JS clock is re-measured on top of every (re)connect. */
  readonly clockResyncMs: number;
}

export interface CdpHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  /** reason: the WebSocket close reason Metro sent, "" when none. */
  onClose(reason: string): void;
}

export interface CdpConnection {
  send(message: string): void;
  close(): void;
}

/** Opens a CDP websocket. Injected so a recorded transcript can replay in tests. */
export type Connect = (url: string, origin: string, handlers: CdpHandlers) => CdpConnection;

export interface MetroDeps {
  readonly fetch: typeof fetch;
  readonly connect: Connect;
  /** How often Metro's target list is checked for new or returning apps. */
  readonly pollMs: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function metroUrl(port: number, path: string, protocol = "http"): string {
  return `${protocol}://${METRO_HOST}:${port}${path}`;
}

export const connectWebSocket: Connect = (url, origin, handlers) => {
  // Metro refuses inspector connections without an Origin it trusts; Node's WebSocket (undici)
  // takes headers through its init object, which the DOM typings don't describe.
  const socket = new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  });
  socket.addEventListener("close", (event) => handlers.onClose(event.reason));
  return {
    send: (message) => socket.readyState === WebSocket.OPEN && socket.send(message),
    close: () => socket.close(),
  };
};
