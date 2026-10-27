import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { dayOf, dayToIso, weekday } from '../engine/calendar.js';
import { TOOLS, type ToolDef } from '../ai/tools.js';
import { audit, currentSlot, HttpError, type AuthUser } from '../services/common.js';

const MODEL = process.env.AI_MODEL ?? 'claude-opus-5-5';

const SYSTEM = `You are the planning assistant inside an EV-charging production planning and execution application
(power cabinets and dispensers, from PCBA manufacturing to in-field commissioning).

Rules:
- All dates, capacities, forecasts and scenario impacts MUST come from tool results. Never calculate or estimate schedule dates yourself.
- The three primary milestones are EOL Testing Completed (EOL), ExWorks Ready (EXW = packaging completed for all units) and Commissioned (COMM).
- Variances are in working days against the latest committed (approved) date. Dates ending "AM"/"PM" are half-day slots.
- The program-wide freeze starts 21 calendar days before a project's forecast ExWorks date; changes affecting frozen projects need Management / Program approval.
- You may simulate changes and draft scenarios, but you never commit changes: a human with the right role must approve them.
- Answer concisely for operations managers: lead with the answer, then the evidence (activity, unit, work center, dates). Use short markdown tables or bullet lists when helpful.`;

function toolsForApi(): Anthropic.Tool[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool['input_schema'] }));
}

interface TraceEntry { tool: string; input: unknown; ok: boolean }

async function runTool(t: ToolDef | undefined, input: unknown, user: AuthUser, trace: TraceEntry[]) {
  if (!t) return { content: 'Unknown tool', isError: true };
  try {
    const out = await t.run(input ?? {}, user);
    trace.push({ tool: t.name, input, ok: true });
    return { content: JSON.stringify(out), isError: false };
  } catch (e) {
    trace.push({ tool: t.name, input, ok: false });
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
}

async function claudeAnswer(messages: { role: 'user' | 'assistant'; content: string }[], user: AuthUser) {
  const client = new Anthropic();
  const trace: TraceEntry[] = [];
  const history: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const today = dayToIso(dayOf(await currentSlot(pool)));
  for (let i = 0; i < 10; i++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: `${SYSTEM}\n\nToday is ${today}. The user is ${user.name} (role ${user.role}).`,
      tools: toolsForApi(),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      // Route policy declines to a fallback model inside the same call.
      ...({ fallbacks: 'default' } as Record<string, unknown>),
      messages: history,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    if (response.stop_reason === 'refusal') return { answer: 'The assistant declined to answer this request.', trace, engine: 'claude' };
    if (response.stop_reason === 'pause_turn') {
      history.push({ role: 'assistant', content: response.content });
      continue;
    }
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !uses.length) {
      const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n');
      return { answer: text || '(no answer)', trace, engine: 'claude' };
    }
    history.push({ role: 'assistant', content: response.content });
    const results = await Promise.all(uses.map(async (u) => {
      const r = await runTool(TOOLS.find((t) => t.name === u.name), u.input, user, trace);
      return { type: 'tool_result' as const, tool_use_id: u.id, content: r.content, is_error: r.isError };
    }));
    history.push({ role: 'user', content: results });
  }
  return { answer: 'Stopped after too many tool calls.', trace, engine: 'claude' };
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no API key): intent routing onto the same tools.
// ---------------------------------------------------------------------------
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;

function nextWeek(today: number) {
  const wd = weekday(today);
  const mon = today + ((8 - wd) % 7 || 7);
  return { from: dayToIso(mon), to: dayToIso(mon + 4) };
}
function thisWeek(today: number) {
  const wd = weekday(today);
  const mon = today - ((wd + 6) % 7);
  return { from: dayToIso(mon), to: dayToIso(mon + 6) };
}
const projRef = (q: string) => q.match(/project\s+([a-z0-9-]+)/i)?.[1] ?? q.match(/\b(p-?\d+|prj-?\d+)\b/i)?.[1];
const msOf = (q: string) => (/ex-?works|exw/i.test(q) ? 'EXW' : /eol|end.of.line/i.test(q) ? 'EOL' : /commission/i.test(q) ? 'COMM' : null);
const WC_WORDS: [RegExp, string][] = [
  [/eol|end.of.line|final assembly\s*\/\s*eol/i, 'EOL'], [/validation/i, 'VAL'], [/pre-?commission/i, 'PRECOMM'], [/\bfa\b|final assembly/i, 'FA'],
  [/packag/i, 'PACK'], [/sub-?assembly test/i, 'SUB_TEST'], [/sub-?assembly prog/i, 'SUB_PROG'], [/pcba test/i, 'PCBA_TEST'],
  [/in-?field|commissioning/i, 'COMM'],
];
const wcOf = (q: string) => WC_WORDS.find(([re]) => re.test(q))?.[1] ?? null;

