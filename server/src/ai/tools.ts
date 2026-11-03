/**
 * Planning-assistant tools. Every number returned here comes from the deterministic
 * scheduling services — the language model only selects tools and phrases answers.
 */
import { pool, tx } from '../db/pool.js';
import { dayOf, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import type { ScenarioOp } from '../engine/scenario.js';
import { can, HttpError, type AuthUser } from '../services/common.js';
import { materialsView } from '../services/materials.js';
import { qualityView } from '../services/quality.js';
import { activitiesFor, capacityView, diffSinceSnapshot, milestoneChain, outboundReview, portfolio, projectDetails } from '../services/read.js';
import { softwareView } from '../services/software.js';
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
  milestone: m.label, scope: m.scopeCode ?? 'project', forecast: m.forecastLabel, latestCommitted: m.latestApprovedLabel, originalCommitted: m.originalCommittedLabel,
  actual: m.actualLabel || null, varianceWorkingDays: m.varianceDays, risk: m.risk, confidence: m.confidence, progress: m.progressLabel || null,
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
          requiredCommissioningText: p.requiredText, demandStatus: p.demandStatus, lifecycle: p.lifecycle,
          planStatus: p.planStatus, planConfidence: p.confidence, progressPct: p.progressPct, risk: p.risk, openBlockers: p.openBlockers, overdueActivities: p.overdue,
          readiness: { unknown: p.readiness.UNKNOWN, pending: p.readiness.PENDING, blocked: p.readiness.BLOCKED, conditionalReleases: p.readiness.conditional, nextBlocker: p.readiness.nextBlocker },
          lastUpdate: p.lastUpdate, heldUnits: p.heldUnits,
          frozen: p.freeze.frozen, freezeStart: p.freeze.freezeStartDate, milestones: p.milestones.map(compactMilestone),
          partialMilestones: p.milestoneParts.map(compactMilestone),
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
        confidence: chain.confidence, recordedDelayCause: m?.delay ?? null,
        originatingIssue: chain.originIssue, responsibleOwner: chain.responsibleOwner, affectedProjects: chain.affectedProjects,
        originatingActivity: chain.nodes.find((n) => n.activityId === chain.originActivityId) ?? null,
        drivingChain: chain.nodes.map((n) => ({
          activity: n.name, unit: n.unit, workCenter: n.workCenter, start: n.startLabel, finish: n.finishLabel, status: n.status, owner: n.owner,
          constrainedBy: n.driver.type === 'capacity' ? `capacity at ${n.workCenter}${n.competingProjects.length ? ` (competing: ${n.competingProjects.join(', ')})` : ''}`
            : n.driver.type === 'gate' && n.gate ? `readiness gate "${n.gate.title}" (${n.gate.status}, owner ${n.gate.owner ?? 'unassigned'}, forecast ${n.gate.forecastLabel || 'undated'})` : n.driver.type,
          confidence: n.confidence, delayVsCommittedHalfDays: n.delaySlots, delayReason: n.lastEvent?.reason ?? null,
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
        family: { type: 'string', enum: ['POWER_CABINET', 'DISPENSER', 'CHARGE_DOCK'] },
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
      const units = await pool.query(`SELECT u.id, COALESCE(u.name, u.serial, u.internal_id) serial, pt.family, pt.name FROM units u JOIN product_types pt ON pt.id = u.product_type_id`);
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
          project: codes.get(a.projectId), scope: a.scope, unit: a.unitId ? um.get(a.unitId)?.serial : a.systemCode ?? a.scope, product: a.unitId ? um.get(a.unitId)?.name : null,
          activity: a.name, workCenter: a.workCenter, status: a.status, start: slotToLabel(a.actualStart ?? a.forecastStart), finish: finishLabel(a.actualFinish ?? a.forecastFinish),
          committedFinish: finishLabel(a.approvedFinish), delayHalfDays: a.delaySlots, critical: a.isCritical, blocker: a.blocker, confidence: a.confidence,
          openGates: a.gates.filter((g: any) => g.status !== 'READY' && !g.awaitingPlan).map((g: any) => `${g.title} (${g.status})`),
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
        reservations: c.reservations ?? [], capacityChanges: c.capacityChanges ?? [],
        eolModelNote: 'EOL test positions and shared HV supply are modelled as separate resources. Unless Testing has approved a phased overlap profile, a conservative provisional profile (no overlap of the shared-supply phase) is used and labelled provisional.',
      };
    },
  },
  {
    name: 'simulate_change',
    description: 'Run the deterministic scheduling engine on proposed changes WITHOUT committing them, and return the impact on every project (milestone deltas, delayed/improved projects, displaced activities, freeze impact, violations). For capacity changes it also returns recoveryPotential: the impact if affected work were allowed to start earlier than currently approved. Operation types: set_capacity {workCenter, capacity, fromDate?}, move_priority {project, toRank}, pull_in {project}, weekend_work {workCenter, date}, commit_demand {project}, add_reservation {workCenter, fromDate, toDate, units, kind} (non-production occupancy such as troubleshooting or regression).',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['set_capacity', 'move_priority', 'pull_in', 'weekend_work', 'commit_demand', 'add_reservation'] },
              workCenter: { type: 'string' }, capacity: { type: 'number' }, project: { type: 'string' }, toRank: { type: 'number' }, date: { type: 'string' },
              fromDate: { type: 'string' }, toDate: { type: 'string' }, units: { type: 'number' },
              kind: { type: 'string', enum: ['TROUBLESHOOTING', 'REGRESSION', 'TEST_DEV', 'SETUP', 'REMOVAL', 'MAINTENANCE', 'OTHER'] },
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
      const r = await evaluate(pool, user, ops);
      const out: any = summarizeSimulation(r);
      if (ops.some((o) => o.type === 'set_capacity' || o.type === 'weekend_work')) {
        // Committed dates are never pulled earlier silently, so also report what the extra capacity could recover.
        out.recoveryPotential = summarizeSimulation(await evaluate(pool, user, ops, { recovery: true }));
      }
      return out;
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
    name: 'get_readiness',
    description: 'Readiness gates (configuration, material, software, resource, quality, external) for a project: owner, status (UNKNOWN/PENDING/READY/BLOCKED — unknown is never treated as ready), required-by, forecast, evidence, last confirmation, conditional releases with scope/conditions/expiry. Use for "what is blocking", "who owns", "is it ready".',
    input_schema: { type: 'object', properties: { project: { type: 'string' }, onlyOpen: { type: 'boolean' } }, required: ['project'], additionalProperties: false },
    run: async (i) => {
      const p = (await resolveProject(i.project))!;
      const r = await pool.query(`SELECT g.*, a.name activity, a.forecast_start, COALESCE(u.name, u.internal_id) unit, s.code system_code FROM readiness_gates g
        JOIN activities a ON a.id = g.activity_id LEFT JOIN units u ON u.id = g.unit_id LEFT JOIN systems s ON s.id = g.system_id
        WHERE g.project_id = $1 AND a.status NOT IN ('COMPLETED','CANCELLED') ORDER BY a.forecast_start NULLS LAST, g.id`, [p.id]);
      const rows = r.rows.filter((g) => !i.onlyOpen || g.status !== 'READY');
      return {
        project: `${p.code} ${p.name}`, planConfidence: p.confidence,
        gates: rows.slice(0, 60).map((g) => ({
          title: g.title, dimension: g.dimension, status: g.status, blocks: g.blocks, activity: g.activity, unitOrSystem: g.unit ?? g.system_code,
          neededFrom: slotToLabel(g.forecast_start), forecast: finishLabel(g.forecast_slot) || (g.status === 'READY' ? null : 'undated (open-ended)'),
          owner: g.owner_name ?? g.owner_role ?? 'unassigned', evidence: g.evidence_ref, lastConfirmed: g.last_confirmed_at, satisfiedByPlannedWork: g.awaiting_plan,
          conditionalRelease: g.conditional_release, notes: g.notes,
        })),
        total: rows.length,
      };
    },
  },
  {
    name: 'get_unit',
    description: 'Physical unit details: stable internal id, serial, name, item code, hardware revision, routing version, location, installed firmware, quality disposition, system/shipment membership and change history (reassignments, swaps, firmware changes).',
    input_schema: { type: 'object', properties: { unit: { type: 'string', description: 'Internal id, serial or unit name' } }, required: ['unit'], additionalProperties: false },
    run: async (i) => {
      const s = String(i.unit).trim();
      const r = await pool.query(`SELECT u.*, p.code project, pt.name product, sy.code system_code, sh.code shipment_code, rv.version routing_version FROM units u
        LEFT JOIN projects p ON p.id = u.project_id JOIN product_types pt ON pt.id = u.product_type_id LEFT JOIN systems sy ON sy.id = u.system_id
        LEFT JOIN shipments sh ON sh.id = u.shipment_id LEFT JOIN routing_versions rv ON rv.id = u.routing_version_id
        WHERE lower(u.internal_id) = lower($1) OR lower(u.serial) = lower($1) OR lower(u.name) = lower($1) OR u.name ILIKE '%' || $1 || '%' LIMIT 5`, [s]);
      if (!r.rows.length) throw new HttpError(404, `No unit matches "${i.unit}"`);
      const u = r.rows[0];
      const sw = await pool.query(`SELECT c.code component, rl.version, us.installed_at, us.checks_passed_at FROM unit_software us JOIN sw_releases rl ON rl.id = us.release_id
        JOIN sw_components c ON c.id = rl.component_id WHERE us.unit_id = $1 AND NOT us.superseded`, [u.id]);
      const hist = await pool.query(`SELECT h.event, h.created_at, h.reason, h.from_value, h.to_value FROM unit_history h WHERE h.unit_id = $1 ORDER BY h.created_at DESC LIMIT 20`, [u.id]);
      const holds = await pool.query(`SELECT disposition, reason, status, created_at FROM quality_holds WHERE unit_id = $1 ORDER BY created_at DESC LIMIT 10`, [u.id]);
      return {
        otherMatches: r.rows.slice(1).map((x) => x.internal_id),
        unit: { internalId: u.internal_id, serial: u.serial, name: u.name, itemCode: u.item_code, product: u.product, hwRevision: u.hw_revision, routingVersion: u.routing_version,
          location: u.location, disposition: u.disposition, status: u.status, project: u.project, system: u.system_code, shipment: u.shipment_code, evaluationUnit: u.evaluation_unit },
        installedSoftware: sw.rows, qualityHolds: holds.rows, history: hist.rows,
      };
    },
  },
  {
    name: 'get_materials',
    description: 'Critical-component status: on-hand stock, incoming receipts (confirmed or unconfirmed dates), open requirements per project/unit and the first operation needing each part, shortages and BOM-correction actions for manual requirements outside the BOM.',
    input_schema: { type: 'object', properties: { project: { type: 'string' }, onlyShort: { type: 'boolean' } }, additionalProperties: false },
    run: async (i) => {
      const p = await resolveProject(i.project);
      const mats = await materialsView(pool);
      return mats
        .map((m: any) => ({ ...m, requirements: m.requirements.filter((q: any) => !p || q.project_id === p.id) }))
        .filter((m: any) => (!p || m.requirements.length) && (!i.onlyShort || m.shortage > 0))
        .map((m: any) => ({
          part: m.part_number, description: m.description, onHand: m.onHand, incoming: m.incoming, required: m.required, shortage: m.shortage,
          receipts: m.receipts.filter((x: any) => !x.received_at).map((x: any) => ({ qty: Number(x.qty), expected: x.expected_date, confirmed: x.date_confirmed, po: x.po_ref })),
          requirements: m.requirements.map((q: any) => ({ project: q.project, unit: q.unit_name ?? q.internal_id, qty: Number(q.qty), neededAt: q.needed_at, source: q.source,
            fromStock: Number(q.from_stock), fromReceipts: Number(q.from_receipts), gateStatus: q.gate_status })),
        }));
    },
  },
  {
    name: 'get_software_releases',
    description: 'Software/firmware components and releases with lifecycle state (candidate, validation, approved for scope, artifact available), approvals with scope, installations and checks passed, and the readiness gates that depend on them. Announcements or plans never satisfy a gate.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => (await softwareView(pool)).map((c: any) => ({
      component: c.code, name: c.name, productionTarget: c.releases.find((r: any) => r.isProductionTarget)?.version ?? null,
      releases: c.releases.map((r: any) => ({ version: r.version, stage: r.stage, artifactAvailable: !!r.artifact_available_at, plannedAvailability: r.expected_available_date,
        approvals: r.approvals.filter((a: any) => !a.revoked_at).map((a: any) => `${a.scope}${a.basis_ref ? ` (${a.basis_ref})` : ''}`), installedUnits: r.installed, checksPassed: r.checked, knownIssues: r.known_issues })),
      gates: c.gates,
    })),
  },
  {
    name: 'get_quality',
    description: 'Quality holds and dispositions, linked issues (external refs such as Azure DevOps), rework packages (prep vs hands-on, station, retest), recent test records and review-required flags, optionally for one project.',
    input_schema: { type: 'object', properties: { project: { type: 'string' } }, additionalProperties: false },
    run: async (i) => {
      const p = await resolveProject(i.project);
      const q = await qualityView(pool, p?.id);
      return {
        openHolds: q.holds.filter((h: any) => h.status === 'OPEN').map((h: any) => ({ unit: h.unit_name ?? h.internal_id, project: h.project, disposition: h.disposition, reason: h.reason, issue: h.external_ref ?? h.issue_title })),
        openIssues: q.issues.filter((x: any) => x.status !== 'CLOSED').slice(0, 30).map((x: any) => ({ ref: x.external_ref, title: x.title, status: x.status, owner: x.owner, project: x.project, units: (x.units ?? []).map((u: any) => u.name ?? u.internalId) })),
        rework: q.rework.filter((r: any) => !['DONE', 'CANCELLED'].includes(r.status)).map((r: any) => ({ unit: r.unit_name ?? r.internal_id, project: r.project, status: r.status, scope: r.scope, instructionApproved: r.instruction_approved, prepHalfDays: r.prep_slots, handsOnHalfDays: r.hands_on_slots, retest: r.retest, issue: r.external_ref })),
        testsNeedingReview: q.tests.filter((t: any) => t.status === 'REVIEW_REQUIRED').map((t: any) => ({ unit: t.unit_name ?? t.internal_id ?? t.system_code, plan: t.plan_code, outcome: t.outcome, released: !!t.released_at, reason: t.review_reason })),
      };
    },
  },
  {
    name: 'outbound_review',
    description: 'Weekly outbound review: shipments reaching ExWorks (packaging complete) in the horizon, service profile and its confirmation status, booking deadlines, transport booked, missing shipping documents, held units, and configuration changes Logistics has not yet acknowledged.',
    input_schema: { type: 'object', properties: { horizonDays: { type: 'number' } }, additionalProperties: false },
    run: async (i) => {
      const o = await outboundReview(pool, i.horizonDays ?? 21);
      return {
        shipments: o.shipments.map((s) => ({ code: s.code, project: s.project, exworks: s.exworksLabel, reached: s.exworksReached, confidence: s.exwConfidence, dispatch: s.dispatchLabel,
          service: s.service, serviceConfirmed: s.serviceStatus, manifestUnits: s.manifest, heldUnits: s.held, transportBooked: s.transportBooked, bookingDeadline: s.bookingDeadline,
          bookingOverdue: s.bookingOverdue, missingDocuments: s.missingDocuments, dispatchBlocked: s.dispatchBlocked })),
        unacknowledgedConfigurationChanges: o.unacknowledgedConfigurationChanges.map((a: any) => ({ project: a.project, title: a.title, raised: a.created_at })),
      };
    },
  },
  {
    name: 'get_project_details',
    description: 'One project in depth: order lines, systems, shipments (manifest, service profile), commissioning visits (site readiness, personnel, site work responsible), units, reconciliation between ordered/built/shipped/commissioned, open actions.',
    input_schema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
    run: async (i) => {
      const p = (await resolveProject(i.project))!;
      const d = await projectDetails(pool, p.id);
      return {
        project: d.project, reconciliation: d.reconciliation,
        systems: d.systems.map((s: any) => ({ code: s.code, status: s.status, visit: s.visit_code })),
        shipments: d.shipments.map((s: any) => ({ code: s.code, service: s.service, serviceConfirmation: s.confirmation_status, units: s.manifest_count, booked: s.transport_booked, documents: (s.documents ?? []).map((x: any) => `${x.doc_type}: ${x.status}`) })),
        visits: d.visits.map((v: any) => ({ code: v.code, site: v.site, installationResponsibility: v.installation_responsibility, executionLead: v.execution_lead_name, personnelConfirmed: v.personnel_confirmed, siteAccessConfirmed: v.site_access_confirmed,
          siteWorkResponsible: v.site_work_responsible, siteWorkResponsibleConfirmed: v.site_work_responsible_confirmed, rdLed: v.rd_led, delegationApprovedBy: v.delegation_approved_by })),
        units: d.units.map((u: any) => ({ internalId: u.internalId, name: u.name, serial: u.serial, product: u.productName, system: u.systemCode, shipment: u.shipmentCode, disposition: u.disposition, location: u.location })),
        openActions: d.actions.filter((a: any) => a.status === 'OPEN').map((a: any) => ({ kind: a.kind, title: a.title, owner: a.owner_name ?? a.owner_role, due: a.due_date })),
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
      const out = await tx((c) => createScenario(c, user, { name: i.name, description: i.description ?? 'Drafted by AI planning assistant', ops: ops as any, source: 'AI' }));
      return { scenarioId: out.id, status: 'DRAFT', note: 'Draft created. A Commercial or Management user must review and commit it in Scenario Planning.', impact: summarizeSimulation(out.result) };
    },
  },
];

