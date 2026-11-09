import { useState } from 'react';
import { api } from '../api';
import { ActionList, ConfBadge } from '../components/v4';
import { Modal } from '../components/ui';
import { useApp, useLive } from '../store';
import { fmtTs } from '../time';

const DOC_STATUS = ['MISSING', 'IN_PROGRESS', 'READY', 'NOT_REQUIRED'];

/** Weekly outbound review: ExWorks (packaging complete) is separate from dispatch, transport and site arrival. */
export function OutboundView() {
  const { can, toast } = useApp();
  const [days, setDays] = useState(21);
  const { data, reload } = useLive<any>(`/outbound?days=${days}`, [days]);
  const [edit, setEdit] = useState<any>(null);
  const [doc, setDoc] = useState<any>(null);
  if (!data) return <div className="muted pad">Loading outbound review…</div>;
  const mayEdit = can('logistics.manage');
  const save = async () => {
    try {
      await api(`/shipments/${edit.id}`, { method: 'PATCH', body: { coordinator: edit.coordinator || null, bookingRef: edit.bookingRef || null, transportBooked: edit.transportBooked,
        collectionAt: edit.collectionAt ? new Date(edit.collectionAt).toISOString() : undefined } });
      toast('Shipment updated', 'ok'); setEdit(null); reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const saveDoc = async () => {
    try { await api(`/shipments/${doc.shipmentId}/documents`, { method: 'PUT', body: { docType: doc.doc_type, status: doc.status, ref: doc.ref || null, owner: doc.owner || null, expectedDate: doc.expected_date || null } }); toast('Document updated', 'ok'); setDoc(null); reload(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Weekly outbound review</h2>
        <span className="muted">ExWorks = packaging complete · dispatch, transport and site arrival tracked separately</span>
        <div className="spacer" />
        Horizon <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 21, 42, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
      </div>
      <h3>Booking requests <span className="count">{data.bookingRequests.length}</span> <span className="muted small">raised {data.bookingTrigger.days} {data.bookingTrigger.dayType === 'WORKING' ? 'working' : 'calendar'} days before ExWorks when transport is not booked{data.bookingTrigger.enabled ? '' : ' (trigger switched off)'}</span></h3>
      <ActionList actions={data.bookingRequests} onChanged={reload} />
      <h3>Deliveries reaching ExWorks in the next {days} days</h3>
      <table className="grid tight">
        <thead><tr><th>Shipment</th><th>ExWorks</th><th>Dispatch</th><th>Service profile</th><th>Manifest</th><th>Booking</th><th>Collection</th><th>Documents</th><th>Status</th><th /></tr></thead>
        <tbody>{data.shipments.map((s: any) => (
          <tr key={s.id} className={s.dispatchBlocked || s.bookingOverdue ? 'row-late' : ''}>
            <td><b>{s.code}</b><div className="small muted">#{s.priority} {s.project}</div></td>
            <td className="nowrap">{s.exworksReached ? <b>✓ {s.exworksLabel}</b> : s.exworksLabel} <ConfBadge c={s.exwConfidence} /></td>
            <td className="nowrap small">{s.dispatchLabel}</td>
            <td className="small">{s.service ?? '—'}{s.serviceStatus === 'ASSUMPTION' && <div className="tag-red small" title="Case-specific planning input that Logistics must confirm">assumption — confirm</div>}</td>
            <td className="small">{s.manifest} units{s.held > 0 && <div className="tag-red">{s.held} on quality hold</div>}</td>
            <td className="small">{s.transportBooked ? <>booked {s.bookingRef}</> : <>
              {s.bookingRequestId ? <span className="tag-amber">booking requested</span> : s.bookingTriggerDate && <span className="muted">request on {s.bookingTriggerDate}</span>}
              {s.bookingDeadline && <div className={s.bookingOverdue ? 'late' : ''}>book by {fmtTs(s.bookingDeadline)}</div>}</>}</td>
            <td className="small">{s.collectionAt ? fmtTs(s.collectionAt) : '—'}{s.coordinator && <div className="muted">{s.coordinator}</div>}</td>
            <td className="small">{(s.documents ?? []).map((d: any) => (
              <span key={d.id} className={`pill clickable ${d.status === 'READY' || d.status === 'NOT_REQUIRED' ? '' : 'late'}`} title={`${d.status}${d.ref ? ` · ${d.ref}` : ''}${d.expected_date ? ` · expected ${d.expected_date}` : ''}`}
                onClick={() => mayEdit && setDoc({ ...d, shipmentId: s.id, ref: d.ref ?? '', owner: d.owner ?? '', expected_date: d.expected_date ? String(d.expected_date).slice(0, 10) : '' })}>
                {d.status === 'READY' ? '✓' : d.status === 'NOT_REQUIRED' ? '–' : '✗'} {d.doc_type}</span>))}</td>
            <td className="small">{s.dispatchBlocked ? <span className="tag-red">dispatch blocked</span> : s.exworksReached ? 'ready to dispatch' : ''}</td>
            <td>{mayEdit && <button className="small secondary" onClick={() => setEdit({ id: s.id, code: s.code, coordinator: s.coordinator ?? '', bookingRef: s.bookingRef ?? '', transportBooked: s.transportBooked, collectionAt: s.collectionAt ? String(s.collectionAt).slice(0, 16) : '' })}>Edit</button>}</td>
          </tr>
        ))}{!data.shipments.length && <tr><td colSpan={10} className="muted">No shipment reaches ExWorks in the next {days} days.</td></tr>}</tbody>
      </table>
      <h3>Configuration changes awaiting Logistics acknowledgment</h3>
      <ActionList actions={data.unacknowledgedConfigurationChanges} onChanged={reload} />
      {edit && (
        <Modal title={`Shipment ${edit.code}`} onClose={() => setEdit(null)}>
          <label className="field">Coordinator <input value={edit.coordinator} onChange={(e) => setEdit({ ...edit, coordinator: e.target.value })} /></label>
          <label className="field">Collection (precise time) <input type="datetime-local" value={edit.collectionAt} onChange={(e) => setEdit({ ...edit, collectionAt: e.target.value })} /></label>
          <label className="field">Booking reference <input value={edit.bookingRef} onChange={(e) => setEdit({ ...edit, bookingRef: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={edit.transportBooked} onChange={(e) => setEdit({ ...edit, transportBooked: e.target.checked })} /> Transport booked (reference required)</label>
          <p className="hint">The booking deadline follows from the collection time and the service profile's booking lead time.</p>
          <div className="actions"><button onClick={save}>Save</button></div>
        </Modal>
      )}
      {doc && (
        <Modal title={`${doc.doc_type}`} onClose={() => setDoc(null)}>
          <label className="field">Status <select value={doc.status} onChange={(e) => setDoc({ ...doc, status: e.target.value })}>{DOC_STATUS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="field">Reference {doc.status === 'READY' && <span className="req">required</span>}<input value={doc.ref} onChange={(e) => setDoc({ ...doc, ref: e.target.value })} /></label>
          <label className="field">Owner <input value={doc.owner} onChange={(e) => setDoc({ ...doc, owner: e.target.value })} /></label>
          <label className="field">Expected date <input type="date" value={doc.expected_date} onChange={(e) => setDoc({ ...doc, expected_date: e.target.value })} /></label>
          <div className="actions"><button onClick={saveDoc}>Save</button></div>
        </Modal>
      )}
    </div>
  );
}