function table(rows: Record<string, unknown>[], cols?: string[]) {
  if (!rows.length) return '_none_';
  const c = cols ?? Object.keys(rows[0]);
  return [`| ${c.join(' | ')} |`, `| ${c.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${c.map((k) => String(r[k] ?? '')).join(' | ')} |`)].join('\n');
}

async function fallbackAnswer(question: string, user: AuthUser) {
  const q = question.toLowerCase();
  const trace: TraceEntry[] = [];
  const call = async (name: string, input: any = {}) => {
    const out = await tool(name).run(input, user);
    trace.push({ tool: name, input, ok: true });
    return out as any;
  };
  const today = dayOf(await currentSlot(pool));
  try {
    if (/^why|delayed|late/.test(q) && msOf(q) && projRef(question)) {
      const r = await call('explain_milestone', { project: projRef(question), milestone: msOf(q) });
      const o = r.originatingActivity;
      const lines = [
        `**${r.milestone} — ${r.project}**: forecast **${r.forecast}** vs committed ${r.committed ?? 'n/a'} (${r.varianceWorkingDays > 0 ? '+' : ''}${r.varianceWorkingDays ?? 0} working days, risk ${r.risk}).`,
      ];
      if (r.recordedDelayCause) lines.push(`Recorded root cause: **${r.recordedDelayCause.reason}** — ${r.recordedDelayCause.activity} on ${r.recordedDelayCause.unit ?? ''} (${r.recordedDelayCause.project}), reported by ${r.recordedDelayCause.user ?? 'system'}.`);
      if (o) lines.push(`Originating activity on the driving path: **${o.name}** (${o.unit}, ${o.workCenter ?? 'logistics'}), ${o.delaySlots / 2} working days later than committed.`);
      else if (!r.varianceWorkingDays) lines.push('The milestone is not delayed against its latest commitment.');
      lines.push('', 'Driving chain (milestone → origin):', table(r.drivingChain.map((n: any) => ({ activity: n.activity, unit: n.unit, finish: n.finish, constrainedBy: n.constrainedBy, delay_halfdays: n.delayVsCommittedHalfDays, reason: n.delayReason ?? '' }))));
      return { answer: lines.join('\n'), trace };
    }
    if (/(increase|raise|add|what if|what happens).*capacity|capacity.*(from|to)\s*\d/.test(q) && wcOf(q)) {
      const to = Number(q.match(/to\s+(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
      const cap = await call('capacity_analysis');
      const w = cap.bottlenecks.find((b: any) => b.workCenter.toLowerCase().includes(wcOf(q) === 'EOL' ? 'eol' : wcOf(q) === 'VAL' ? 'validation' : String(wcOf(q)).toLowerCase())) ?? cap.bottlenecks[0];
      const target = Number.isFinite(to) ? to : w.capacity + (wcOf(q) === 'EOL' ? 0.5 : 1);
      const r = await call('simulate_change', { ops: [{ type: 'set_capacity', workCenter: wcOf(q), capacity: target }] });
      return {
        answer: [`**What-if: ${w.workCenter} capacity ${w.capacity} → ${target}** (simulation only, nothing committed): ${r.summary}.`,
          r.requiresManagementApproval ? `Committing would need Management approval (frozen: ${r.frozenProjectsImpacted.join(', ')}).` : '',
          '', '**Impact on the committed plan** (approved dates are not pulled earlier automatically):', table(r.projects, ['code', 'EOL', 'ExWorks', 'Commissioned']),
          ...(r.recoveryPotential ? ['', `**Recovery potential** if affected work may start earlier than approved: ${r.recoveryPotential.summary}.`, table(r.recoveryPotential.projects, ['code', 'EOL', 'ExWorks', 'Commissioned'])] : []),
          '', 'Capacity changes are a Management / Program decision — open Scenario Planning to commit.'].join('\n'),
        trace,
      };
    }
    if (/reprioriti[sz]e|move .* to (the )?top|priority/.test(q) && projRef(question)) {
      const rank = Number(q.match(/(?:rank|position|priority)\s+(\d+)/)?.[1] ?? 1);
      const r = await call('simulate_change', { ops: [{ type: 'move_priority', project: projRef(question), toRank: rank }] });
      const verdict = r.frozenProjectsImpacted.length
        ? `**No** — it affects frozen commitments of ${r.frozenProjectsImpacted.join(', ')}; Management / Program approval with a justification would be required.`
        : '**Yes** — no frozen project is affected; it still needs simulation review and an authorized commit.';
      return { answer: [`Reprioritizing ${projRef(question)} to rank ${rank}: ${verdict}`, `Impact: ${r.summary}.`, '', table(r.projects, ['code', 'priority', 'frozen', 'ExWorks', 'Commissioned'])].join('\n'), trace };
    }
    if (/what changed|since yesterday|since (the )?(last|previous) call|changes since/.test(q)) {
      const r = await call('changes_since_last_call');
      if (r.message) return { answer: r.message, trace };
      return {
        answer: [`**Changes since "${r.since.label}"** (${new Date(r.since.createdAt).toLocaleString()}):`,
          `- ${r.priorityChanges.length} priority change(s), ${r.milestoneChanges.length} milestone forecast change(s), ${r.statusChangeCount} status change(s), ${r.newBlockers.length} new blocker(s), ${r.rescheduledActivities} rescheduled activities.`,
          '', '**Milestones**', table(r.milestoneChanges.map((m: any) => ({ project: m.project, milestone: m.label, from: m.fromLabel, to: m.toLabel, delta_wd: m.deltaDays }))),
          '', '**New blockers**', table(r.newBlockers.map((b: any) => ({ project: b.project, activity: b.name, blocker: b.blocker }))),
          '', '**Updates logged**', table(r.updates.slice(0, 12).map((u: any) => ({ by: u.by, action: u.action, project: u.project ?? '', reason: u.reason ?? '' })))].join('\n'),
        trace,
      };
    }
    if (/blocker/.test(q)) {
      const input: any = {};
      if (/this week|exworks/.test(q)) input.exworksWithinDays = 7 + (6 - ((weekday(today) + 6) % 7));
      if (projRef(question)) input.project = projRef(question);
      const r = await call('get_blockers', input);
      const n = Number(q.match(/top\s+(\d+)/)?.[1] ?? 10);
      return { answer: [`**Top ${n} blockers / delays**${input.exworksWithinDays ? ' for ExWorks commitments due this week' : ''} (projects: ${r.projectsConsidered.join(', ') || 'none'})`, '',
        table(r.items.slice(0, n).map((i: any) => ({ project: i.project, activity: i.activity, status: i.status, delay_halfdays: i.delayVsCommittedHalfDays, driving: i.onDrivingPath ? 'yes' : '', cause: i.blocker ?? i.reason ?? '' })))].join('\n'), trace };
    }
    if (/scheduled for|next week|this week/.test(q) && wcOf(q)) {
      const win = /this week/.test(q) ? thisWeek(today) : nextWeek(today);
      const input: any = { workCenter: wcOf(q), ...win };
      if (/cabinet/.test(q)) input.family = 'POWER_CABINET';
      if (/dispenser/.test(q)) input.family = 'DISPENSER';
      const r = await call('find_activities', input);
      return { answer: [`**${r.count} ${input.family === 'POWER_CABINET' ? 'cabinet' : input.family === 'DISPENSER' ? 'dispenser' : 'unit'} activities at ${wcOf(q)}** between ${win.from} and ${win.to}:`, '',
        table(r.activities.map((a: any) => ({ project: a.project, unit: a.unit, product: a.product, start: a.start, finish: a.finish, status: a.status })))].join('\n'), trace };
    }
    if (/how many.*(waiting|queue)/.test(q) && wcOf(q)) {
      const ready = await call('find_activities', { workCenter: wcOf(q), status: 'READY' });
      const prog = await call('find_activities', { workCenter: wcOf(q), status: 'IN_PROGRESS' });
      const open = await call('find_activities', { workCenter: wcOf(q), status: 'OPEN' });
      return { answer: [`**${ready.count} physical units are waiting for ${wcOf(q)}** (predecessors complete, not yet started); ${prog.count} in progress; ${open.count} open in total.`, '',
        table(ready.activities.map((a: any) => ({ project: a.project, unit: a.unit, plannedStart: a.start, committedFinish: a.committedFinish })))].join('\n'), trace };
    }
    if (/affected|impact/.test(q) && wcOf(q)) {
      const cap = await call('capacity_analysis');
      const acts = await call('find_activities', { workCenter: wcOf(q), status: 'OPEN' });
      const delayed = acts.activities.filter((a: any) => a.delayHalfDays > 0);
      const projects = [...new Set(delayed.map((a: any) => a.project))];
      const queue = cap.capacityConflicts.filter((c: any) => c.workCenterId && acts.activities.length);
      return { answer: [`**${projects.length} project(s) have delayed ${wcOf(q)} activities:** ${projects.join(', ') || 'none'}.`, '',
        table(delayed.map((a: any) => ({ project: a.project, unit: a.unit, start: a.start, finish: a.finish, committed: a.committedFinish, delay_halfdays: a.delayHalfDays }))),
        queue.length ? `\nCapacity queueing (all work centers): ${queue.slice(0, 6).map((c: any) => `${c.project} waits ${c.waitDays} wd`).join('; ')}` : ''].join('\n'), trace };
    }
    if (/bottleneck|constrain|throughput/.test(q)) {
      const r = await call('capacity_analysis');
      const b = r.bottlenecks.find((x: any) => x.programBottleneck);
      return { answer: [`**Program bottleneck: ${b?.workCenter}** (${b?.throughputSystemsPerDay} systems/day at capacity ${b?.capacity}).`, r.eolModelNote, '',
        table(r.bottlenecks.map((x: any) => ({ workCenter: x.workCenter, capacity: x.capacity, systems_per_day: x.throughputSystemsPerDay, queue_wd: x.queueingWorkingDaysInPlan, util_4w: `${x.utilizationNext4WeeksPct}%`, starves_downstream: x.starvesDownstream ? `+${x.additionalCapacityNeededToFeedDownstream}` : '' })))].join('\n'), trace };
    }
    const pf = await call('get_portfolio');
    if (/risk/.test(q)) {
      const rows = pf.projects.flatMap((p: any) => p.milestones.filter((m: any) => m.risk === 'RED' || m.risk === 'AMBER').map((m: any) => ({ project: p.code, milestone: m.milestone, forecast: m.forecast, committed: m.latestCommitted, variance_wd: m.varianceWorkingDays, risk: m.risk, cause: m.delayCause ?? '' })));
      return { answer: [`**${rows.length} committed milestone(s) at risk:**`, '', table(rows)].join('\n'), trace };
    }
    const red = pf.projects.filter((p: any) => p.risk === 'RED').length;
    return {
      answer: [`**Management summary — ${pf.today}**: ${pf.projects.length} active projects, ${red} at red risk, ${pf.projects.reduce((s: number, p: any) => s + p.openBlockers, 0)} open blockers, ${pf.projects.filter((p: any) => p.frozen).length} inside the ExWorks freeze.`, '',
        table(pf.projects.map((p: any) => ({ '#': p.priority, project: p.code, customer: p.customer, ExWorks: p.milestones.find((m: any) => m.milestone === 'ExWorks Ready')?.forecast, Commissioned: p.milestones.find((m: any) => m.milestone === 'Commissioned')?.forecast, risk: p.risk, frozen: p.frozen ? 'yes' : '' }))),
        '', '_Offline assistant mode (no ANTHROPIC_API_KEY): try "Why is the ExWorks date for Project 4 delayed?", "What happens if we increase EOL testing capacity from 1.5 to 2?", "Top five blockers for this week\'s ExWorks commitments", "What changed since the last call?"_'].join('\n'),
      trace,
    };
  } catch (e) {
    return { answer: `I could not answer that: ${(e as Error).message}`, trace };
  }
}

export function aiRouter() {
  const r = Router();
  r.get('/status', (_req, res) => res.json({ engine: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'claude' : 'offline', model: MODEL }));
  r.post('/chat', async (req, res) => {
    const body = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) })).min(1).max(40) }).parse(req.body);
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') throw new HttpError(400, 'Last message must be from the user');
    const useClaude = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.AI_DISABLED !== '1';
    let out: { answer: string; trace: TraceEntry[]; engine?: string };
    if (useClaude) {
      try {
        out = await claudeAnswer(body.messages, req.user);
      } catch (e) {
        if (e instanceof Anthropic.APIError) {
          const fb = await fallbackAnswer(last.content, req.user);
          out = { ...fb, answer: `${fb.answer}\n\n_(Claude API unavailable: ${e.status ?? ''} ${e.message.slice(0, 120)} — answered by the offline assistant.)_`, engine: 'offline' };
        } else throw e;
      }
    } else out = { ...(await fallbackAnswer(last.content, req.user)), engine: 'offline' };
    await audit(pool, { userId: req.user.id, action: 'ai.query', changeClass: 'SYSTEM', entityType: 'ai', reason: last.content.slice(0, 500), after: { tools: out.trace } });
    res.json(out);
  });
  return r;
}