async function toOps(raw: any[]): Promise<ScenarioOp[]> {
  const ops: ScenarioOp[] = [];
  for (const o of raw ?? []) {
    if (o.type === 'set_capacity') {
      const w = (await resolveWorkCenter(o.workCenter ?? o.workCenterId))!;
      ops.push({ type: 'set_capacity', workCenterId: w.id, capacity: Number(o.capacity), fromDate: o.fromDate ?? null } as ScenarioOp);
    } else if (o.type === 'move_priority') {
      const p = (await resolveProject(o.project ?? o.projectId))!;
      ops.push({ type: 'move_priority', projectId: p.id, toRank: Number(o.toRank) });
    } else if (o.type === 'pull_in') {
      const p = (await resolveProject(o.project ?? o.projectId))!;
      ops.push({ type: 'pull_in', projectId: p.id });
    } else if (o.type === 'weekend_work') {
      const w = (await resolveWorkCenter(o.workCenter ?? o.workCenterId))!;
      ops.push({ type: 'weekend_work', workCenterId: w.id, date: String(o.date) });
    } else if (o.type === 'commit_demand') {
      const p = (await resolveProject(o.project ?? o.projectId))!;
      ops.push({ type: 'commit_demand', projectId: p.id });
    } else if (o.type === 'add_reservation') {
      const w = (await resolveWorkCenter(o.workCenter ?? o.workCenterId))!;
      const from = Math.floor(Date.parse(o.fromDate ?? o.date) / 86400000) * 2;
      const to = (Math.floor(Date.parse(o.toDate ?? o.fromDate ?? o.date) / 86400000) + 1) * 2;
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError(400, 'add_reservation needs fromDate/toDate (ISO)');
      ops.push({ type: 'add_reservation', workCenterId: w.id, start: from, finish: to, units: Number(o.units ?? 1), kind: o.kind ?? 'OTHER', reason: o.reason } as ScenarioOp);
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
      confidence: Object.fromEntries(Object.entries(p.milestones).filter(([, m]) => m && m.confidenceBefore !== m.confidenceAfter).map(([k, m]) => [k, `${m.confidenceBefore} → ${m.confidenceAfter}`])),
    })),
    impactedShipments: r.impactedShipments, structuralNotes: r.structural.flatMap((x) => [...x.notes, ...x.warnings]),
    requiresReason: r.requiresReason, reasons: r.reasons,
  };
}

function delta(m: { beforeLabel: string; afterLabel: string; deltaDays: number } | undefined) {
  if (!m) return null;
  return m.deltaDays === 0 ? `${m.afterLabel} (no change)` : `${m.beforeLabel} → ${m.afterLabel} (${m.deltaDays > 0 ? '+' : ''}${m.deltaDays} working days)`;
}

export { dayToIso };
