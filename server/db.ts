import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facilities_tenant ON facilities(tenant_id);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  service_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_tenant ON departments(tenant_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS question_domains (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  service_type TEXT NOT NULL,
  benchmark_mean REAL NOT NULL DEFAULT 4.0
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  domain_id TEXT NOT NULL REFERENCES question_domains(id) ON DELETE CASCADE,
  text_ar TEXT NOT NULL,
  text_en TEXT NOT NULL,
  answer_type TEXT NOT NULL,
  service_type TEXT NOT NULL,
  requires_alert INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_service ON questions(service_type);

CREATE TABLE IF NOT EXISTS survey_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  service_type TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON survey_templates(tenant_id);

CREATE TABLE IF NOT EXISTS template_questions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES survey_templates(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_template_questions_template ON template_questions(template_id);

CREATE TABLE IF NOT EXISTS survey_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES survey_templates(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  patient_phone_hash TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON survey_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON survey_invitations(token_hash);

CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES survey_invitations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  language TEXT NOT NULL DEFAULT 'ar',
  mode TEXT NOT NULL DEFAULT 'mobile'
);
CREATE INDEX IF NOT EXISTS idx_responses_tenant ON survey_responses(tenant_id);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value_numeric REAL,
  value_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_answers_response ON answers(response_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  redacted_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_tenant ON comments(tenant_id);

CREATE TABLE IF NOT EXISTS comment_analyses (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  sentiment TEXT NOT NULL,
  category TEXT NOT NULL,
  severity INTEGER NOT NULL,
  analyzer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_comment ON comment_analyses(comment_id);

CREATE TABLE IF NOT EXISTS comment_alerts (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  severity INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON comment_alerts(tenant_id);

CREATE TABLE IF NOT EXISTS service_recovery_cases (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  resolution_notes TEXT,
  quality_approved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_tenant ON service_recovery_cases(tenant_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);

CREATE TABLE IF NOT EXISTS proms_instruments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  license_status TEXT NOT NULL,
  description_ar TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proms_instrument_items (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES proms_instruments(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  text_ar TEXT NOT NULL,
  text_en TEXT NOT NULL,
  reverse_scored INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_instrument_items ON proms_instrument_items(instrument_id);

CREATE TABLE IF NOT EXISTS care_pathways (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pathways_tenant ON care_pathways(tenant_id);

CREATE TABLE IF NOT EXISTS pathway_timepoints (
  id TEXT PRIMARY KEY,
  pathway_id TEXT NOT NULL REFERENCES care_pathways(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 14,
  instrument_ids_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timepoints_pathway ON pathway_timepoints(pathway_id);

CREATE TABLE IF NOT EXISTS patient_episodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pathway_id TEXT NOT NULL REFERENCES care_pathways(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  patient_ref_hash TEXT NOT NULL,
  surgeon_ref TEXT,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_episodes_tenant ON patient_episodes(tenant_id);

CREATE TABLE IF NOT EXISTS prom_assignments (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES patient_episodes(id) ON DELETE CASCADE,
  timepoint_id TEXT NOT NULL REFERENCES pathway_timepoints(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL REFERENCES proms_instruments(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS idx_assignments_episode ON prom_assignments(episode_id);

CREATE TABLE IF NOT EXISTS prom_scores (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES prom_assignments(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL REFERENCES proms_instruments(id) ON DELETE CASCADE,
  raw_score REAL NOT NULL,
  band TEXT,
  baseline_score REAL,
  delta REAL,
  mcid_met INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_assignment ON prom_scores(assignment_id);
`;

export function openDatabase(databasePath: string): Db {
  const dir = path.dirname(databasePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
