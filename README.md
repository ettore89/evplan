# EV Production Planner

A multi-user production planning & execution application for an EV-charging manufacturer (power cabinets and dispensers), covering the flow from PCBA manufacturing to in-field commissioning. It's the shared operational plan for Commercial, Manufacturing, Testing, R&D, Logistics, Service and Program Management.

* **Backend:** Node 22, TypeScript, Express, PostgreSQL 16, WebSocket (`ws`)
* **Frontend:** React 19, TypeScript, Vite (custom hierarchical Gantt, no chart library)
* **Scheduling engine:** a pure, deterministic TypeScript module (`server/src/engine`) with no database or clock dependencies. It is tested on its own.
* **AI assistant:** Claude (`claude-opus-5-5`) through tool use. It can only call the deterministic planning services. Without an API key, an offline intent router answers the same questions with the same tools.

---

## Quick start

> **Not technical?** Follow the step-by-step guide in [HOW-TO-RUN.md](HOW-TO-RUN.md).

### Option A: Docker Compose

```bash
docker compose up --build
# open http://localhost:4000
```

On an empty database the app migrates the schema and loads master data plus 8 demonstration projects. Set `SEED_DEMO=0` to skip the demo data.

### Option B: Local Node + PostgreSQL

```bash
# PostgreSQL 16 running locally
createuser -s evplan && psql -c "ALTER USER evplan PASSWORD 'evplan'"
createdb -O evplan evplan && createdb -O evplan evplan_test

npm install
npm run seed            # schema + master data + demo projects (re-runnable, wipes data)
npm run build           # web client + server
npm start               # http://localhost:4000
```

Development (hot reload): `npm run dev -w server` (API on :4000) and `npm run dev -w web` (Vite on :5173, proxies `/api` and `/ws`).

### Demo users (password `demo`)

| User | Role |
|---|---|
| `program`, `program2` | Management / Program (full rights, freeze override) |
| `commercial` | Commercial |
| `mfg` | Manufacturing |
| `test` | Testing |
| `rnd` | R&D |
| `logistics` | Logistics |
| `service` | Service |

The login page lists the demo users while `settings.demo_mode` is `true`.

### Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://evplan:evplan@localhost:5432/evplan` | PostgreSQL connection |
| `PORT` | `4000` | HTTP + WebSocket port |
| `JWT_SECRET` | dev value | **Set in production** |
| `ANTHROPIC_API_KEY` | – | Enables Claude for the AI assistant (otherwise offline mode) |
| `AI_MODEL` | `claude-opus-5-5` | Model used by the assistant |
| `RECALC_INTERVAL_MINUTES` | `30` | Periodic forward recalculation as time passes (0 = off) |
| `SEED_DEMO` | `1` | Seed demo data when the database is empty |
| `DATABASE_URL_TEST` | `…/evplan_test` | Database used by the API tests |

All planning parameters (capacities, calendars, routes, durations, freeze horizon, thresholds, permissions) live in the database and can be edited under **Admin**.

---

## Tests

```bash
npm test        # 27 tests: engine (pure) + API acceptance tests against PostgreSQL
```

| Spec test | Where |
|---|---|
| A: initial backward plan (2 cabinets + 4 dispensers) | `engine.test.ts` "Test A", `api.test.ts` "Test A" |
| B: forward delay propagation, driving path vs slack, secondary capacity delays | `engine.test.ts` "Test B" (4 cases) |
| C: EOL effective capacity 1.5, partial overlap, rejected overbooking | `engine.test.ts` "Test C", `api.test.ts` "Test C" |
| D: 3 systems in FA accepted, 4th rejected | `engine.test.ts` "Test D", `api.test.ts` "Test D" (commit returns 422) |
| E: ExWorks complete only when every unit is packed | `engine.test.ts` "Test E / I", `api.test.ts` "Test E / I" |
| F: delay without reason rejected; propagated delays reference the root event | `api.test.ts` "Test F" |
| G: freeze needs Management approval + justification; execution updates still allowed | `api.test.ts` "Test G" |
| H: live call: commit by Program is pushed to a second connected user | `api.test.ts` "Test H" (two WebSocket clients) |
| I: three milestones equal the activity-derived dates | `engine.test.ts` / `api.test.ts` "Test E / I" |
| J: audit of priorities, overrides, delays, forecasts, commitments; audit table is append-only | `api.test.ts` "Test J" |
| K: identical units planned individually, no quantity efficiencies | `engine.test.ts` / `api.test.ts` "Test K" |
| Role enforcement in the backend | `api.test.ts` "enforces role authority" |
| Priority changes alter the plan | `engine.test.ts` "Priority changes…" |
| AI answers come from deterministic services and simulations never commit | `api.test.ts` "AI assistant…" |

---

## Architecture

