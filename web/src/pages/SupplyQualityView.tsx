import { Fragment, useState } from 'react';
import { api } from '../api';
import { Modal } from '../components/ui';
import { GateStatus } from '../components/v4';
import { useApp, useLive } from '../store';
import { fmtTs } from '../time';

type Tab = 'materials' | 'software' | 'quality' | 'coverage';

/** Critical components, software releases, test records, holds, issues and rework in one place. */
export function SupplyQualityView() {
  const [tab, setTab] = useState<Tab>('materials');
  return (
    <div className="page">
      <div className="toolbar"><h2>Materials · Software · Quality</h2></div>
      <div className="tabs">
        {([['materials', 'Critical components'], ['software', 'Software releases'], ['quality', 'Tests, holds & rework'], ['coverage', 'Test coverage']] as [Tab, string][]).map(([k, l]) =>
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'materials' && <Materials />}
      {tab === 'software' && <Software />}
      {tab === 'quality' && <Quality />}
      {tab === 'coverage' && <Coverage />}
    </div>
  );
}

function Materials() {
  const { can, toast } = useApp();
  const { data, reload } = useLive<any[]>('/materials');
  const [rc, setRc] = useState<any>(null);
  const [open, setOpen] = useState<number | null>(null);
  if (!data) return <div className="muted">Loading…</div>;
  const may = can('material.confirm');
  const saveReceipt = async () => {
    try { await api('/materials/receipts', { body: { materialId: rc.materialId, qty: Number(rc.qty), expectedDate: rc.expectedDate || null, dateConfirmed: rc.dateConfirmed, poRef: rc.poRef || undefined } }); toast('Expected receipt saved — allocations recomputed', 'ok'); setRc(null); reload(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <>
      <p className="hint">Lightweight tracking of critical parts (not MRP): accepted stock and expected receipts are allocated to requirements by project priority and never twice. Unconfirmed receipt dates keep dependent plans open.</p>
      <table className="grid tight">
        <thead><tr><th>Part</th><th>On hand</th><th>Incoming</th><th>Required (open)</th><th>Shortage</th><th>Receipts</th><th /></tr></thead>
        <tbody>{data.map((m: any) => (
          <Fragment key={m.id}>
            <tr className={`clickable ${m.shortage > 0 ? 'row-late' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <td><b>{m.part_number}</b> <span className="muted">{m.description}</span></td><td>{m.onHand}</td><td>{m.incoming}</td><td>{m.required}</td>
              <td>{m.shortage > 0 ? <b className="late">{m.shortage}</b> : '—'}</td>
              <td className="small">{m.receipts.filter((r: any) => !r.received_at).map((r: any) => <span key={r.id} className="pill" title={r.po_ref ?? ''}>{Number(r.qty)} · {r.expected_date ? String(r.expected_date).slice(0, 10) : 'no date'}{r.date_confirmed ? ' ✓' : ' (unconfirmed)'}</span>)}</td>
              <td onClick={(e) => e.stopPropagation()}>{may && <button className="small secondary" onClick={() => setRc({ materialId: m.id, part: m.part_number, qty: 1, expectedDate: '', dateConfirmed: false, poRef: '' })}>+ Receipt</button>}</td>
            </tr>
            {open === m.id && <tr><td colSpan={7}>
              <table className="grid tight"><thead><tr><th>Project</th><th>Unit</th><th>Qty</th><th>Needed at</th><th>Source</th><th>Stock / receipts</th><th>Gate</th></tr></thead>
                <tbody>{m.requirements.map((q: any) => (
                  <tr key={q.id}><td>{q.project}</td><td>{q.unit_name ?? q.internal_id}</td><td>{Number(q.qty)}</td><td>{q.needed_at}</td>
                    <td>{q.source === 'MANUAL' ? <span className="tag-red" title="Outside the BOM: a BOM-correction action was raised">manual</span> : q.source.toLowerCase()}</td>
                    <td>{Number(q.from_stock)} / {Number(q.from_receipts)}</td><td>{q.gate_status && <GateStatus s={q.gate_status} />}</td></tr>
                ))}{!m.requirements.length && <tr><td className="muted" colSpan={7}>No open requirements.</td></tr>}</tbody></table>
            </td></tr>}
          </Fragment>
        ))}</tbody>
      </table>
      {rc && (
        <Modal title={`Expected receipt — ${rc.part}`} onClose={() => setRc(null)}>
          <label className="field">Quantity <input type="number" value={rc.qty} onChange={(e) => setRc({ ...rc, qty: e.target.value })} /></label>
          <label className="field">Expected date <input type="date" value={rc.expectedDate} onChange={(e) => setRc({ ...rc, expectedDate: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={rc.dateConfirmed} onChange={(e) => setRc({ ...rc, dateConfirmed: e.target.checked })} /> Date confirmed by the supplier</label>
          <label className="field">PO reference <input value={rc.poRef} onChange={(e) => setRc({ ...rc, poRef: e.target.value })} /></label>
          <div className="actions"><button onClick={saveReceipt}>Save</button></div>
        </Modal>
      )}
    </>
  );
}

function Software() {
  const { can, toast } = useApp();
  const { data, reload } = useLive<any[]>('/software');
  const [appr, setAppr] = useState<any>(null);
  if (!data) return <div className="muted">Loading…</div>;
  const may = can('release.approve');
  const artifact = async (r: any) => {
    const ref = prompt(`Installation artifact for ${r.version} (file location / package id):`);
    if (!ref) return;
    try { await api(`/software/releases/${r.id}/artifact`, { body: { artifactRef: ref } }); toast('Artifact recorded as available', 'ok'); reload(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <>
      <p className="hint">Candidate → validation → approved for a defined use → artifact available → installed → checks passed. An announcement or expected date never satisfies a readiness gate.</p>
      {data.map((c: any) => (
        <div key={c.id} className="card" style={{ marginBottom: 10 }}>
          <h4>{c.name} <span className="code">{c.code}</span> {c.gates.map((g: any) => <span key={g.status} className="pill"><GateStatus s={g.status} /> {g.n} gates</span>)}</h4>
          <table className="grid tight"><thead><tr><th>Version</th><th>Stage</th><th>Approvals (scope)</th><th>Artifact</th><th>Expected</th><th>Installed / checked</th><th>Known issues</th><th /></tr></thead>
            <tbody>{c.releases.map((r: any) => (
              <tr key={r.id}><td><b>{r.version}</b>{r.isProductionTarget && <span className="pill">production target</span>}</td><td>{r.stage.toLowerCase().replace('_', ' ')}</td>
                <td className="small">{r.approvals.filter((a: any) => !a.revoked_at).map((a: any) => <div key={a.id}>{a.scope.toLowerCase().replace('_', ' ')} · {a.basis_ref} <span className="muted">{a.approved_by_name}</span></div>)}</td>
                <td className="small">{r.artifact_available_at ? `✓ ${r.artifact_ref}` : <span className="muted">not available</span>}</td>
                <td className="small">{r.expected_available_date ? `${String(r.expected_available_date).slice(0, 10)} (not confirmed)` : ''}</td>
                <td>{r.installed} / {r.checked}</td>
                <td className="small wrap">{(r.known_issues ?? []).slice(0, 3).map((k: string, i: number) => <div key={i}>• {k}</div>)}{(r.known_issues ?? []).length > 3 && <div className="muted">+{r.known_issues.length - 3} more</div>}</td>
                <td className="nowrap">{may && <><button className="small secondary" onClick={() => setAppr({ id: r.id, version: r.version, scope: 'PRODUCTION', basisRef: '', makeProductionTarget: true })}>Approve…</button>
                  {!r.artifact_available_at && <button className="small secondary" onClick={() => artifact(r)}>Artifact…</button>}</>}</td></tr>
            ))}</tbody></table>
        </div>
      ))}
      {appr && (
        <Modal title={`Approve ${appr.version} for a defined use`} onClose={() => setAppr(null)}>
          <label className="field">Scope <select value={appr.scope} onChange={(e) => setAppr({ ...appr, scope: e.target.value })}>
            <option value="EVALUATION_UNITS">Evaluation units only</option><option value="PRODUCTION">Production</option><option value="FIELD">Field update</option></select></label>
          <label className="field">Approval basis (evidence) <span className="req">required</span><input value={appr.basisRef} onChange={(e) => setAppr({ ...appr, basisRef: e.target.value })} placeholder="Validation report, test record…" /></label>
          {appr.scope === 'PRODUCTION' && <label className="check"><input type="checkbox" checked={appr.makeProductionTarget} onChange={(e) => setAppr({ ...appr, makeProductionTarget: e.target.checked })} /> Make this the release production must install</label>}
          <div className="actions"><button disabled={appr.basisRef.length < 2} onClick={async () => {
            try { await api(`/software/releases/${appr.id}/approve`, { body: { scope: appr.scope, basisRef: appr.basisRef, makeProductionTarget: appr.makeProductionTarget } }); toast('Release approved for the stated use', 'ok'); setAppr(null); reload(); } catch (e: any) { toast(e.message, 'err'); }
          }}>Approve</button></div>
        </Modal>
      )}
    </>
  );
}

function Quality() {
  const { can, toast } = useApp();
  const { data, reload } = useLive<any>('/quality');
  if (!data) return <div className="muted">Loading…</div>;
  const act = async (path: string, body: any, ok: string) => { try { await api(path, { body }); toast(ok, 'ok'); reload(); } catch (e: any) { toast(e.message, 'err'); } };
  const openHolds = data.holds.filter((h: any) => h.status === 'OPEN');
  const unreleased = data.tests.filter((t: any) => t.status !== 'SUPERSEDED' && (!t.released_at || t.status === 'REVIEW_REQUIRED'));
  return (
    <>
      <h3>Quality holds <span className="count red">{openHolds.length}</span></h3>
      <table className="grid tight"><tbody>{openHolds.map((h: any) => (
        <tr key={h.id}><td><b>{h.project}</b> {h.unit_name ?? h.internal_id}</td><td><span className="tag-red">{h.disposition.toLowerCase().replace('_', ' ')}</span></td><td className="wrap">{h.reason}</td><td className="small">{h.external_ref ?? ''} {h.issue_title ?? ''}</td>
          <td>{can('quality.disposition') && <button className="small secondary" onClick={() => { const n = prompt('Release note (disposition decision)'); if (n) act(`/holds/${h.id}/release`, { note: n }, 'Hold released'); }}>Release…</button>}</td></tr>
      ))}{!openHolds.length && <tr><td className="muted">No open holds.</td></tr>}</tbody></table>
      <h3>Test results awaiting release or review <span className="count">{unreleased.length}</span></h3>
      <p className="hint">Testing performed is not "passed and released". Results obtained before a swap, configuration or firmware change are flagged for review.</p>
      <table className="grid tight"><thead><tr><th>Unit / system</th><th>Test</th><th>Outcome</th><th>Evidence</th><th>Executed</th><th>Status</th><th /></tr></thead>
        <tbody>{unreleased.slice(0, 200).map((t: any) => (
          <tr key={t.id}><td>{t.unit_name ?? t.internal_id ?? t.system_code}</td><td className="small">{t.activity ?? t.plan_code}</td>
            <td><span className={`gs gs-${t.outcome === 'PASS' ? 'READY' : t.outcome === 'FAIL' ? 'BLOCKED' : 'PENDING'}`}>{t.outcome.toLowerCase()}</span></td>
            <td className="small wrap">{t.evidence_ref}</td><td className="small">{fmtTs(t.executed_at)}</td>
            <td className="small">{t.status === 'REVIEW_REQUIRED' ? <span className="tag-red" title={t.review_reason}>review required</span> : 'not released'}</td>
            <td className="nowrap">{can('quality.release') && t.status === 'REVIEW_REQUIRED' && <>
              <button className="small secondary" onClick={() => { const n = prompt('Why is the result still valid?'); if (n) act(`/tests/${t.id}/review`, { decision: 'STILL_VALID', note: n }, 'Marked still valid'); }}>Still valid</button>
              <button className="small secondary" onClick={() => { const n = prompt('Reason to repeat the test'); if (n) act(`/tests/${t.id}/review`, { decision: 'REPEAT', note: n }, 'Retest required'); }}>Repeat</button></>}
              {can('quality.release') && t.status !== 'REVIEW_REQUIRED' && t.outcome === 'PASS' && <button className="small secondary" onClick={() => act(`/tests/${t.id}/release`, {}, 'Result released')}>Release</button>}</td></tr>
        ))}</tbody></table>
      <h3>Rework packages</h3>
      <table className="grid tight"><tbody>{data.rework.map((r: any) => (
        <tr key={r.id}><td><b>{r.project}</b> {r.unit_name ?? r.internal_id}</td><td className="wrap">{r.scope}</td><td className="small">prep {r.prep_slots / 2}d · hands-on {r.hands_on_slots / 2}d · retest {r.retest.toLowerCase()}</td>
          <td className="small">{r.instruction_approved ? `instruction ${r.instruction_ref} ✓` : <span className="tag-red">instruction not approved</span>}</td><td>{r.status.toLowerCase()}</td>
          <td>{!r.instruction_approved && can('quality.disposition') && <button className="small secondary" onClick={() => { const ref = prompt('Approved rework instruction reference'); if (ref) act(`/rework/${r.id}/approve-instruction`, { ref }, 'Instruction approved'); }}>Approve instruction…</button>}</td></tr>
      ))}{!data.rework.length && <tr><td className="muted">No rework packages.</td></tr>}</tbody></table>
      <h3>Issues (external issue management)</h3>
      <p className="hint">Mirrors the external record (e.g. Azure DevOps). Similar symptoms are never merged automatically.</p>
      <table className="grid tight"><tbody>{data.issues.map((i: any) => (
        <tr key={i.id}><td><b>{i.external_ref ?? `#${i.id}`}</b></td><td className="wrap">{i.title}<div className="small muted">{i.symptom}</div></td><td>{i.status.toLowerCase()}</td><td className="small">{i.owner}</td><td className="small">{i.project}</td>
          <td className="small">{(i.units ?? []).map((u: any) => <span key={u.id} className="pill">{u.name ?? u.internalId}</span>)}</td></tr>
      ))}{!data.issues.length && <tr><td className="muted">No issues.</td></tr>}</tbody></table>
      <h3>Test scopes</h3>
      <table className="grid tight"><tbody>{data.plans.map((p: any) => (
        <tr key={p.id}><td><b>{p.code}</b> v{p.version}</td><td>{p.name}</td><td>{p.duration_slots / 2} d</td><td><span className={`gs gs-${p.status === 'APPROVED' ? 'READY' : p.status === 'REJECTED' ? 'BLOCKED' : 'PENDING'}`}>{p.status.toLowerCase()}</span></td><td className="small wrap">{p.rationale}</td>
          <td>{['DRAFT', 'PROPOSED'].includes(p.status) && can('test_scope.approve') && <button className="small secondary" onClick={() => { const n = prompt('Basis for approving this test scope'); if (n) act(`/test-plans/${p.id}/decision`, { decision: 'APPROVED', note: n }, 'Test scope approved'); }}>Approve…</button>}</td></tr>
      ))}</tbody></table>
    </>
  );
}

function Coverage() {
  const { data } = useLive<any>('/quality');
  if (!data) return <div className="muted">Loading…</div>;
  const cls = (v: string | null) => (!v ? '' : /closed/i.test(v) ? 'gs gs-READY' : /ongoing/i.test(v) ? 'gs gs-PENDING' : /to start/i.test(v) ? 'gs gs-UNKNOWN' : '');
  return (
    <>
      <p className="hint">EOL / system test readiness per product module (from the ramp-up tracker or maintained here).</p>
      <table className="grid tight"><thead><tr><th>Product</th><th>Module</th><th>Requirements</th><th>Scripts</th><th>Config</th><th>Test bench</th><th>Handover</th><th>Owner</th><th>Remarks</th></tr></thead>
        <tbody>{data.coverage.map((c: any) => (
          <tr key={c.id}><td><b>{c.product_family}</b></td><td>{c.module}</td>{['requirements', 'scripts', 'config', 'test_bench', 'handover'].map((k) => <td key={k}><span className={cls(c[k])}>{c[k]}</span></td>)}
            <td className="small">{c.owner}</td><td className="small wrap">{c.remarks}</td></tr>
        ))}{!data.coverage.length && <tr><td className="muted" colSpan={9}>No coverage data yet — import the ramp-up tracker.</td></tr>}</tbody></table>
    </>
  );
}
