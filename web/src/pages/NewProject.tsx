import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Modal } from '../components/ui';
import { useApp } from '../store';
import { finishLabel } from '../time';

export function NewProject({ onClose }: { onClose: () => void }) {
  const { meta, toast } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState<any>({ code: '', name: '', customerId: meta?.customers[0]?.id, siteLocation: '', country: meta?.customers[0]?.country ?? 'DE', routeId: meta?.routes[0]?.id, requiredDate: '', lines: [{ productTypeId: meta?.productTypes[0]?.id, quantity: 2 }] });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('/projects', { body: { ...f, customerId: Number(f.customerId), routeId: Number(f.routeId), lines: f.lines.map((l: any) => ({ productTypeId: Number(l.productTypeId), quantity: Number(l.quantity) })) } });
      toast(r.feasible ? 'Project planned backward from the required commissioning date' : `Required date not achievable — earliest commissioning ${finishLabel(r.earliestCommissioning)}`, r.feasible ? 'ok' : 'err');
      onClose();
      nav(`/projects/${r.projectId}`);
    } catch (e: any) { setErr(e.message + (e.details ? ` ${JSON.stringify(e.details).slice(0, 200)}` : '')); } finally { setBusy(false); }
  };
  if (!meta) return null;
  return (
    <Modal title="New customer project (initial backward plan)" onClose={onClose}>
      <div className="form two">
        <label className="field">Code <input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="P09" /></label>
        <label className="field">Name <input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">Customer <select value={f.customerId} onChange={(e) => { set('customerId', e.target.value); const c = meta.customers.find((x: any) => x.id === Number(e.target.value)); if (c) set('country', c.country); }}>
          {meta.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field">Site <input value={f.siteLocation} onChange={(e) => set('siteLocation', e.target.value)} /></label>
        <label className="field">Country (site calendar) <input value={f.country} maxLength={2} onChange={(e) => set('country', e.target.value.toUpperCase())} /></label>
        <label className="field">Transport route <select value={f.routeId} onChange={(e) => set('routeId', e.target.value)}>
          {meta.routes.map((r: any) => <option key={r.id} value={r.id}>{r.name} ({r.min_days}–{r.max_days} d)</option>)}</select></label>
        <label className="field">Required commissioning completion <input type="date" value={f.requiredDate} onChange={(e) => set('requiredDate', e.target.value)} /></label>
      </div>
      <h4>Order lines</h4>
      {f.lines.map((l: any, i: number) => (
        <div key={i} className="row">
          <select value={l.productTypeId} onChange={(e) => set('lines', f.lines.map((x: any, j: number) => (j === i ? { ...x, productTypeId: e.target.value } : x)))}>
            {meta.productTypes.map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
          </select>
          <input type="number" min={1} value={l.quantity} style={{ width: 70 }} onChange={(e) => set('lines', f.lines.map((x: any, j: number) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <button className="icon" onClick={() => set('lines', f.lines.filter((_: any, j: number) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="secondary small" onClick={() => set('lines', [...f.lines, { productTypeId: meta.productTypes[0].id, quantity: 1 }])}>+ line</button>
      <p className="hint">Each physical unit gets its own activity flow with full standard durations (no quantity efficiencies). The plan is generated backward from the commissioning date against the capacity already reserved by higher-priority projects; the project enters at the bottom of the ranking.</p>
      {err && <div className="alert err">{err}</div>}
      <div className="actions"><button className="secondary" onClick={onClose}>Cancel</button><button disabled={busy} onClick={submit}>Create & plan</button></div>
    </Modal>
  );
}