```
web/ (React)                         server/
  Priority · Gantt · Project ·         src/engine/      pure scheduling engine (no I/O)
  Capacity · Scenarios · Daily ·         calendar.ts     half-day slots, calendars
  AI · Audit · Admin                     scheduler.ts    forward (Mode B), backward (Mode A), capacity ledger
        │  REST /api   ▲ WebSocket /ws   analysis.ts     delay attribution, utilization, bottlenecks
        ▼              │ plan.updated    scenario.ts     scenario ops, comparison
  src/app.ts  ─────────┘                 generate.ts     routing → per-unit activities, freeze rule
  src/services/  state (DB → engine), recalc (persist + delay events), execution, scenarios,
                 projects (Mode A), read models, auth, permissions, audit, realtime
  src/ai/        tools over the services; src/routes/ai.ts = Claude tool loop + offline router
  src/db/        schema.sql, migrate, master data, seed
PostgreSQL       projects → order_lines → units → activities (+ dependencies, reservations),
                 milestones (+ commitments), delay_events, scenarios, plan_versions,
                 plan_snapshots, decisions, audit_events (append-only trigger), config tables
```

Every plan mutation runs in one transaction under a PostgreSQL advisory lock. Each one creates a `plan_versions` row and is broadcast to all connected clients only **after commit**. Clients refetch when the version changes.

---

## Scheduling model

### Time and calendars
* Plan resolution is the **half-day slot**: `slot = days since 1970-01-01 × 2 + (0 AM | 1 PM)`. Finish slots are exclusive.
* Production, test, R&D, packaging and commissioning activities use working calendars (Mon–Fri plus country holidays). The facility calendar is Italy. In-field commissioning uses the destination country's calendar.
* **Weekend/holiday work** happens only through an explicit authorization for a work center or one activity. It is created by a committed scenario (op `weekend_work`) or in Admin. It is shown in the Gantt and consumes the stated capacity.
* **Transport** uses route calendars: Saturday/Sunday operation, country holiday calendars as driving bans, and route lead times. Transport can run on weekends.
* The **21-day freeze** always counts calendar days.

### Data model
`Project → Order line → Physical unit → Activities`. Each unit gets the full routing (13 standard steps, durations per product in `routing_steps`) as its own flow. Shipment is one activity per consolidated delivery and depends on every unit's packaging. Commissioning is per unit and depends on the shipment. `units.batch_id` is reserved for future batch planning. **Batch planning is not implemented.**

### Finite capacity
Each work center has `capacity` (effective units per half-day), `max_concurrent` and `min_rate`:
* Discrete work centers (e.g. FA = 3, Validation = 2) book one unit per system.
* **EOL testing = 1.5 effective units, max 2 concurrent, min rate 0.5.** One system alone tests at full rate. A second system can overlap only on the remaining 0.5 and therefore takes longer. A third cannot start. This approximation is shown in the UI and in `settings.eol_capacity_model`. Phase-level modelling is a deferred extension.
* Bookings never exceed capacity. Manual placements that would exceed it are reported as violations, and the commit is refused. Overloads that come from actual execution (for example two systems already in progress) are listed, never hidden.

### Mode A: initial backward plan
When a project is created, its activities are placed **backward** from the end of the required commissioning day against capacity already reserved by other projects. The result is replayed forward, and the anchor is refined by a shortfall step plus binary search to find the latest plan that still protects the date. If no plan fits after "now", the project is flagged **INFEASIBLE** and the earliest achievable commissioning (an ASAP forward plan) is stored. The accepted plan becomes the **baseline = approved = forecast**, with BASELINE milestone commitments.

### Mode B: forward execution and propagation
Every execution update, scenario commit or time tick recalculates the program forward:
1. Completed work keeps its actuals. In-progress work runs from its actual start, extended by reported delays or blockers, or flagged overdue.
2. Locked commitments reserve their capacity first.
3. Remaining work is scheduled project by project in **approved priority order**. Inside a project it is list-scheduled by earliest start. The earliest start is the latest of: predecessors finished, now, and the **approved start**. Successors are never pulled earlier than approved without an explicit recovery decision.
4. Each activity records its **driver**: predecessor, capacity (with the blocking activities), approved start, not started, reported delay, blocked, overdue, or locked. This drives critical-path highlighting and the milestone cause chain.
5. Changes against the previous forecast become `delay_events`:
   * **ROOT** – user-reported, with a mandatory reason.
   * **SYSTEM** – e.g. start passed without confirmation.
   * **PROPAGATED** and **CAPACITY** – carry `root_event_id` back to the originating delay.
   * **IMPROVEMENT** – an earlier forecast.
   * **APPROVED_CHANGE** – a committed scenario.
   Milestones reference their originating root event as their delay explanation.

### Milestones
* **EOL Testing Completed**: the latest EOL test finish.
* **ExWorks Ready**: the latest packaging finish of the delivery's units. It is not a separate activity.
* **Commissioned**: the latest in-field commissioning finish.

