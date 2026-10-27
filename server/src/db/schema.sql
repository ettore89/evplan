-- EV Production Planner schema. Times on the plan are half-day slots:
-- slot = (days since 1970-01-01) * 2 + (0 = AM, 1 = PM); "finish" slots are exclusive.

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('MANUFACTURING','TESTING','RND','LOGISTICS','COMMERCIAL','SERVICE','MANAGEMENT')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  action text PRIMARY KEY,
  roles text[] NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS regions (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  country text,
  working_weekdays int[] NOT NULL DEFAULT '{1,2,3,4,5}'
);

CREATE TABLE IF NOT EXISTS calendar_holidays (
  id serial PRIMARY KEY,
  calendar_id int NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  date date NOT NULL,
  name text NOT NULL,
  UNIQUE (calendar_id, date)
);

CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  country text NOT NULL,
  region_id int REFERENCES regions(id)
);

CREATE TABLE IF NOT EXISTS work_centers (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  function text NOT NULL,
  capacity numeric(6,2) NOT NULL,
  max_concurrent int NOT NULL,
  min_rate numeric(4,2) NOT NULL DEFAULT 1,
  capacity_model text NOT NULL DEFAULT 'discrete' CHECK (capacity_model IN ('discrete','effective')),
  calendar_id int REFERENCES calendars(id),
  route_order int NOT NULL DEFAULT 0,
  notes text
);

CREATE TABLE IF NOT EXISTS routes (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  origin_country text NOT NULL,
  destination_country text NOT NULL,
  region_id int REFERENCES regions(id),
  lead_time_days int NOT NULL,
  min_days int NOT NULL,
  max_days int NOT NULL,
  operates_saturday boolean NOT NULL DEFAULT true,
  operates_sunday boolean NOT NULL DEFAULT false,
  holiday_calendar_ids int[] NOT NULL DEFAULT '{}',
  release_lag_slots int NOT NULL DEFAULT 0,
  restrictions text
);

CREATE TABLE IF NOT EXISTS product_types (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  family text NOT NULL CHECK (family IN ('POWER_CABINET','DISPENSER','OTHER'))
);

CREATE TABLE IF NOT EXISTS routing_steps (
  id serial PRIMARY KEY,
  product_type_id int NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  seq int NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  function text NOT NULL CHECK (function IN ('MANUFACTURING','TESTING','RND','LOGISTICS','SERVICE')),
  work_center_id int REFERENCES work_centers(id),
  duration_slots int NOT NULL,
  scope text NOT NULL DEFAULT 'unit' CHECK (scope IN ('unit','shipment')),
  kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('work','transport')),
  predecessor_seqs int[],
  milestone_tag text CHECK (milestone_tag IN ('EOL','PACK','COMM')),
  use_destination_calendar boolean NOT NULL DEFAULT false,
  UNIQUE (product_type_id, seq)
);

