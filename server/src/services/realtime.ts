import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, type WebSocket } from 'ws';
import { JWT_SECRET } from './auth.js';
import type { AuthUser } from './common.js';

interface Client { ws: WebSocket; user: AuthUser }
const clients = new Set<Client>();

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://x');
    let user: AuthUser;
    try {
      user = jwt.verify(url.searchParams.get('token') ?? '', JWT_SECRET) as AuthUser;
    } catch {
      ws.close(4001, 'unauthorized');
      return;
    }
    const c = { ws, user };
    clients.add(c);
    broadcastPresence();
    ws.on('close', () => {
      clients.delete(c);
      broadcastPresence();
    });
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(String(m));
        if (msg.type === 'focus') broadcast({ type: 'focus', user: { id: user.id, name: user.name, role: user.role }, target: msg.target });
      } catch { /* ignore */ }
    });
  });
  return wss;
}

export function presence() {
  const seen = new Map<number, { id: number; name: string; role: string; connections: number }>();
  for (const c of clients) {
    const p = seen.get(c.user.id) ?? { id: c.user.id, name: c.user.name, role: c.user.role, connections: 0 };
    p.connections++;
    seen.set(c.user.id, p);
  }
  return [...seen.values()];
}

function broadcastPresence() {
  broadcast({ type: 'presence', users: presence() });
}

export function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}
