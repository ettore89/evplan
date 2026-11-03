import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api';
import { Empty } from '../components/ui';
import { DEMAND_LABEL } from '../components/v4';
import { useApp } from '../store';
import { fmtTs } from '../time';

const COUNTRIES = ['DE', 'FR', 'NL', 'AT', 'CH', 'ES', 'SE', 'FI', 'GB', 'GR', 'IT', 'US', 'CA', 'AU'];
type Decision = { kind: 'PROJECT'; projectKey: string } | { kind: 'INTERNAL' } | { kind: 'SKIP' };
const encode = (d: Decision | undefined) => (!d ? '' : d.kind === 'PROJECT' ? `P:${d.projectKey}` : d.kind);
const decode = (v: string): Decision | undefined => (!v ? undefined : v.startsWith('P:') ? { kind: 'PROJECT', projectKey: v.slice(2) } : ({ kind: v } as Decision));

/** Controlled import of the OM Ramp-Up Tracker: upload → preview & reconciliation → name decisions → apply. */
export function ImportView() {
  const { can, toast } = useApp();
  const [batches, setBatches] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [showAll, setShowAll] = useState(false);
  const loadList = () => api('/imports').then(setBatches).catch(() => {});
  useEffect(() => { loadList(); }, []);
  const open = async (id: number) => { setResult(null); setBatch(await api(`/imports/${id}`)); };
  const upload = async (f: File) => {
    setBusy(true); setResult(null);
    try {
      const res = await fetch('/api/imports/om-tracker', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) }, body: await f.arrayBuffer() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setBatch({ ...data, status: 'PREVIEW', filename: f.name, as_of: data.report.asOf });
      loadList();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const decide = async (patch: any) => {
    try { const b = await api(`/imports/${batch.id}/decisions`, { method: 'PUT', body: patch }); setBatch(b); } catch (e: any) { toast(e.message, 'err'); }
  };
  const apply = async () => {
    let body: any = {};
    if (batch.report.olderThanApplied) {
      const reason = prompt('This workbook is older than the last applied tracker. Reason for applying it anyway:');
      if (!reason) return;
      body = { allowOlder: true, reason };
    }
    if (!confirm('Apply this import? Projects, units, readiness and progress will be created or updated as shown in the preview.')) return;
    setBusy(true);
    try { const r = await api(`/imports/${batch.id}/apply`, { body }); setResult(r); toast('Tracker imported — plan recalculated', 'ok'); setBatch(await api(`/imports/${batch.id}`)); loadList(); }
    catch (e: any) { toast(e.message, 'err'); if (e.details?.blocking) setBatch({ ...batch, blocking: e.details.blocking }); } finally { setBusy(false); }
  };
  const rep = batch?.report;
  const m = batch?.mapping ?? {};
  const projOptions = useMemo(() => (rep?.projects ?? []).map((p: any) => ({ key: p.key, label: p.label })), [rep]);
  if (!can('import.apply')) return <div className="page"><h2>Import</h2><Empty>Importing requires the import authority (Management / Program).</Empty></div>;
  const groupsNeeding = (rep?.groups ?? []).filter((g: any) => g.status !== 'AUTO');
  const acceptProposals = () => {
    const groups: any = {};
    for (const g of groupsNeeding) if (g.status === 'PROPOSED' && g.suggestion && !m.groups?.[g.key]) groups[g.key] = g.suggestion;
    decide({ groups });
  };
  const editable = batch?.status === 'PREVIEW';
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Import — OM Ramp-Up Tracker</h2>
        <span className="muted">Preview first; nothing changes until you apply</span>
        <div className="spacer" />
        <label className="button-like">
          <input type="file" accept=".xlsx" style={{ display: 'none' }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <span className="btn">{busy ? 'Working…' : 'Upload workbook (.xlsx)…'}</span>
        </label>
      </div>
      <p className="hint">The workbook stays in this application's database: it is parsed on the server, previewed with every interpretation listed, and applied only after ambiguous names are confirmed. Decisions are remembered for the next import. Tracker progress only moves forward and never overwrites what was recorded in the application.</p>
      {!batch && (
        <table className="grid tight">
          <thead><tr><th>#</th><th>File</th><th>As of</th><th>Status</th><th>Uploaded</th><th>By</th><th>Summary</th></tr></thead>
          <tbody>{batches.map((b) => (
            <tr key={b.id} className="clickable" onClick={() => open(b.id)}><td>{b.id}</td><td>{b.filename}</td><td>{fmtTs(b.as_of)}</td><td>{b.status.toLowerCase()}</td><td className="small">{fmtTs(b.created_at)}</td><td className="small">{b.created_by_name}</td>
              <td className="small">{b.summary ? `${b.summary.projects} projects · ${b.summary.units} units` : ''}{b.applied ? ` · applied: ${b.applied.projectsCreated} new, ${b.applied.unitsImported} units` : ''}</td></tr>
          ))}{!batches.length && <tr><td colSpan={7} className="muted">No imports yet.</td></tr>}</tbody>
        </table>
      )}
      {batch && rep && (
        <>
          <div className="toolbar">
            <button className="secondary small" onClick={() => { setBatch(null); setResult(null); }}>← All imports</button>
            <b>{batch.filename}</b><span className="muted">as of {fmtTs(rep.asOf)} · {batch.status.toLowerCase()}</span>
            {rep.olderThanApplied && <span className="tag-red">older than the last applied tracker ({fmtTs(rep.previousAppliedAsOf)})</span>}
            <div className="spacer" />
            {editable && <button className="secondary" onClick={async () => { await api(`/imports/${batch.id}/discard`, { body: {} }); setBatch(null); loadList(); }}>Discard</button>}
            {editable && <button disabled={busy || batch.blocking?.length > 0} onClick={apply} title={batch.blocking?.length ? 'Resolve the decisions listed below first' : ''}>Apply import</button>}
          </div>
          <div className="statgrid">
            <div className="stat"><b>{rep.summary.projects}</b><span>projects ({rep.summary.newProjects} new, {rep.summary.matchedProjects} matched)</span></div>
            <div className="stat"><b>{rep.summary.units}</b><span>unit rows ({rep.summary.unitsWithIssues} with remarks)</span></div>
            <div className="stat"><b>{rep.summary.groupsNeedingDecision}</b><span>of {rep.summary.groups} name groups need a decision</span></div>
            <div className="stat"><b>{rep.summary.sitePlans}</b><span>site plans</span></div>
            <div className="stat"><b>{rep.summary.releases}</b><span>software releases</span></div>
            <div className="stat"><b>{rep.summary.openTopics}</b><span>open tracker topics</span></div>
          </div>
          {result && (
            <div className="alert ok">
              <b>Imported.</b> {result.stats.projectsCreated} projects created, {result.stats.projectsUpdated} updated · {result.stats.unitsImported} units with tracker identity · {result.stats.internalUnits} internal / R&D units ·
              {' '}{result.stats.completed} activities completed and {result.stats.started} started from the tracker · {result.stats.gates} readiness items · {result.stats.testRecords} test records (not released) · {result.stats.actions} actions raised
              {result.stats.assumedActuals > 0 && <> · {result.stats.assumedActuals} past planned dates taken as actuals (flagged)</>}.
              {result.stats.conflicts.length > 0 && <details><summary>{result.stats.conflicts.length} values kept from the application</summary><ul>{result.stats.conflicts.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul></details>}
              {result.stats.reconciliation.length > 0 && <details open><summary>Reconciliation</summary><ul>{result.stats.reconciliation.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul></details>}
            </div>
          )}
          {editable && batch.blocking?.length > 0 && (
            <div className="alert warn"><b>{batch.blocking.length} decision(s) needed before applying</b>
              <ul>{batch.blocking.slice(0, 12).map((b: any, i: number) => <li key={i}>{b.message}</li>)}{batch.blocking.length > 12 && <li>… and {batch.blocking.length - 12} more</li>}</ul></div>
          )}
          {rep.warnings.length > 0 && <details><summary>{rep.warnings.length} workbook notes</summary><ul className="small">{rep.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></details>}

          {editable && (
            <div className="card">
              <h4>Options</h4>
              {rep.demoProjects > 0 && <label className="check"><input type="checkbox" checked={!!m.replaceDemo} onChange={(e) => decide({ replaceDemo: e.target.checked })} /> Remove the {rep.demoProjects} demo projects (synthetic data) before importing</label>}
              <label className="check"><input type="checkbox" checked={!!m.trustPastDates} onChange={(e) => decide({ trustPastDates: e.target.checked })} /> Treat planned tracker dates that are already in the past as actuals (validation, packaging, shipping, installation, commissioning). They are flagged as assumed; otherwise an "explanation required" action is raised.</label>
            </div>
          )}

          <h3>Unit name groups → projects</h3>
          <p className="hint">Each group collects tracker rows whose "Mapping" text names the same customer. Exact matches are applied automatically; proposals, ambiguous and unmatched names need a person to confirm.</p>
          <div className="toolbar">
            <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show automatic matches too</label>
            {editable && groupsNeeding.some((g: any) => g.status === 'PROPOSED' && !m.groups?.[g.key]) && <button className="secondary small" onClick={acceptProposals}>Accept all proposals</button>}
          </div>
          <table className="grid tight">
            <thead><tr><th>Status</th><th>Tracker text</th><th>Rows</th><th>Why</th><th>Decision</th></tr></thead>
            <tbody>{rep.groups.filter((g: any) => showAll || g.status !== 'AUTO').map((g: any) => {
              const dec = m.groups?.[g.key] ?? (g.status === 'AUTO' ? g.suggestion : undefined);
              return (
                <tr key={g.key} className={`decision-row ${!dec ? 'need' : ''}`}>
                  <td><span className={`gs gs-${g.status === 'AUTO' ? 'READY' : g.status === 'PROPOSED' ? 'PENDING' : g.status === 'AMBIGUOUS' ? 'UNKNOWN' : 'BLOCKED'}`}>{g.status.toLowerCase()}</span></td>
                  <td className="wrap">{g.texts.slice(0, 3).map((t: string) => <div key={t} className="small">{t}</div>)}{g.texts.length > 3 && <div className="small muted">+{g.texts.length - 3} more</div>}</td>
                  <td className="small">{g.units} (rows {g.rows.slice(0, 4).join(', ')}{g.rows.length > 4 ? '…' : ''})</td>
                  <td className="small wrap">{g.reason}</td>
                  <td>{editable ? (
                    <select value={encode(dec)} onChange={(e) => decide({ groups: { [g.key]: decode(e.target.value) } })}>
                      <option value="">— choose —</option>
                      {(g.candidates.length ? g.candidates : []).map((c: any) => <option key={c.key} value={`P:${c.key}`}>★ {c.label}</option>)}
                      {projOptions.filter((p: any) => !g.candidates.some((c: any) => c.key === p.key)).map((p: any) => <option key={p.key} value={`P:${p.key}`}>{p.label}</option>)}
                      <option value="INTERNAL">Internal / R&D unit (no customer project)</option>
                      <option value="SKIP">Do not import</option>
                    </select>) : <span className="small">{dec ? (dec.kind === 'PROJECT' ? projOptions.find((p: any) => p.key === dec.projectKey)?.label : dec.kind.toLowerCase()) : '—'}</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>

          {rep.visitGroups.some((v: any) => showAll || v.status !== 'AUTO') && <>
            <h3>Site plans → projects</h3>
            <table className="grid tight"><tbody>{rep.visitGroups.filter((v: any) => showAll || v.status !== 'AUTO').map((v: any) => {
              const dec = m.visits?.[v.key] ?? (v.status === 'AUTO' ? v.suggestion : undefined);
              return (
                <tr key={v.key} className={`decision-row ${!dec ? 'need' : ''}`}><td><b>{v.project}</b> {v.batch && <span className="muted">{v.batch}</span>}</td><td className="small">{v.reason}</td>
                  <td>{editable ? <select value={encode(dec)} onChange={(e) => decide({ visits: { [v.key]: decode(e.target.value) } })}>
                    <option value="">— choose —</option>{projOptions.map((p: any) => <option key={p.key} value={`P:${p.key}`}>{p.label}</option>)}<option value="SKIP">Do not import</option></select> : null}</td></tr>
              );
            })}</tbody></table>
          </>}

          <h3>Projects</h3>
          <table className="grid tight">
            <thead><tr><th>Prio</th><th>Customer / project</th><th>Order lines</th><th>Tracked units</th><th>Required commissioning</th><th>Demand</th><th>Destination</th><th>Notes</th><th>Import</th></tr></thead>
            <tbody>{rep.projects.map((p: any) => {
              const pd = m.projects?.[p.key] ?? {};
              return (
                <tr key={p.key} className={pd.include === false ? 'dim' : ''}>
                  <td>{p.priority ?? '—'}</td>
                  <td><b>{p.label}</b><div className="small muted">{p.match.status === 'MATCHED' ? `matches ${p.match.code}` : `new: ${p.proposed.code}`} · {p.wave} {p.series}</div></td>
                  <td className="small">{p.lines.map((l: any, i: number) => <div key={i} className={l.product ? '' : 'late'}>{l.quantity}× {l.product ?? '?'} <span className="muted">{l.codes.join(' ')}</span></div>)}</td>
                  <td>{p.trackedUnits}</td>
                  <td className="small">{p.proposed.requiredDate ? <b>{p.proposed.requiredDate}</b> : <span className="muted">indicative{p.proposed.indicativeDate ? ` ≈ ${p.proposed.indicativeDate}` : ''}</span>}<div className="muted wrap">{p.proposed.requiredText}</div></td>
                  <td>{editable && p.match.status === 'NEW' ? <select value={pd.demandStatus ?? p.proposed.demandStatus} onChange={(e) => decide({ projects: { [p.key]: { demandStatus: e.target.value } } })}>
                    {['TENTATIVE', 'APPROVED', 'COMMITTED'].map((d) => <option key={d} value={d} disabled={d === 'COMMITTED' && !p.proposed.requiredDate}>{DEMAND_LABEL[d]}</option>)}</select> : DEMAND_LABEL[p.proposed.demandStatus]}
                    <div className="small muted wrap">{p.proposed.demandReason}</div></td>
                  <td>{editable && p.match.status === 'NEW' ? <select value={pd.country ?? p.proposed.country ?? ''} onChange={(e) => decide({ projects: { [p.key]: { country: e.target.value } } })}>
                    <option value="">— choose —</option>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select> : p.proposed.country}
                    {p.proposed.countrySource === 'ASSUMED' && !pd.country && <div className="small late">assumed</div>}</td>
                  <td className="small wrap">{p.warnings.map((w: string, i: number) => <div key={i}>• {w}</div>)}{p.diffs.map((d: any, i: number) => <div key={`d${i}`} className="late">Δ {d.field}: {String(d.app ?? '—')} → {String(d.tracker ?? '—')}</div>)}</td>
                  <td>{editable && <input type="checkbox" checked={pd.include !== false} onChange={(e) => decide({ projects: { [p.key]: { include: e.target.checked } } })} />}</td>
                </tr>
              );
            })}</tbody>
          </table>

          <details><summary>Unit rows with remarks ({rep.units.filter((u: any) => u.issues.length).length}) and skipped rows ({rep.skippedRows.length})</summary>
            <table className="grid tight"><tbody>
              {rep.units.filter((u: any) => u.issues.length).map((u: any) => <tr key={u.row}><td>row {u.row}</td><td>{u.name}</td><td>{u.product ?? '?'}</td><td className="small">{u.issues.join(' · ')}</td></tr>)}
              {rep.skippedRows.map((s: any) => <tr key={`s${s.row}`} className="dim"><td>row {s.row}</td><td>{s.text}</td><td /><td className="small">{s.reason}</td></tr>)}
            </tbody></table>
          </details>
          <details><summary>Open tracker topics → actions ({rep.openTopics.length})</summary>
            <table className="grid tight"><tbody>{rep.openTopics.map((t: any) => <tr key={t.row}><td>{t.topic}</td><td className="small">{t.status}</td><td className="small">{t.responsible}</td><td className="small">{t.followUp}</td></tr>)}</tbody></table>
          </details>
        </>
      )}
    </div>
  );
}
