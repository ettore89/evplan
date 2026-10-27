/**
 * Planning-assistant tools. Every number returned here comes from the deterministic
 * scheduling services — the language model only selects tools and phrases answers.
 */
import { pool, tx } from '../db/pool.js';
import { dayOf, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import type { ScenarioOp } from '../engine/scenario.js';
import { can, HttpError, type AuthUser } from '../services/common.js';
import { activitiesFor, capacityView, diffSinceSnapshot, milestoneChain, portfolio } from '../services/read.js';
import { createScenario, evaluate } from '../services/scenarios.js';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: any, user: AuthUser) => Promise<unknown>;
}

async function resolveProject(ref: string | number | undefined) {
  if (ref === undefined || ref === null || ref === '') return null;
  const pf = await portfolio(pool);
  const s = String(ref).trim().toLowerCase();
  let p = pf.projects.find((x) => x.code.toLowerCase() === s || String(x.id) === s || x.name.toLowerCase() === s);
  if (!p) {
    const n = s.match(/(\d+)/)?.[1];
    if (n) p = pf.projects.find((x) => Number(x.code.match(/(\d+)/)?.[1]) === Number(n)) ?? pf.projects.find((x) => x.priority === Number(n));
  }
  if (!p) p = pf.projects.find((x) => x.name.toLowerCase().includes(s) || x.customer.toLowerCase().includes(s));
  if (!p) throw new HttpError(404, `No active project matches "${ref}"`);
  return p;
}

async function resolveWorkCenter(ref: string | number | undefined) {
  if (ref === undefined || ref === null || ref === '') return null;
  const r = await pool.query('SELECT * FROM work_centers');
  const s = String(ref).trim().toLowerCase().replace(/[\s_-]+/g, '');
  const norm = (x: string) => x.toLowerCase().replace(/[\s_/-]+/g, '');
  const w = r.rows.find((x) => String(x.id) === s || norm(x.code) === s || norm(x.name) === s)
    ?? r.rows.find((x) => norm(x.name).includes(s) || norm(x.code).includes(s))
    ?? (s.includes('eol') ? r.rows.find((x) => x.code === 'EOL') : undefined)
    ?? (s.includes('valid') ? r.rows.find((x) => x.code === 'VAL') : undefined)
    ?? (s === 'fa' || s.includes('finalassembly') ? r.rows.find((x) => x.code === 'FA') : undefined);
  if (!w) throw new HttpError(404, `No work center matches "${ref}"`);
  return w;
}

const compactMilestone = (m: any) => ({
  milestone: m.label, forecast: m.forecastLabel, latestCommitted: m.latestApprovedLabel, originalCommitted: m.originalCommittedLabel,
  actual: m.actualLabel || null, varianceWorkingDays: m.varianceDays, risk: m.risk,
  delayCause: m.delay ? `${m.delay.reason} (${m.delay.project} ${m.delay.unit ?? ''} ${m.delay.activity ?? ''})` : null,
});

