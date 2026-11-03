import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';

interface Col { key: string; label?: string; type?: 'text' | 'number' | 'bool' | 'array' | 'json' | 'date' | 'select'; options?: string[] }
const FUNCS = ['MANUFACTURING', 'TESTING', 'RND', 'LOGISTICS', 'SERVICE'];
const ENT: Record<string, { label: string; cols: Col[]; pk?: string; plan?: boolean; note?: string }> = {
  users: { label: 'Users & roles', cols: [{ key: 'username' }, { key: 'name' }, { key: 'role', type: 'select', options: ['MANUFACTURING', 'TESTING', 'RND', 'LOGISTICS', 'COMMERCIAL', 'SERVICE', 'MANAGEMENT'] }, { key: 'active', type: 'bool' }, { key: 'password', label: 'new password' }] },
  permissions: { label: 'Approval permissions & capabilities', pk: 'action', note: 'Role permissions. Narrow capabilities (release approval, test-scope approval, quality release, conditional release) can be given to named users via user capabilities.', cols: [{ key: 'action' }, { key: 'roles', type: 'array' }, { key: 'description' }] },
  customers: { label: 'Customers', cols: [{ key: 'name' }, { key: 'country' }, { key: 'region_id', type: 'number' }] },
  regions: { label: 'Regions', cols: [{ key: 'code' }, { key: 'name' }] },
  product_types: { label: 'Products', cols: [{ key: 'code' }, { key: 'name' }, { key: 'family', type: 'select', options: ['POWER_CABINET', 'DISPENSER', 'CHARGE_DOCK'] }, { key: 'item_codes', type: 'array', label: 'item code patterns' }, { key: 'default_hw_revision' }] },
  routing_versions: { label: 'Routing versions', plan: true, note: 'Dated, versioned routings per product (UNIT) and for systems, shipments and site visits. New units use the latest approved version effective today.', cols: [{ key: 'product_type_id', type: 'number' }, { key: 'template_kind', type: 'select', options: ['UNIT', 'SYSTEM', 'SHIPMENT', 'VISIT'] }, { key: 'code' }, { key: 'version', type: 'number' }, { key: 'effective_from', type: 'date' }, { key: 'status', type: 'select', options: ['DRAFT', 'APPROVED', 'RETIRED'] }, { key: 'notes' }] },
  routing_steps: { label: 'Routing steps', plan: true, note: 'Durations in half-days. phases = resource profile per phase (JSON); hold_from keeps a resource held from an earlier step (e.g. the skid until removal); gate_templates create readiness gates.', cols: [{ key: 'routing_version_id', type: 'number' }, { key: 'seq', type: 'number' }, { key: 'code' }, { key: 'name' }, { key: 'function', type: 'select', options: FUNCS }, { key: 'work_center_id', type: 'number' }, { key: 'duration_slots', type: 'number' }, { key: 'scope', type: 'select', options: ['UNIT', 'SYSTEM', 'SHIPMENT', 'SITE', 'SITE_SYSTEM'] }, { key: 'stage', type: 'select', options: ['PRE', 'POST'] }, { key: 'kind', type: 'select', options: ['work', 'transport', 'calendar', 'external'] }, { key: 'milestone_tag' }, { key: 'test_plan_code' }, { key: 'phases', type: 'json' }, { key: 'hold_from', type: 'json' }, { key: 'gate_templates', type: 'json' }] },
  work_centers: { label: 'Resources & capacity', plan: true, note: 'Stations, positions, skids, shared equipment, personnel pools and teams. Capacity = units available per half-day. Dated changes go through the capacity timeline (Capacity page).', cols: [{ key: 'code' }, { key: 'name' }, { key: 'function', type: 'select', options: FUNCS }, { key: 'resource_type', type: 'select', options: ['STATION', 'POSITION', 'SKID', 'SHARED', 'PERSONNEL', 'TEAM', 'AREA'] }, { key: 'capacity', type: 'number' }, { key: 'calendar_id', type: 'number' }, { key: 'region' }, { key: 'route_order', type: 'number' }, { key: 'sizing_target_id', label: 'must feed (id)', type: 'number' }, { key: 'provisional', type: 'bool' }, { key: 'notes' }] },
  resource_reservations: { label: 'Non-production reservations', plan: true, note: 'Troubleshooting, regression, test development, setup, removal, maintenance. Slots: day number × 2 (+1 for PM).', cols: [{ key: 'work_center_id', type: 'number' }, { key: 'start_slot', type: 'number' }, { key: 'finish_slot', type: 'number' }, { key: 'units', type: 'number' }, { key: 'kind', type: 'select', options: ['TROUBLESHOOTING', 'REGRESSION', 'TEST_DEV', 'SETUP', 'REMOVAL', 'MAINTENANCE', 'OTHER'] }, { key: 'reason' }, { key: 'status', type: 'select', options: ['PLANNED', 'ACTIVE', 'RELEASED', 'CANCELLED'] }] },
  calendars: { label: 'Working calendars', plan: true, note: 'Working weekdays: 0 = Sunday … 6 = Saturday.', cols: [{ key: 'code' }, { key: 'name' }, { key: 'country' }, { key: 'working_weekdays', type: 'array' }] },
  calendar_holidays: { label: 'Holidays', plan: true, cols: [{ key: 'calendar_id', type: 'number' }, { key: 'date', type: 'date' }, { key: 'name' }] },
  weekend_authorizations: { label: 'Weekend exceptions', plan: true, cols: [{ key: 'work_center_id', type: 'number' }, { key: 'activity_id', type: 'number' }, { key: 'date', type: 'date' }, { key: 'capacity', type: 'number' }, { key: 'reason' }, { key: 'active', type: 'bool' }] },
  routes: { label: 'Transport routes', plan: true, cols: [{ key: 'code' }, { key: 'name' }, { key: 'origin_country' }, { key: 'destination_country' }, { key: 'region_id', type: 'number' }, { key: 'lead_time_days', type: 'number' }, { key: 'min_days', type: 'number' }, { key: 'max_days', type: 'number' }, { key: 'operates_saturday', type: 'bool' }, { key: 'operates_sunday', type: 'bool' }, { key: 'holiday_calendar_ids', type: 'array' }, { key: 'release_lag_slots', type: 'number' }, { key: 'restrictions' }] },
  service_profiles: { label: 'Logistics service profiles', plan: true, note: 'Route- and service-specific durations. ASSUMPTION = case-specific planning input that Logistics must confirm (e.g. US air 3 weeks, Australia sea 70 days).', cols: [{ key: 'route_id', type: 'number' }, { key: 'code' }, { key: 'name' }, { key: 'mode', type: 'select', options: ['ROAD', 'AIR', 'SEA'] }, { key: 'service_level' }, { key: 'internal_prep_slots', type: 'number' }, { key: 'transit_days', type: 'number' }, { key: 'customs_days', type: 'number' }, { key: 'final_delivery_days', type: 'number' }, { key: 'booking_lead_days', type: 'number' }, { key: 'confirmation_status', type: 'select', options: ['ASSUMPTION', 'CONFIRMED'] }, { key: 'notes' }] },
  test_plans: { label: 'Test scopes', plan: true, note: 'Reduced validation can only be scheduled with an approved test scope (approval on the Quality page by the technical authority).', cols: [{ key: 'code' }, { key: 'name' }, { key: 'version', type: 'number' }, { key: 'scope', type: 'select', options: ['UNIT', 'SYSTEM'] }, { key: 'duration_slots', type: 'number' }, { key: 'status', type: 'select', options: ['DRAFT', 'PROPOSED', 'APPROVED', 'RETIRED', 'REJECTED'] }, { key: 'rationale' }] },
  sw_components: { label: 'Software components', cols: [{ key: 'code' }, { key: 'name' }, { key: 'kind', type: 'select', options: ['FIRMWARE', 'FPGA', 'SOFTWARE', 'TOOL', 'CONFIG_PACKAGE'] }, { key: 'product_family' }] },
  materials: { label: 'Critical materials', cols: [{ key: 'part_number' }, { key: 'description' }, { key: 'critical', type: 'bool' }, { key: 'uom' }] },
  bom_items: { label: 'BOM (critical items)', plan: true, note: 'Changes come from BOM-correction actions; requirements outside the BOM never edit it silently.', cols: [{ key: 'product_type_id', type: 'number' }, { key: 'material_id', type: 'number' }, { key: 'qty_per_unit', type: 'number' }, { key: 'needed_at_code' }] },
  delay_categories: { label: 'Delay reasons', cols: [{ key: 'code' }, { key: 'name' }] },
  settings: { label: 'Governance settings', pk: 'key', plan: true, note: 'Freeze policy, risk thresholds, priority/demand rules, EOL resource profile status, open assumptions, time zone, clock override (demo).', cols: [{ key: 'key' }, { key: 'value', type: 'json' }, { key: 'description' }] },
};

