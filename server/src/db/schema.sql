-- EV Production Planner schema, version 4.
-- Times on the plan are half-day slots: slot = (days since 1970-01-01) * 2 + (0 = AM, 1 = PM);
-- "finish" slots are exclusive. Precise cut-offs (collection, removal deadlines) use timestamptz.

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

-- Narrow technical/administrative authorities granted to named users on top of their role.
CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability text NOT NULL,
  granted_by int REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);

CREATE TABLE IF NOT EXISTS permissions (
  action text PRIMARY KEY,
  roles text[] NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS regions (id serial PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL);

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

-- Resources: station positions, skids, crews, shared infrastructure, field teams.
CREATE TABLE IF NOT EXISTS work_centers (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  function text NOT NULL,
  resource_type text NOT NULL DEFAULT 'STATION' CHECK (resource_type IN ('STATION','POSITION','SKID','PERSONNEL','SHARED','TEAM','AREA')),
  capacity numeric(6,2) NOT NULL,
  calendar_id int REFERENCES calendars(id),
  region text,
  route_order int NOT NULL DEFAULT 0,
  sizing_target_id int REFERENCES work_centers(id),
  provisional boolean NOT NULL DEFAULT false,
  notes text
);

-- Effective-dated capacity. Only IMPLEMENTED/VERIFIED values feed the executable plan.
CREATE TABLE IF NOT EXISTS resource_capacity_changes (
  id serial PRIMARY KEY,
  work_center_id int NOT NULL REFERENCES work_centers(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  capacity numeric(6,2) NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','IMPLEMENTED','VERIFIED','REJECTED')),
  reason text NOT NULL,
  created_by int REFERENCES users(id),
  approved_by int REFERENCES users(id),
  implemented_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Non-production occupancy of a resource.
CREATE TABLE IF NOT EXISTS resource_reservations (
  id serial PRIMARY KEY,
  work_center_id int NOT NULL REFERENCES work_centers(id) ON DELETE CASCADE,
  start_slot int NOT NULL,
  finish_slot int NOT NULL,
  units numeric(6,2) NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('TROUBLESHOOTING','REGRESSION','TEST_DEV','SETUP','REMOVAL','MAINTENANCE','OTHER')),
  reason text NOT NULL,
  project_id int,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','ACTIVE','RELEASED','CANCELLED')),
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finish_slot > start_slot)
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

-- Route/service-specific logistics plan; separates internal preparation, transit, customs and delivery.
CREATE TABLE IF NOT EXISTS service_profiles (
  id serial PRIMARY KEY,
  route_id int NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('ROAD','AIR','SEA','RAIL','COURIER')),
  service_level text NOT NULL DEFAULT 'STANDARD' CHECK (service_level IN ('STANDARD','DEDICATED','EXPRESS')),
  internal_prep_slots int NOT NULL DEFAULT 1,
  transit_days int NOT NULL,
  customs_days int NOT NULL DEFAULT 0,
  final_delivery_days int NOT NULL DEFAULT 0,
  booking_lead_days int NOT NULL DEFAULT 3,
  confirmation_status text NOT NULL DEFAULT 'ASSUMPTION' CHECK (confirmation_status IN ('CONFIRMED','ASSUMPTION')),
  notes text
);

CREATE TABLE IF NOT EXISTS product_types (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  family text NOT NULL CHECK (family IN ('POWER_CABINET','DISPENSER','CHARGE_DOCK','OTHER')),
  item_codes text[] NOT NULL DEFAULT '{}',
  default_hw_revision text
);

-- Dated, versioned routings. template_kind UNIT has a product; SYSTEM/SHIPMENT/VISIT are shared templates.
CREATE TABLE IF NOT EXISTS routing_versions (
  id serial PRIMARY KEY,
  product_type_id int REFERENCES product_types(id) ON DELETE CASCADE,
  template_kind text NOT NULL CHECK (template_kind IN ('UNIT','SYSTEM','SHIPMENT','VISIT')),
  code text NOT NULL,
  version int NOT NULL,
  effective_from date NOT NULL,
  status text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  notes text,
  approved_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS routing_steps (
  id serial PRIMARY KEY,
  routing_version_id int NOT NULL REFERENCES routing_versions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  function text NOT NULL CHECK (function IN ('MANUFACTURING','TESTING','RND','LOGISTICS','SERVICE')),
  work_center_id int REFERENCES work_centers(id),
  duration_slots int NOT NULL,
  scope text NOT NULL CHECK (scope IN ('UNIT','SYSTEM','SHIPMENT','SITE','SITE_SYSTEM')),
  stage text NOT NULL DEFAULT 'PRE' CHECK (stage IN ('PRE','POST')),
  kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('work','transport','calendar','external')),
  predecessor_seqs int[],
  milestone_tag text CHECK (milestone_tag IN ('EOL','PACK','COMM')),
  use_destination_calendar boolean NOT NULL DEFAULT false,
  phases jsonb,
  hold_from jsonb,
  test_plan_code text,
  gate_templates jsonb NOT NULL DEFAULT '[]',
  UNIQUE (routing_version_id, seq)
);

CREATE TABLE IF NOT EXISTS delay_categories (id serial PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  customer_id int NOT NULL REFERENCES customers(id),
  site_location text NOT NULL,
  country text NOT NULL,
  calendar_id int REFERENCES calendars(id),
  route_id int NOT NULL REFERENCES routes(id),
  service_profile_id int REFERENCES service_profiles(id),
  required_commissioning_date date,
  required_commissioning_text text,
  required_exw_text text,
  priority int NOT NULL,
  wave text,
  series text,
  demand_status text NOT NULL DEFAULT 'COMMITTED' CHECK (demand_status IN ('TENTATIVE','APPROVED','COMMITTED')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','CANCELLED')),
  plan_status text NOT NULL DEFAULT 'UNPLANNED' CHECK (plan_status IN ('UNPLANNED','FEASIBLE','INFEASIBLE','IMPORTED','INDICATIVE')),
  plan_confidence text NOT NULL DEFAULT 'FIRM',
  earliest_commissioning_slot int,
  sap_order_ref text,
  o2c_owner text,
  spoc text,
  rationale text,
  customer_situation text,
  mitigations text,
  notes text,
  input_version int NOT NULL DEFAULT 0,
  frozen_since date,
  source text NOT NULL DEFAULT 'MANUAL',
  source_ref text,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Versioned customer configuration (what must be delivered), reconciled against live unit flows.
CREATE TABLE IF NOT EXISTS project_configurations (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version int NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','APPLIED','SUPERSEDED','REJECTED')),
  source text NOT NULL DEFAULT 'MANUAL',
  source_ref text,
  as_of timestamptz,
  scope_text text,
  systems jsonb NOT NULL DEFAULT '[]',
  loose jsonb NOT NULL DEFAULT '[]',
  notes text,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by int REFERENCES users(id),
  approved_at timestamptz,
  applied_at timestamptz,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS order_lines (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_type_id int NOT NULL REFERENCES product_types(id),
  quantity int NOT NULL CHECK (quantity >= 0)
);

CREATE TABLE IF NOT EXISTS shipments (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  seq int NOT NULL DEFAULT 1,
  route_id int NOT NULL REFERENCES routes(id),
  service_profile_id int REFERENCES service_profiles(id),
  destination text,
  coordinator text,
  booking_deadline timestamptz,
  collection_at timestamptz,
  receiving_window_start date,
  receiving_window_end date,
  dims jsonb,
  transport_booked boolean NOT NULL DEFAULT false,
  booking_ref text,
  collected_at timestamptz,
  delivered_at timestamptz,
  frozen_since date,
  notes text
);

CREATE TABLE IF NOT EXISTS shipment_documents (
  id serial PRIMARY KEY,
  shipment_id int NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  status text NOT NULL DEFAULT 'MISSING' CHECK (status IN ('MISSING','IN_PROGRESS','READY','NOT_REQUIRED')),
  owner text,
  ref text,
  expected_date date,
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, doc_type)
);

-- A field intervention covering identified systems at a site.
CREATE TABLE IF NOT EXISTS commissioning_visits (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  site text,
  installation_responsibility text,
  installation_days int NOT NULL DEFAULT 2,
  execution_lead_user_id int REFERENCES users(id),
  execution_lead_name text,
  rd_led boolean NOT NULL DEFAULT false,
  delegation_approved_by int REFERENCES users(id),
  site_work_responsible text,
  site_work_responsible_confirmed boolean NOT NULL DEFAULT false,
  team_resource_id int REFERENCES work_centers(id),
  personnel_confirmed boolean NOT NULL DEFAULT false,
  site_access_confirmed boolean NOT NULL DEFAULT false,
  specialists text,
  roles jsonb NOT NULL DEFAULT '[]',
  planned_dates jsonb NOT NULL DEFAULT '{}',
  notes text
);

CREATE TABLE IF NOT EXISTS systems (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  composition text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','OBSOLETE')),
  visit_id int REFERENCES commissioning_visits(id) ON DELETE SET NULL,
  test_plan_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Physical units with a stable internal identity before the final serial is known.
-- batch_id is reserved for future batch/group planning; batch planning is NOT implemented.
CREATE TABLE IF NOT EXISTS units (
  id serial PRIMARY KEY,
  internal_id text UNIQUE NOT NULL,
  project_id int REFERENCES projects(id) ON DELETE SET NULL,
  order_line_id int REFERENCES order_lines(id) ON DELETE SET NULL,
  system_id int REFERENCES systems(id) ON DELETE SET NULL,
  shipment_id int REFERENCES shipments(id) ON DELETE SET NULL,
  product_type_id int NOT NULL REFERENCES product_types(id),
  item_code text,
  serial text,
  name text,
  seq int NOT NULL DEFAULT 0,
  hw_revision text,
  routing_version_id int REFERENCES routing_versions(id),
  location text,
  disposition text NOT NULL DEFAULT 'RELEASABLE' CHECK (disposition IN ('RELEASABLE','BLOCKED','REWORK_REQUIRED','DEV_ONLY','SCRAPPED')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','OBSOLETE','SPARE')),
  evaluation_unit boolean NOT NULL DEFAULT false,
  batch_id text,
  source text NOT NULL DEFAULT 'PLAN',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS units_project ON units(project_id);

-- Identity, location, allocation, swap and software history of each physical unit (append-only).
CREATE TABLE IF NOT EXISTS unit_history (
  id serial PRIMARY KEY,
  unit_id int NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  event text NOT NULL,
  from_value jsonb,
  to_value jsonb,
  reason text,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id) ON DELETE CASCADE,
  visit_id int REFERENCES commissioning_visits(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'UNIT' CHECK (scope IN ('UNIT','SYSTEM','SHIPMENT','SITE')),
  stage text NOT NULL DEFAULT 'PRE' CHECK (stage IN ('PRE','POST')),
  routing_step_id int REFERENCES routing_steps(id) ON DELETE SET NULL,
  seq int NOT NULL,
  hold_from_seq int,
  hold_resource_id int REFERENCES work_centers(id),
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
  phases jsonb,
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','READY','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  pct_complete int NOT NULL DEFAULT 0,
  progress_slot int,
  assigned_user_id int REFERENCES users(id),
  baseline_start int, baseline_finish int,
  approved_start int, approved_finish int,
  forecast_start int, forecast_finish int,
  actual_start int, actual_finish int,
  expected_finish int,
  deadline_at timestamptz,
  locked boolean NOT NULL DEFAULT false,
  blocker text,
  delay_reason text,
  driver jsonb,
  confidence text NOT NULL DEFAULT 'FIRM',
  confidence_gates int[] NOT NULL DEFAULT '{}',
  is_critical boolean NOT NULL DEFAULT false,
  capacity_wait_slots int NOT NULL DEFAULT 0,
  weekend_work boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT '{}',
  rework_id int,
  source text NOT NULL DEFAULT 'PLAN',
  last_delay_event_id int,
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_project ON activities(project_id);
CREATE INDEX IF NOT EXISTS activities_unit ON activities(unit_id);
CREATE INDEX IF NOT EXISTS activities_system ON activities(system_id);

CREATE TABLE IF NOT EXISTS dependencies (
  id serial PRIMARY KEY,
  pred_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  succ_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  lag_slots int NOT NULL DEFAULT 0,
  type text NOT NULL DEFAULT 'FS',
  UNIQUE (pred_id, succ_id)
);

-- The successor keeps a resource held from the end of from_activity until it starts.
CREATE TABLE IF NOT EXISTS activity_holds (
  id serial PRIMARY KEY,
  activity_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  from_activity_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  work_center_id int NOT NULL REFERENCES work_centers(id),
  units numeric(6,2) NOT NULL DEFAULT 1
);

-- Current forecast resource bookings (rebuilt on every recalculation).
CREATE TABLE IF NOT EXISTS reservations (
  activity_id int NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  work_center_id int NOT NULL REFERENCES work_centers(id),
  slot int NOT NULL,
  load numeric(6,2) NOT NULL,
  PRIMARY KEY (activity_id, work_center_id, slot)
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

-- Readiness prerequisites. Unknown readiness is never green.
CREATE TABLE IF NOT EXISTS readiness_gates (
  id serial PRIMARY KEY,
  project_id int REFERENCES projects(id) ON DELETE CASCADE,
  activity_id int REFERENCES activities(id) ON DELETE CASCADE,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id) ON DELETE CASCADE,
  visit_id int REFERENCES commissioning_visits(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN ('CONFIGURATION','MATERIAL','SOFTWARE','RESOURCE','QUALITY','EXTERNAL')),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','PENDING','READY','BLOCKED')),
  blocks text NOT NULL DEFAULT 'START' CHECK (blocks IN ('START','COMPLETE')),
  owner_role text,
  owner_name text,
  owner_user_id int REFERENCES users(id),
  required_by_slot int,
  forecast_slot int,
  evidence_ref text,
  last_confirmed_at timestamptz,
  last_confirmed_by int REFERENCES users(id),
  source_type text NOT NULL DEFAULT 'MANUAL',
  source_id int,
  spec jsonb NOT NULL DEFAULT '{}',
  -- resolves through activities already in this plan (e.g. a test release after the planned test): not a date constraint
  awaiting_plan boolean NOT NULL DEFAULT false,
  conditional_release jsonb,
  notes text,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gates_activity ON readiness_gates(activity_id);
CREATE INDEX IF NOT EXISTS gates_source ON readiness_gates(source_type, source_id);

-- Lightweight critical-component tracking (not MRP).
CREATE TABLE IF NOT EXISTS materials (
  id serial PRIMARY KEY,
  part_number text UNIQUE NOT NULL,
  description text NOT NULL,
  critical boolean NOT NULL DEFAULT true,
  uom text NOT NULL DEFAULT 'pcs'
);

CREATE TABLE IF NOT EXISTS material_stock (
  id serial PRIMARY KEY,
  material_id int NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  location text NOT NULL,
  qty_on_hand numeric(10,2) NOT NULL DEFAULT 0,
  as_of timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, location)
);

CREATE TABLE IF NOT EXISTS material_receipts (
  id serial PRIMARY KEY,
  material_id int NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty numeric(10,2) NOT NULL,
  expected_date date,
  date_confirmed boolean NOT NULL DEFAULT false,
  received_at timestamptz,
  accepted boolean NOT NULL DEFAULT false,
  location text,
  po_ref text,
  as_of timestamptz NOT NULL DEFAULT now()
);

-- Engineering BOM master (imported). Missing requirements are corrected through action items, not edited silently.
CREATE TABLE IF NOT EXISTS bom_items (
  id serial PRIMARY KEY,
  product_type_id int NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  material_id int NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty_per_unit numeric(10,2) NOT NULL,
  needed_at_code text NOT NULL,
  UNIQUE (product_type_id, material_id)
);

CREATE TABLE IF NOT EXISTS material_requirements (
  id serial PRIMARY KEY,
  project_id int REFERENCES projects(id) ON DELETE CASCADE,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  material_id int NOT NULL REFERENCES materials(id),
  qty numeric(10,2) NOT NULL,
  needed_at_activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'BOM' CHECK (source IN ('BOM','MANUAL','REWORK')),
  bom_correction_action_id int,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONSUMED','CANCELLED')),
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reservation of stock or an expected receipt for a requirement; the same quantity can never be allocated twice.
CREATE TABLE IF NOT EXISTS material_allocations (
  id serial PRIMARY KEY,
  requirement_id int NOT NULL REFERENCES material_requirements(id) ON DELETE CASCADE,
  stock_id int REFERENCES material_stock(id) ON DELETE CASCADE,
  receipt_id int REFERENCES material_receipts(id) ON DELETE CASCADE,
  qty numeric(10,2) NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((stock_id IS NULL) <> (receipt_id IS NULL))
);

CREATE TABLE IF NOT EXISTS sw_components (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FIRMWARE','FPGA','SOFTWARE','TOOL','CONFIG_PACKAGE')),
  product_family text,
  production_release_id int
);

-- Candidate → validation → approved for defined use → artifact available → installed → checks passed.
CREATE TABLE IF NOT EXISTS sw_releases (
  id serial PRIMARY KEY,
  component_id int NOT NULL REFERENCES sw_components(id) ON DELETE CASCADE,
  version text NOT NULL,
  stage text NOT NULL DEFAULT 'CANDIDATE' CHECK (stage IN ('CANDIDATE','IN_VALIDATION','APPROVED','REJECTED','SUPERSEDED')),
  expected_available_date date,
  artifact_ref text,
  artifact_available_at timestamptz,
  known_issues jsonb NOT NULL DEFAULT '[]',
  notes text,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_id, version)
);

CREATE TABLE IF NOT EXISTS sw_release_approvals (
  id serial PRIMARY KEY,
  release_id int NOT NULL REFERENCES sw_releases(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('EVALUATION_UNITS','SPECIFIC_UNITS','PRODUCTION','FIELD')),
  unit_ids int[] NOT NULL DEFAULT '{}',
  basis_ref text,
  approved_by int REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  valid_until date,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS unit_software (
  id serial PRIMARY KEY,
  unit_id int NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  release_id int NOT NULL REFERENCES sw_releases(id),
  approval_id int REFERENCES sw_release_approvals(id),
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by int REFERENCES users(id),
  checks_passed_at timestamptz,
  checks_by int REFERENCES users(id),
  superseded boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS test_plans (
  id serial PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  version int NOT NULL,
  scope text NOT NULL CHECK (scope IN ('UNIT','SYSTEM')),
  duration_slots int NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PROPOSED','APPROVED','RETIRED','REJECTED')),
  rationale text,
  approved_by int REFERENCES users(id),
  approved_at timestamptz,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

-- Execution status and test outcome are separate: "testing performed" is not "passed and released".
CREATE TABLE IF NOT EXISTS test_records (
  id serial PRIMARY KEY,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  test_plan_id int REFERENCES test_plans(id),
  outcome text NOT NULL CHECK (outcome IN ('PASS','FAIL','INCONCLUSIVE')),
  evidence_ref text,
  executed_at timestamptz NOT NULL DEFAULT now(),
  recorded_by int REFERENCES users(id),
  released_by int REFERENCES users(id),
  released_at timestamptz,
  status text NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','REVIEW_REQUIRED','SUPERSEDED')),
  review_reason text,
  sw_release_id int REFERENCES sw_releases(id)
);

-- EOL / system test coverage readiness per product module (e.g. imported from the ramp-up tracker).
CREATE TABLE IF NOT EXISTS test_coverage (
  id serial PRIMARY KEY,
  product_family text NOT NULL,
  module text NOT NULL,
  requirements text, scripts text, config text, test_bench text,
  handover text,
  owner text,
  remarks text,
  source text NOT NULL DEFAULT 'MANUAL',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_family, module)
);

-- Issues mirror the external issue-management record (e.g. Azure DevOps); similar symptoms are never merged automatically.
CREATE TABLE IF NOT EXISTS issues (
  id serial PRIMARY KEY,
  external_ref text,
  title text NOT NULL,
  symptom text,
  root_cause text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','CLOSED')),
  owner text,
  project_id int REFERENCES projects(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'MANUAL',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS issue_units (
  issue_id int NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  unit_id int NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, unit_id)
);

CREATE TABLE IF NOT EXISTS quality_holds (
  id serial PRIMARY KEY,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  disposition text NOT NULL CHECK (disposition IN ('BLOCKED','REWORK_REQUIRED','DEV_ONLY')),
  reason text NOT NULL,
  issue_id int REFERENCES issues(id),
  gate_id int,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RELEASED')),
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by int REFERENCES users(id),
  released_at timestamptz,
  release_note text
);

-- Rework is scheduled work: preparation, hands-on repair and retest consume real resources.
CREATE TABLE IF NOT EXISTS rework_packages (
  id serial PRIMARY KEY,
  project_id int REFERENCES projects(id) ON DELETE CASCADE,
  unit_id int REFERENCES units(id) ON DELETE CASCADE,
  system_id int REFERENCES systems(id) ON DELETE CASCADE,
  issue_id int REFERENCES issues(id),
  scope text NOT NULL,
  instruction_ref text,
  instruction_approved boolean NOT NULL DEFAULT false,
  instruction_approved_by int REFERENCES users(id),
  station_resource_id int REFERENCES work_centers(id),
  personnel_resource_id int REFERENCES work_centers(id),
  prep_slots int NOT NULL DEFAULT 1,
  hands_on_slots int NOT NULL DEFAULT 1,
  retest text NOT NULL DEFAULT 'EOL' CHECK (retest IN ('NONE','EOL','VALIDATION')),
  parts jsonb NOT NULL DEFAULT '[]',
  owner text,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','PLANNED','IN_PROGRESS','DONE','CANCELLED')),
  insert_before_activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_items (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('BOM_CORRECTION','LOGISTICS_ACK','RETEST_REVIEW','EXPLANATION_REQUIRED','RECONCILIATION','GENERAL')),
  title text NOT NULL,
  details text,
  project_id int REFERENCES projects(id) ON DELETE CASCADE,
  owner_role text,
  owner_name text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','DONE','CANCELLED')),
  due_date date,
  related jsonb NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'SYSTEM',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by int REFERENCES users(id),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS milestones (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shipment_id int REFERENCES shipments(id) ON DELETE CASCADE,
  visit_id int REFERENCES commissioning_visits(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('EOL','EXW','COMM')),
  baseline_slot int,
  approved_slot int,
  forecast_slot int,
  actual_slot int,
  driving_activity_id int REFERENCES activities(id) ON DELETE SET NULL,
  complete boolean NOT NULL DEFAULT false,
  confidence text NOT NULL DEFAULT 'FIRM',
  done int NOT NULL DEFAULT 0,
  total int NOT NULL DEFAULT 0,
  last_delay_event_id int,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS milestones_unique ON milestones(project_id, type, COALESCE(shipment_id, 0), COALESCE(visit_id, 0));

CREATE TABLE IF NOT EXISTS milestone_commitments (
  id serial PRIMARY KEY,
  milestone_id int NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  committed_slot int NOT NULL,
  previous_slot int,
  kind text NOT NULL CHECK (kind IN ('BASELINE','APPROVED_CHANGE','OVERRIDE','IMPORTED')),
  confidence text NOT NULL DEFAULT 'FIRM',
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
  kind text NOT NULL CHECK (kind IN ('ROOT','PROPAGATED','CAPACITY','APPROVED_CHANGE','IMPROVEMENT','SYSTEM','EXPLANATION_REQUIRED')),
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
  input_versions jsonb NOT NULL DEFAULT '{}',
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

-- Controlled imports: previewed, reconciled and explicitly applied.
CREATE TABLE IF NOT EXISTS import_batches (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('OM_TRACKER','ORDERS','MATERIALS')),
  filename text,
  status text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','DISCARDED')),
  as_of timestamptz,
  parsed jsonb,
  report jsonb,
  mapping jsonb NOT NULL DEFAULT '{}',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by int REFERENCES users(id),
  applied_at timestamptz
);

-- Remembered name resolutions (e.g. a tracker text "ACME Grp" → project "ACME Retail DE").
CREATE TABLE IF NOT EXISTS name_aliases (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PROJECT','PRODUCT')),
  alias text NOT NULL,
  target_id int NOT NULL,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, alias)
);

-- Append-only audit trail.
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id int REFERENCES users(id),
  action text NOT NULL,
  change_class text NOT NULL CHECK (change_class IN ('EXECUTION','APPROVED_CHANGE','OVERRIDE','PRIORITY','CONFIG','FORECAST','COMMERCIAL','SYSTEM','READINESS','QUALITY','MATERIAL','SOFTWARE','LOGISTICS','IMPORT')),
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