export const TOOLS: ToolDef[] = [
  {
    name: 'get_portfolio',
    description: 'Prioritized list of all active customer projects with order configuration, the three milestones (EOL Testing Completed, ExWorks Ready, Commissioned) with forecast vs committed dates, variance, risk, freeze status, blockers and progress.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const pf = await portfolio(pool);
      return {
        today: pf.nowLabel,
        projects: pf.projects.map((p) => ({
          priority: p.priority, code: p.code, name: p.name, customer: p.customer, site: `${p.siteLocation} (${p.country})`,
          configuration: p.lines.map((l) => `${l.quantity}× ${l.productName} (${l.productCode})`).join(', '), requiredCommissioning: p.requiredDate,
          planStatus: p.planStatus, progressPct: p.progressPct, risk: p.risk, openBlockers: p.openBlockers, overdueActivities: p.overdue,
          frozen: p.freeze.frozen, freezeStart: p.freeze.freezeStartDate, milestones: p.milestones.map(compactMilestone),
        })),
      };
    },
  },
  {
    name: 'explain_milestone',
    description: 'Explain why a project milestone has its current forecast: returns the driving chain of activities from the milestone back to the originating (root-cause) activity, with delays, capacity constraints and recorded delay reasons.',
    input_schema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project code, id, number or customer name' }, milestone: { type: 'string', enum: ['EOL', 'EXW', 'COMM'] } },
      required: ['project', 'milestone'], additionalProperties: false,
    },
    run: async (i) => {
      const p = (await resolveProject(i.project))!;
      const chain = await milestoneChain(pool, p.id, i.milestone);
      const m = p.milestones.find((x: any) => x.type === i.milestone);
      return {
        project: `${p.code} ${p.name}`, milestone: chain.label, forecast: chain.forecastLabel, committed: m?.latestApprovedLabel,
        originalCommitted: m?.originalCommittedLabel, varianceWorkingDays: m?.varianceDays, risk: m?.risk,
        recordedDelayCause: m?.delay ?? null,
        originatingActivity: chain.nodes.find((n) => n.activityId === chain.originActivityId) ?? null,
        drivingChain: chain.nodes.map((n) => ({
          activity: n.name, unit: n.unit, workCenter: n.workCenter, start: n.startLabel, finish: n.finishLabel, status: n.status,
          constrainedBy: n.driver.type === 'capacity' ? `capacity at work center ${n.workCenter}` : n.driver.type,
          delayVsCommittedHalfDays: n.delaySlots, delayReason: n.lastEvent?.reason ?? null,
        })),
      };
    },
  },
  {
    name: 'find_activities',
    description: 'Search activities in the current plan. Filter by project, work center (e.g. FA, EOL, VAL), status, responsible function, product family (POWER_CABINET or DISPENSER) and a forecast date window (ISO dates, inclusive). Use for questions like "which cabinets are scheduled for FA next week" or "how many units are waiting for validation".',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string' }, workCenter: { type: 'string' },
        status: { type: 'string', enum: ['NOT_STARTED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED', 'OPEN'] },
        function: { type: 'string', enum: ['MANUFACTURING', 'TESTING', 'RND', 'LOGISTICS', 'SERVICE'] },
        family: { type: 'string', enum: ['POWER_CABINET', 'DISPENSER'] },
        from: { type: 'string', description: 'ISO date' }, to: { type: 'string', description: 'ISO date' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: async (i) => {
      const p = await resolveProject(i.project);
      const w = await resolveWorkCenter(i.workCenter);
      const where: string[] = [];
      const params: unknown[] = [];
      if (p) { params.push(p.id); where.push(`a.project_id = $${params.length}`); }
      if (w) { params.push(w.id); where.push(`a.work_center_id = $${params.length}`); }
      if (i.status === 'OPEN') where.push(`a.status NOT IN ('COMPLETED','CANCELLED')`);
      else if (i.status) { params.push(i.status); where.push(`a.status = $${params.length}`); }
      if (i.function) { params.push(i.function); where.push(`a.function = $${params.length}`); }
      const acts = await activitiesFor(pool, where.length ? 'AND ' + where.join(' AND ') : '', params);
      const units = await pool.query(`SELECT u.id, u.serial, pt.family, pt.name FROM units u JOIN order_lines ol ON ol.id = u.order_line_id JOIN product_types pt ON pt.id = ol.product_type_id`);
      const um = new Map(units.rows.map((u) => [u.id, u]));
      const codes = new Map((await portfolio(pool)).projects.map((x) => [x.id, x.code]));
      const from = i.from ? Date.parse(i.from) / 86400000 : -Infinity;
      const to = i.to ? Date.parse(i.to) / 86400000 : Infinity;
      const list = acts.filter((a) => {
        const u = a.unitId ? um.get(a.unitId) : null;
        if (i.family && u?.family !== i.family) return false;
        const s = dayOf(a.actualStart ?? a.forecastStart ?? 0);
        const f = dayOf((a.actualFinish ?? a.forecastFinish ?? 1) - 1);
        return f >= from && s <= to;
      });
      return {
        count: list.length,
        activities: list.slice(0, i.limit ?? 60).map((a) => ({
          project: codes.get(a.projectId), unit: a.unitId ? um.get(a.unitId)?.serial : 'shipment', product: a.unitId ? um.get(a.unitId)?.name : null,
          activity: a.name, workCenter: a.workCenter, status: a.status, start: slotToLabel(a.actualStart ?? a.forecastStart), finish: finishLabel(a.actualFinish ?? a.forecastFinish),
          committedFinish: finishLabel(a.approvedFinish), delayHalfDays: a.delaySlots, critical: a.isCritical, blocker: a.blocker,
        })),
      };
    },
  },
  {
    name: 'get_blockers',
    description: 'Open blockers and delayed activities, optionally limited to one project or to activities feeding ExWorks commitments within the next N days. Ranked by impact on committed milestones.',
    input_schema: { type: 'object', properties: { project: { type: 'string' }, exworksWithinDays: { type: 'number' } }, additionalProperties: false },
    run: async (i) => {
      const p = await resolveProject(i.project);
      const pf = await portfolio(pool);
      const limitDay = i.exworksWithinDays ? dayOf(pf.now) + i.exworksWithinDays : Infinity;
      const projects = pf.projects.filter((x) => (!p || x.id === p.id) && (() => {
        const exw = x.milestones.find((m: any) => m.type === 'EXW');
        return !i.exworksWithinDays || (exw && exw.forecast !== null && dayOf(exw.forecast - 1) <= limitDay);
      })());
      const ids = projects.map((x) => x.id);
      const acts = (await activitiesFor(pool, `AND a.project_id = ANY($1) AND a.status NOT IN ('COMPLETED','CANCELLED')`, [ids]))
        .filter((a) => a.status === 'BLOCKED' || a.delaySlots > 0);
      const codes = new Map(pf.projects.map((x) => [x.id, x]));
      const ranked = acts
        .map((a) => ({ a, score: (a.status === 'BLOCKED' ? 100 : 0) + (a.isCritical ? 50 : 0) + a.delaySlots - (codes.get(a.projectId)?.priority ?? 0) }))
        .sort((x, y) => y.score - x.score);
      return {
        projectsConsidered: projects.map((x) => `${x.code} (ExWorks ${x.milestones.find((m: any) => m.type === 'EXW')?.forecastLabel})`),
        items: ranked.slice(0, 15).map(({ a }) => ({
          project: codes.get(a.projectId)?.code, activity: a.name, workCenter: a.workCenter, status: a.status, blocker: a.blocker,
          delayVsCommittedHalfDays: a.delaySlots, onDrivingPath: a.isCritical, reason: a.lastEvent?.reason ?? a.delayReason ?? null,
        })),
      };
    },
  },
  {
    name: 'capacity_analysis',
    description: 'Work-center capacities, nominal throughput, program bottleneck, upstream starvation, capacity queueing per project, overloads and utilization for the next weeks.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const c = await capacityView(pool, 28);
      const util = new Map<number, { load: number; cap: number }>();
      for (const u of c.utilization) {
        const x = util.get(u.workCenterId) ?? { load: 0, cap: 0 };
        x.load += u.load; x.cap += u.capacity;
        util.set(u.workCenterId, x);
      }
      return {
        bottlenecks: c.bottlenecks.map((b) => ({
          workCenter: b.name, capacity: b.capacity, throughputSystemsPerDay: b.throughputPerDay, programBottleneck: b.isProgramBottleneck,
          starvesDownstream: b.starvesDownstream, additionalCapacityNeededToFeedDownstream: b.additionalCapacityNeeded,
          queueingWorkingDaysInPlan: b.capacityWaitDays, utilizationNext4WeeksPct: Math.round(((util.get(b.workCenterId)?.load ?? 0) / Math.max(1, util.get(b.workCenterId)?.cap ?? 1)) * 100),
        })),
        capacityConflicts: c.conflicts.slice(0, 10),
        overloads: c.overloads.length,
        riskSummary: c.riskSummary,
        proposals: c.proposals,
        eolModelNote: 'EOL testing uses an effective-capacity approximation (1.5 units/half-day, max 2 concurrent, min rate 0.5): two systems may overlap only partially.',
      };
    },
  },
  {
    name: 'simulate_change',
    description: 'Run the deterministic scheduling engine on proposed changes WITHOUT committing them, and return the impact on every project (milestone deltas, delayed/improved projects, displaced activities, freeze impact, violations). Operation types: set_capacity {workCenter, capacity}, move_priority {project, toRank}, pull_in {project}, weekend_work {workCenter, date}.',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['set_capacity', 'move_priority', 'pull_in', 'weekend_work'] },
              workCenter: { type: 'string' }, capacity: { type: 'number' }, project: { type: 'string' }, toRank: { type: 'number' }, date: { type: 'string' },
            },
            required: ['type'],
          },
        },
      },
      required: ['ops'], additionalProperties: false,
    },
    run: async (i, user) => {
      if (!(await can(pool, user, 'scenario.create'))) throw new HttpError(403, `Role ${user.role} cannot run simulations`);
      const ops = await toOps(i.ops);
      const r = await evaluate(pool, ops);
      return summarizeSimulation(r);
    },
  },
  {
    name: 'changes_since_last_call',
    description: 'What changed in the plan since the previous daily operational call snapshot: priority changes, milestone forecast changes, status changes, new blockers and logged decisions/updates.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const d = await diffSinceSnapshot(pool);
      if (!d) return { message: 'No daily-call snapshot exists yet.' };
      return {
        since: d.snapshot, priorityChanges: d.priorityChanges, milestoneChanges: d.milestoneChanges, newBlockers: d.newBlockers,
        statusChanges: d.statusChanges.slice(0, 40), statusChangeCount: d.statusChanges.length, rescheduledActivities: d.rescheduledActivities,
        updates: d.events.slice(0, 30).map((e: any) => ({ at: e.ts, by: e.user_name, action: e.action, project: e.project, class: e.change_class, reason: e.reason })),
      };
    },
  },
  {
    name: 'draft_scenario',
    description: 'Save a proposed change as a DRAFT scenario for human review and approval. Never commits anything. Use after simulate_change when the user asks to draft/propose a change.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } },
      required: ['name', 'ops'], additionalProperties: false,
    },
    run: async (i, user) => {
      const ops = await toOps(i.ops);
      const out = await tx((c) => createScenario(c, user, { name: i.name, description: i.description ?? 'Drafted by AI planning assistant', ops, source: 'AI' }));
      return { scenarioId: out.id, status: 'DRAFT', note: 'Draft created. A Commercial or Management user must review and commit it in Scenario Planning.', impact: summarizeSimulation(out.result) };
    },
  },
];

