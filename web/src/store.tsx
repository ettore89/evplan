import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, getToken } from './api';

export interface User { id: number; username: string; name: string; role: string }
export interface Presence { id: number; name: string; role: string; connections: number }
interface PlanEvent { type: string; version: number; kind: string; summary: string; userId: number | null; changedActivities: number; milestoneChanges: number; at: number }

interface Ctx {
  user: User | null;
  permissions: string[];
  can: (action: string) => boolean;
  meta: any;
  version: number;
  connected: boolean;
  presence: Presence[];
  events: PlanEvent[];
  reload: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'err' | 'info') => void;
  /** Daily-call change basket: proposals collected during the call, simulated together and committed once. */
  basket: BasketItem[];
  addToBasket: (item: BasketItem) => void;
  removeFromBasket: (i: number) => void;
  clearBasket: () => void;
}
export interface BasketItem { label: string; op: any }

const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [basket, setBasket] = useState<BasketItem[]>(() => { try { return JSON.parse(sessionStorage.getItem('evplan.basket') ?? '[]'); } catch { return []; } });
  useEffect(() => { try { sessionStorage.setItem('evplan.basket', JSON.stringify(basket)); } catch { /* ignore */ } }, [basket]);
  const addToBasket = useCallback((item: BasketItem) => setBasket((b) => [...b, item]), []);
  const removeFromBasket = useCallback((i: number) => setBasket((b) => b.filter((_, k) => k !== i)), []);
  const clearBasket = useCallback(() => setBasket([]), []);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' | 'info' = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 7000 : 4500);
  }, []);

  const reload = useCallback(async () => {
    if (!getToken()) return;
    const me = await api('/me');
    setUser(me.user);
    setPermissions(me.permissions);
    setMeta(await api('/meta'));
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  useEffect(() => {
    if (!user) return;
    let stop = false;
    let retry: any;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${getToken()}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (!stop) retry = setTimeout(connect, 2000); };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === 'presence') setPresence(msg.users);
        if (msg.type === 'plan.updated') {
          setVersion(msg.version);
          setEvents((e) => [{ ...msg, at: Date.now() }, ...e].slice(0, 30));
          if (msg.userId !== user.id && msg.kind !== 'TIME_TICK') toast(`Plan updated: ${msg.summary}`, 'info');
        }
      };
    };
    connect();
    return () => { stop = true; clearTimeout(retry); wsRef.current?.close(); };
  }, [user, toast]);

  const can = useCallback((a: string) => permissions.includes(a), [permissions]);
  return (
    <AppCtx.Provider value={{ user, permissions, can, meta, version, connected, presence, events, reload, toast, basket, addToBasket, removeFromBasket, clearBasket }}>
      {children}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
    </AppCtx.Provider>
  );
}

/** Fetch data and refetch automatically whenever the shared plan version changes. */
export function useLive<T>(path: string | null, deps: unknown[] = []) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load, version, ...deps]);
  return { data, error, loading, reload: load, setData };
}
