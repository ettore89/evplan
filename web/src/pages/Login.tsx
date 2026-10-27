import { useEffect, useState } from 'react';
import { api, setToken } from '../api';
import { ROLE_LABEL } from '../components/ui';
import { useApp } from '../store';

export function Login() {
  const { reload } = useApp();
  const [demo, setDemo] = useState<any[]>([]);
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('/auth/demo-users').then(setDemo).catch(() => {}); }, []);
  const login = async (username: string, password: string) => {
    try {
      const r = await api('/auth/login', { body: { username, password } });
      setToken(r.token);
      await reload();
      location.href = r.user.role === 'MANAGEMENT' ? '/daily' : '/priority';
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand big"><span className="logo">⚡</span> EV Production Planner</div>
        <p className="muted">Planning & execution from PCBA manufacturing to in-field commissioning.</p>
        <form onSubmit={(e) => { e.preventDefault(); login(u, p); }}>
          <label className="field">Username <input value={u} onChange={(e) => setU(e.target.value)} autoFocus /></label>
          <label className="field">Password <input type="password" value={p} onChange={(e) => setP(e.target.value)} /></label>
          {err && <div className="alert err">{err}</div>}
          <button>Sign in</button>
        </form>
        {demo.length > 0 && (
          <>
            <h4>Demo users (password "demo")</h4>
            <div className="demo-users">{demo.map((d) => (
              <button key={d.username} className="secondary" onClick={() => login(d.username, 'demo')}>
                <b>{ROLE_LABEL[d.role]}</b><span className="small muted">{d.name} · {d.username}</span>
              </button>
            ))}</div>
          </>
        )}
      </div>
    </div>
  );
}