async function toOps(raw: any[]): Promise<ScenarioOp[]> {
  const ops: ScenarioOp[] = [];
  for (const o of raw ?? []) {
    if (o.type === 'set_capacity') {
      const w = (await resolveWorkCenter(o.workCenter ?? o.workCenterId))!;
      ops.push({ type: 'set_capacity', workCenterId: w.id, capacity: Number(o.capacity) });
    } else if (o.type === 'move_priority') {
      const p = (await resolveProject(o.project ?? o.projectId))!;
      ops.push({ type: 'move_priority', projectId: p.id, toRank: Number(o.toRank) });
    } else if (o.type === 'pull_in') {
      const p = (await resolveProject(o.project ?? o.projectId))!;
      ops.push({ type: 'pull_in', projectId: p.id });
    } else if (o.type === 'weekend_work') {
      const w = (await resolveWorkCenter(o.workCenter ?? o.workCenterId))!;
      ops.push({ type: 'weekend_work', workCenterId: w.id, date: String(o.date) });
    } else throw new HttpError(400, `Unsupported operation ${o.type}`);
  }
  return ops;
}

export function summarizeSimulation(r: Awaited<ReturnType<typeof evaluate>>) {
  return {
    summary: r.summary,
    requiresManagementApproval: r.requiresManagement,
    frozenProjectsImpacted: r.projects.filter((p) => r.frozenImpacted.includes(p.id)).map((p) => p.code),
    violations: r.violations,
    projects: r.projects.filter((p) => p.impacted || p.priorityBefore !== p.priorityAfter).map((p) => ({
      code: p.code, priority: p.priorityBefore === p.priorityAfter ? p.priorityAfter : `${p.priorityBefore} → ${p.priorityAfter}`, frozen: p.frozen,
      EOL: delta(p.milestones.EOL), ExWorks: delta(p.milestones.EXW), Commissioned: delta(p.milestones.COMM), lateVsCustomerDate: p.lateVsRequired,
    })),
  };
}

function delta(m: { beforeLabel: string; afterLabel: string; deltaDays: number }) {
  return m.deltaDays === 0 ? `${m.afterLabel} (no change)` : `${m.beforeLabel} → ${m.afterLabel} (${m.deltaDays > 0 ? '+' : ''}${m.deltaDays} working days)`;
}

export { dayToIso };
