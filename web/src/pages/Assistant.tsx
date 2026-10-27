import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const SUGGESTIONS = [
  'Why is the ExWorks date for Project 4 delayed?',
  'Which projects are affected by the delay in EOL testing?',
  'What happens if we increase EOL testing capacity from 1.5 to 2?',
  'Which cabinets are scheduled for FA next week?',
  "What are the top five blockers for this week's ExWorks commitments?",
  'Can we reprioritize Project 8 without affecting frozen commitments?',
  'What changed in the plan since yesterday?',
  'How many physical units are waiting for Validation?',
  'Which committed milestones are at risk?',
  'Give me a concise management summary.',
];

/** Tiny markdown renderer: tables, bold/italic, lists, line breaks. */
function Md({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.JSX.Element[] = [];
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/g).map((p, i) =>
    p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('_') && p.endsWith('_') && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      out.push(<table key={i} className="grid tight"><thead><tr>{rows[0].map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>);
    } else if (/^\s*[-*] /.test(l)) out.push(<div key={i} className="li">• {inline(l.replace(/^\s*[-*] /, ''))}</div>);
    else if (/^#+ /.test(l)) out.push(<h4 key={i}>{inline(l.replace(/^#+ /, ''))}</h4>);
    else if (l.trim()) out.push(<p key={i}>{inline(l)}</p>);
  }
  return <div className="md">{out}</div>;
}

export function Assistant() {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string; trace?: any[]; engine?: string }[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { api('/ai/status').then(setStatus); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
  const ask = async (text: string) => {
    if (!text.trim()) return;
    const next = [...msgs, { role: 'user' as const, content: text }];
    setMsgs(next);
    setQ('');
    setBusy(true);
    try {
      const r = await api('/ai/chat', { body: { messages: next.map((m) => ({ role: m.role, content: m.content })).slice(-20) } });
      setMsgs([...next, { role: 'assistant', content: r.answer, trace: r.trace, engine: r.engine }]);
    } catch (e: any) {
      setMsgs([...next, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally { setBusy(false); }
  };
  return (
    <div className="page assistant">
      <div className="toolbar"><h2>AI Planning Assistant</h2>
        <span className="muted small">{status?.engine === 'claude' ? `Claude (${status.model}) with deterministic planning tools` : 'Offline assistant (set ANTHROPIC_API_KEY for natural-language answers)'} · all dates and impacts come from the scheduling engine · simulations never commit</span>
      </div>
      <div className="chat">
        {!msgs.length && <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <Md text={m.content} /> : <p>{m.content}</p>}
            {m.trace && m.trace.length > 0 && <div className="trace small muted">Data sources: {m.trace.map((t, j) => <code key={j} title={JSON.stringify(t.input)}>{t.tool}{t.ok ? '' : ' ✕'}</code>)}{m.engine === 'offline' ? ' · offline' : ''}</div>}
          </div>
        ))}
        {busy && <div className="msg assistant muted">Querying the plan…</div>}
        <div ref={end} />
      </div>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about delays, capacity, priorities, blockers…" />
        <button disabled={busy}>Ask</button>
      </form>
    </div>
  );
}