CREATE TABLE IF NOT EXISTS delay_categories (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  customer_id int NOT NULL REFERENCES customers(id),
  site_location text NOT NULL,
  country text NOT NULL,
  calendar_id int REFERENCES calendars(id),
  route_id int NOT NULL REFERENCES routes(id),
  required_commissioning_date date NOT NULL,
  priority int NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','CANCELLED')),
  plan_status text NOT NULL DEFAULT 'UNPLANNED' CHECK (plan_status IN ('UNPLANNED','FEASIBLE','INFEASIBLE')),
  earliest_commissioning_slot int,
  notes text,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_lines (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_type_id int NOT NULL REFERENCES product_types(id),
  quantity int NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS shipments (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  route_id int NOT NULL REFERENCES routes(id)
);

-- batch_id is reserved for future batch/group planning; batch planning is NOT implemented in the MVP.
CREATE TABLE IF NOT EXISTS units (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  order_line_id int NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id),
  serial text NOT NULL,
  seq int NOT NULL,
  batch_id text
);

CREATE TABLE IF NOT EXISTS activities (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id) ON DELETE CASCADE,
  routing_step_id int REFERENCES routing_steps(id),
  seq int NOT NULL,
  unit_seq int NOT NULL DEFAULT 0,
  code text NOT NULL,
  name text NOT NULL,
  function text NOT NULL,
  work_center_id int REFERENCES work_centers(id),
  calendar_id int REFERENCES calendars(id),
  route_id int REFERENCES routes(id),
  kind text NOT NULL DEFAULT 'work',
  milestone_tag text,
  duration_slots int NOT NULL,
  max_rate numeric(4,2) NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','READY','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  pct_complete int NOT NULL DEFAULT 0,
  assigned_user_id int REFERENCES users(id),
  baseline_start int, baseline_finish int,
  approved_start int, approved_finish int,
  forecast_start int, forecast_finish int,
  actual_start int, actual_finish int,
  expected_finish int,
  locked boolean NOT NULL DEFAULT false,
  blocker text,
  delay_reason text,
  driver jsonb,
  is_critical boolean NOT NULL DEFAULT false,
  capacity_wait_slots int NOT NULL DEFAULT 0,
  weekend_work boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT '{}',
  last_delay_event_id int,
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_project ON activities(project_id);
CREATE INDEX IF NOT EXISTS activities_unit ON activities(unit_id);

CREATE TABLE IF NOT EXISTS dependencies (
  id serial PRIMARY KEY,
  pred_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  succ_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  lag_slots int NOT NULL DEFAULT 0,
  type text NOT NULL DEFAULT 'FS',
  UNIQUE (pred_id, succ_id)
);

-- Current forecast capacity bookings (rebuilt on every recalculation).
CREATE TABLE IF NOT EXISTS reservations (
  activity_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  work_center_id int NOT NULL REFERENCES work_centers(id),
  slot int NOT NULL,
  load numeric(5,2) NOT NULL,
  PRIMARY KEY (activity_id, slot)
);
CREATE INDEX IF NOT EXISTS reservations_wc_slot ON reservations(work_center_id, slot);

CREATE TABLE IF NOT EXISTS weekend_authorizations (
  id serial PRIMARY KEY,
  work_center_id int REFERENCES work_centers(id),
  activity_id int REFERENCES activities(id) ON DELETE CASCADE,
  date date NOT NULL,
  capacity numeric(6,2),
  reason text NOT NULL,
  approved_by int REFERENCES users(id),
  scenario_id int,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (work_center_id IS NOT NULL OR activity_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS milestones (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('EOL','EXW','COMM')),
  baseline_slot int,
  approved_slot int,
  forecast_slot int,
  actual_slot int,
  driving_activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  complete boolean NOT NULL DEFAULT false,
  last_delay_event_id int,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS milestones_unique ON milestones(project_id, type, COALESCE(shipment_id, 0));

CREATE TABLE IF NOT EXISTS milestone_commitments (
  id serial PRIMARY KEY,
  milestone_id int NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  committed_slot int NOT NULL,
  previous_slot int,
  kind text NOT NULL CHECK (kind IN ('BASELINE','APPROVED_CHANGE','OVERRIDE')),
  reason text,
  scenario_id int,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  summary text NOT NULL,
  user_id int REFERENCES users(id),
  scenario_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delay_events (
  id serial PRIMARY KEY,
  activity_id int REFERENCES activities(id) ON DELETE CASCADE,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ROOT','PROPAGATED','CAPACITY','APPROVED_CHANGE','IMPROVEMENT','SYSTEM')),
  root_event_id int REFERENCES delay_events(id),
  origin_activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  category text,
  reason text,
  prev_start int, prev_finish int,
  new_start int, new_finish int,
  impacted_milestones jsonb NOT NULL DEFAULT '[]',
  related_projects jsonb NOT NULL DEFAULT '[]',
  user_id int REFERENCES users(id),
  plan_version int REFERENCES plan_versions(id),
  scenario_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delay_events_activity ON delay_events(activity_id);
CREATE INDEX IF NOT EXISTS delay_events_project ON delay_events(project_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id int REFERENCES activities(id) ON DELETE CASCADE,
  user_id int NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'COMMENT' CHECK (kind IN ('COMMENT','BLOCKER','DECISION','DELAY')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenarios (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','COMMITTED','REJECTED')),
  ops jsonb NOT NULL DEFAULT '[]',
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  base_version int,
  simulated_at timestamptz,
  result jsonb,
  requires_management boolean NOT NULL DEFAULT false,
  requires_reason boolean NOT NULL DEFAULT false,
  frozen_projects jsonb NOT NULL DEFAULT '[]',
  submitted_by int REFERENCES users(id),
  approved_by int REFERENCES users(id),
  approved_at timestamptz,
  justification text,
  committed_version int,
  source text NOT NULL DEFAULT 'USER'
);

CREATE TABLE IF NOT EXISTS plan_snapshots (
  id serial PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'DAILY_CALL' CHECK (kind IN ('DAILY_CALL','MANUAL','COMMIT')),
  plan_version int,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id serial PRIMARY KEY,
  snapshot_id int REFERENCES plan_snapshots(id) ON DELETE SET NULL,
  project_id int REFERENCES projects(id) ON DELETE CASCADE,
  text text NOT NULL,
  owner text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE')),
  user_id int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail.
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id int REFERENCES users(id),
  action text NOT NULL,
  change_class text NOT NULL CHECK (change_class IN ('EXECUTION','APPROVED_CHANGE','OVERRIDE','PRIORITY','CONFIG','FORECAST','COMMERCIAL','SYSTEM')),
  entity_type text NOT NULL,
  entity_id int,
  project_id int,
  scenario_id int,
  plan_version int,
  before jsonb,
  after jsonb,
  reason text
);
CREATE INDEX IF NOT EXISTS audit_project ON audit_events(project_id, ts);

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