Each milestone keeps its original committed date (baseline), latest approved date, forecast, actual, working-day variance, risk and delay explanation. The full re-commitment history is in `milestone_commitments`, so earlier misses remain visible after re-planning.

### Freeze and governance
* Freeze start = **persisted** forecast ExWorks − `freeze_days` (21) calendar days. For multi-shipment projects the earliest open shipment counts.
* Discretionary changes are scenario ops: priority, activity moves, durations, capacity, weekend work, pull-in, re-plan. A scenario is always simulated first. At commit it is **re-simulated on the current persisted plan** and the freeze check is repeated. A simulated forecast never feeds its own freeze check.
* If a change affects a frozen project: Commercial's commit becomes `PENDING_APPROVAL`, and Management can commit only with a justification. The result is recorded as `OVERRIDE` in the audit and in the milestone commitments.
* Execution updates (status, actuals, blockers, reported delays) are **always** allowed for the responsible function, even inside the freeze, and update the forecast immediately.
* **Mandatory delay reason** when a user marks an activity Blocked, extends its expected completion, completes it after its committed finish, explicitly reports it delayed, or moves it later through a scenario.
* Moving a project **up** in priority releases its approved-start floors, so it really claims scarce capacity earlier. Displaced projects are listed in the impact view and need the matching approval.
* Capacity what-ifs report two views: the impact on the committed plan, and the recovery potential if affected work may start earlier.

### Upstream sizing
**Program & Capacity** compares each work center's nominal throughput with the work center it must feed. That is the configured `sizing_target_id` (subassembly test/programming → Final Assembly), or otherwise the slowest downstream work center. It flags starvation, computes the capacity needed, and shows actual queueing in the plan. Capacity is never increased automatically.

---

## Modules

* **Daily Control**: compact view for the daily call:
  * projects by priority with EOL, ExWorks and Commissioned forecasts
  * today's activities with one-click Start/Done
  * overdue activities, open blockers, owners to chase
  * changes since the previous call (snapshot diff + logged updates)
  * capacity conflicts, decisions needing Management, decisions log
  * presence and a live feed
  * "Start daily call" saves a snapshot; "Recalculate now" runs the engine immediately.
* **Priority View**: the shared ranking (the same order as the Gantt). Drag or ▲▼ to propose a new ranking, which goes through simulate → approve → commit. Shows three milestone cells with original, approved, forecast and actual dates, variance, risk and cause. Click a milestone to see its driving chain.
* **Gantt**:
  * project → unit → activity rows on a half-day grid
  * baseline line, approved box, forecast bar, actual overlay
  * hatched red **delay** extension vs. a blue-edged **approved rescheduling**
  * dependency arrows, driving path, capacity conflicts, freeze window, customer date, E/X/C milestone markers (click to see the cause chain), weekend authorizations, today line
  * department and delay filters
  * Program users can drag a bar; the server validates the move and simulates its impact before commit.
* **Project Details**:
  * commercial data, order configuration, units
  * milestones with explanation
  * activities with per-role edit panel
  * delay events with root links, comments, commitment history, audit
  * required-date change (Commercial), accept forecast as new commitment, backward re-plan (Program)
* **Program & Capacity**: bottlenecks and sizing, utilization heat map, project conflicts, overloads, proposed capacity improvements with simulated impact.
* **Scenarios**: draft → simulate → submit → approve/reject → commit, with full impact comparison, displaced work and freeze status.
* **AI Assistant**: answers delay explanations, root causes, constraining work centers, capacity what-ifs, upcoming work at a work center, blockers, reprioritization checks, changes since the last call, waiting units, risks and summaries. It can save a **draft** scenario. It never commits.
* **Audit**: append-only change log (classes EXECUTION / APPROVED_CHANGE / OVERRIDE / PRIORITY / CONFIG / COMMERCIAL …) and all delay/forecast events.
* **Admin**: users and roles, customers and regions, products, routings and durations, work centers and capacity, calendars and holidays, weekend exceptions, transport routes, delay reasons, approval permissions (role per action) and governance settings (freeze horizon, risk/notification thresholds, priority rules). Changes to planning parameters need a reason and trigger a recalculation.

---

## Scope notes

Not implemented in the MVP, as specified: batch production optimization, ERP/MES integration, phase-level EOL modelling, automated optimization of all work centers, advanced AI optimization, multi-site logistics, materials planning. The schema leaves room for them: `units.batch_id`, work-center capacity models, shipments per project, and routing predecessors as arrays.

Modelling approximations to be aware of:
* EOL partial parallelism uses the effective-units approximation described above.
* Priority allocation is project-by-project (serial schedule generation). Within a project, activities are scheduled by earliest start.
* Transport is not capacity-constrained.
* `settings.clock_override` exists for demos and tests. Leave it `null` in production.
