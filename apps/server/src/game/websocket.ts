import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { WebSocketEventType, WebSocketMessage } from '@mzp-quiz/shared';
import { timingSafeEqual } from 'node:crypto';

export type ClientInfo = {
  socket: WebSocket;
  role: 'admin' | 'public';
  connectedAt: number;
};

export class WebSocketHub {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientInfo>();
  private getStateCallback?: (role: 'admin' | 'public') => unknown;
  private getLeaderboardCallback?: () => unknown;
  private readonly adminToken?: string;
  private closed = false;

  constructor(server: HttpServer, adminToken?: string) {
    this.adminToken = adminToken;
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols(protocols: Set<string>) {
        return protocols.has('mzp-admin') ? 'mzp-admin' : 'mzp-public';
      },
    });
    // Allow the process to exit even if WebSocket clients are still connected
    this.wss.on('listening', () => {
      (this.wss as any)._server?.unref?.();
    });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws' || url.pathname === '/ws/') {
        const protocols = (request.headers['sec-websocket-protocol'] ?? '')
          .split(',')
          .map((protocol) => protocol.trim());
        if (protocols.includes('mzp-admin')) {
          const supplied = protocols.find((protocol) => protocol.startsWith('mzp-token.'))?.slice('mzp-token.'.length);
          if (!this.isValidAdminToken(supplied)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const protocols = (request.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((protocol) => protocol.trim());
      const role: 'admin' | 'public' = protocols.includes('mzp-admin') ? 'admin' : 'public';

      const info: ClientInfo = {
        socket: ws,
        role,
        connectedAt: Date.now(),
      };
      this.clients.set(ws, info);

      // Send initial state immediately upon connection
      if (this.getStateCallback) {
        const state = this.getStateCallback(role);
        if (state) {
          this.sendTo(ws, {
            type: 'state_sync',
            payload: state as any,
            timestamp: Date.now(),
          });
        }
        if (this.getLeaderboardCallback) {
          const payload = this.getLeaderboardCallback();
          if (payload) {
            this.sendTo(ws, {
              type: 'leaderboard_updated',
              payload: payload as any,
              timestamp: Date.now(),
            });
          }
        }
      }

      ws.on('message', (data: Buffer | string) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'ping') {
            this.sendTo(ws, { type: 'state_sync', payload: { message: 'pong' } as any, timestamp: Date.now() });
          } else if (parsed.type === 'get_state' && this.getStateCallback) {
            const state = this.getStateCallback(role);
            if (state) {
              this.sendTo(ws, {
                type: 'state_sync',
                payload: state as any,
                timestamp: Date.now(),
              });
            }
          }
        } catch {
          // Ignore invalid JSON
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  public registerStateProvider(provider: (role: 'admin' | 'public') => unknown) {
    this.getStateCallback = provider;
  }

  public registerLeaderboardProvider(provider: () => unknown) {
    this.getLeaderboardCallback = provider;
  }

  public broadcastLeaderboard(getPayload: () => unknown) {
    if (this.clients.size === 0) return;
    const message: WebSocketMessage = {
      type: 'leaderboard_updated',
      payload: getPayload() as any,
      timestamp: Date.now(),
    };
    const serialized = JSON.stringify(message);
    for (const [ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(serialized);
    }
  }

  public broadcast(
    event: WebSocketEventType,
    getAdminPayload: () => unknown,
    getPublicPayload: () => unknown
  ) {
    if (this.clients.size === 0) return;

    let adminCached: string | null = null;
    let publicCached: string | null = null;
    const now = Date.now();

    for (const [ws, info] of this.clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (info.role === 'admin') {
        if (!adminCached) {
          const payload = getAdminPayload();
          const msg: WebSocketMessage = { type: event, payload: payload as any, timestamp: now };
          adminCached = JSON.stringify(msg);
        }
        ws.send(adminCached);
      } else {
        if (!publicCached) {
          const payload = getPublicPayload();
          const msg: WebSocketMessage = { type: event, payload: payload as any, timestamp: now };
          publicCached = JSON.stringify(msg);
        }
        ws.send(publicCached);
      }
    }
  }

  public sendTo(ws: WebSocket, message: WebSocketMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  public getConnectedCount(): { total: number; admin: number; public: number } {
    let admin = 0;
    let pub = 0;
    for (const info of this.clients.values()) {
      if (info.role === 'admin') admin++;
      else pub++;
    }
    return { total: this.clients.size, admin, public: pub };
  }

  public close() {
    if (this.closed) return;
    this.closed = true;
    for (const ws of this.clients.keys()) {
      try {
        ws.terminate();
      } catch {
        // Ignore termination error
      }
    }
    this.clients.clear();
    this.wss.close();
  }

  private isValidAdminToken(candidate?: string): boolean {
    if (!candidate || !this.adminToken) return false;
    const expected = Buffer.from(this.adminToken);
    const supplied = Buffer.from(candidate);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}