function toForm(row: any, cols: Col[]) {
  const f: any = {};
  for (const c of cols) {
    const v = row?.[c.key];
    f[c.key] = c.type === 'array' ? (v ?? []).join(',') : c.type === 'json' ? JSON.stringify(v ?? null) : v ?? (c.type === 'bool' ? false : '');
  }
  return f;
}
function fromForm(f: any, cols: Col[]) {
  const o: any = {};
  for (const c of cols) {
    let v = f[c.key];
    if (c.key === 'password' && !v) continue;
    if (c.type === 'array') v = String(v).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^-?\d+$/.test(x) ? Number(x) : x));
    else if (c.type === 'number') v = v === '' || v === null ? null : Number(v);
    else if (c.type === 'json') v = JSON.parse(v);
    o[c.key] = v;
  }
  return o;
}

export function Admin() {
  const { can, toast, reload: reloadMeta } = useApp();
  const [ent, setEnt] = useState('work_centers');
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<{ id: any; form: any } | null>(null);
  const def = ENT[ent];
  const pk = def.pk ?? 'id';
  const load = () => api(`/admin/${ent}`).then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); setEdit(null); }, [ent]);
  const save = async () => {
    if (!edit) return;
    let body: any;
    try { body = fromForm(edit.form, def.cols); } catch { return toast('Invalid JSON value', 'err'); }
    if (def.plan) {
      const r = prompt('Reason for this planning-parameter change (audited):');
      if (!r) return;
      body._reason = r;
    }
    try {
      if (edit.id === null) await api(`/admin/${ent}`, { body });
      else await api(`/admin/${ent}/${encodeURIComponent(edit.id)}`, { method: 'PUT', body });
      toast(def.plan ? 'Saved — plan recalculated' : 'Saved', 'ok');
      setEdit(null);
      load();
      reloadMeta();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const del = async (row: any) => {
    if (!confirm('Delete this record?')) return;
    const r = def.plan ? prompt('Reason:') : 'n/a';
    if (!r) return;
    try { await api(`/admin/${ent}/${encodeURIComponent(row[pk])}`, { method: 'DELETE', body: { _reason: r } }); load(); } catch (e: any) { toast(e.message, 'err'); }
  };
  if (!can('admin.config')) return <div className="pad alert info">Administration is available to Management / Program.</div>;
  return (
    <div className="page split">
      <div className="list-pane">
        <h2>Administration</h2>
        {Object.entries(ENT).map(([k, v]) => <div key={k} className={`list-item ${ent === k ? 'on' : ''}`} onClick={() => setEnt(k)}>{v.label}</div>)}
      </div>
      <div className="detail-pane">
        <div className="toolbar"><h3>{def.label}</h3><div className="spacer" /><button onClick={() => setEdit({ id: null, form: toForm(null, def.cols) })}>+ Add</button></div>
        {def.note && <p className="hint">{def.note}</p>}
        <div className="scroll-x">
          <table className="grid tight">
            <thead><tr>{pk === 'id' && <th>id</th>}{def.cols.filter((c) => c.key !== 'password').map((c) => <th key={c.key}>{c.label ?? c.key}</th>)}<th></th></tr></thead>
            <tbody>
              {edit?.id === null && <EditRow def={def} form={edit.form} setForm={(f) => setEdit({ ...edit, form: f })} onSave={save} onCancel={() => setEdit(null)} showId={pk === 'id'} />}
              {rows.map((r) => edit && edit.id === r[pk]
                ? <EditRow key={r[pk]} def={def} form={edit.form} setForm={(f) => setEdit({ ...edit, form: f })} onSave={save} onCancel={() => setEdit(null)} showId={pk === 'id'} id={r.id} />
                : (
                  <tr key={r[pk]}>
                    {pk === 'id' && <td className="muted">{r.id}</td>}
                    {def.cols.filter((c) => c.key !== 'password').map((c) => <td key={c.key} className="small">{c.type === 'json' ? <code>{JSON.stringify(r[c.key])}</code> : c.type === 'bool' ? (r[c.key] ? '✓' : '') : Array.isArray(r[c.key]) ? r[c.key].join(', ') : String(r[c.key] ?? '')}</td>)}
                    <td className="nowrap"><button className="icon" onClick={() => setEdit({ id: r[pk], form: toForm(r, def.cols) })}>✎</button><button className="icon" onClick={() => del(r)}>🗑</button></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EditRow({ def, form, setForm, onSave, onCancel, showId, id }: { def: any; form: any; setForm: (f: any) => void; onSave: () => void; onCancel: () => void; showId: boolean; id?: number }) {
  return (
    <tr className="editing">
      {showId && <td className="muted">{id ?? 'new'}</td>}
      {def.cols.filter((c: Col) => c.key !== 'password' || true).map((c: Col) => (
        <td key={c.key}>
          {c.type === 'bool' ? <input type="checkbox" checked={!!form[c.key]} onChange={(e) => setForm({ ...form, [c.key]: e.target.checked })} />
            : c.type === 'select' ? <select value={form[c.key]} onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}>{c.options!.map((o) => <option key={o}>{o}</option>)}</select>
              : <input type={c.type === 'date' ? 'date' : c.type === 'number' ? 'number' : 'text'} step="any" value={form[c.key] ?? ''} placeholder={c.label ?? c.key} onChange={(e) => setForm({ ...form, [c.key]: e.target.value })} />}
        </td>
      ))}
      <td className="nowrap"><button className="small" onClick={onSave}>Save</button><button className="small secondary" onClick={onCancel}>✕</button></td>
    </tr>
  );
}
