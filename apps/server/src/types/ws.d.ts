declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  import { EventEmitter } from 'node:events';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: number;
    send(data: string | Buffer | ArrayBuffer | Uint8Array, cb?: (err?: Error) => void): void;
    close(code?: number, data?: string | Buffer): void;
    terminate(): void;
    ping(data?: unknown): void;

    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
  }

  export interface ServerOptions {
    host?: string;
    port?: number;
    backlog?: number;
    server?: unknown;
    verifyClient?: unknown;
    handleProtocols?: unknown;
    path?: string;
    noServer?: boolean;
    clientTracking?: boolean;
    perMessageDeflate?: boolean | unknown;
    maxPayload?: number;
    skipUTF8Validation?: boolean;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: ServerOptions, callback?: () => void);
    readonly clients: Set<WebSocket>;
    close(cb?: (err?: Error) => void): void;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      upgradeHead: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void
    ): void;

    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
  }

  export default WebSocket;
}
