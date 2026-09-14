import type { Migration } from "./types.js";

const INITIAL_SCHEMA_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  git_root TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE terminals (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  shell TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  terminal_id TEXT REFERENCES terminals(id),
  host TEXT NOT NULL,
  agent_version TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('on', 'off')),
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  parent_request_id TEXT REFERENCES requests(id),
  provider TEXT,
  model TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('on', 'off')),
  raw_bytes INTEGER CHECK (raw_bytes IS NULL OR raw_bytes >= 0),
  sent_bytes INTEGER CHECK (sent_bytes IS NULL OR sent_bytes >= 0),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE (session_id, sequence)
);

CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  raw_input_tokens INTEGER CHECK (raw_input_tokens IS NULL OR raw_input_tokens >= 0),
  sent_input_tokens INTEGER CHECK (sent_input_tokens IS NULL OR sent_input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  context_window INTEGER CHECK (context_window IS NULL OR context_window > 0),
  raw_input_accuracy TEXT CHECK (raw_input_accuracy IS NULL OR raw_input_accuracy IN ('actual', 'estimated', 'derived')),
  sent_input_accuracy TEXT CHECK (sent_input_accuracy IS NULL OR sent_input_accuracy IN ('actual', 'estimated', 'derived')),
  cached_input_accuracy TEXT CHECK (cached_input_accuracy IS NULL OR cached_input_accuracy IN ('actual', 'estimated', 'derived')),
  output_accuracy TEXT CHECK (output_accuracy IS NULL OR output_accuracy IN ('actual', 'estimated', 'derived')),
  context_window_accuracy TEXT CHECK (context_window_accuracy IS NULL OR context_window_accuracy IN ('actual', 'estimated', 'derived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE cold_objects (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE cold_object_references (
  id TEXT PRIMARY KEY,
  cold_object_id TEXT NOT NULL REFERENCES cold_objects(id),
  session_id TEXT REFERENCES sessions(id),
  project_id TEXT REFERENCES projects(id),
  category TEXT NOT NULL,
  raw_tokens INTEGER CHECK (raw_tokens IS NULL OR raw_tokens >= 0),
  compressed_tokens INTEGER CHECK (compressed_tokens IS NULL OR compressed_tokens >= 0),
  compressor TEXT,
  compression_mode TEXT,
  source_tool TEXT,
  source_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT
);

CREATE TABLE compression_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  cold_object_reference_id TEXT REFERENCES cold_object_references(id),
  category TEXT NOT NULL,
  compressor TEXT NOT NULL,
  compression_mode TEXT NOT NULL,
  raw_tokens INTEGER CHECK (raw_tokens IS NULL OR raw_tokens >= 0),
  compressed_tokens INTEGER CHECK (compressed_tokens IS NULL OR compressed_tokens >= 0),
  compression_ms REAL CHECK (compression_ms IS NULL OR compression_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  class TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  source_uri TEXT,
  supersedes_id TEXT REFERENCES memory_items(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  memory_item_id TEXT REFERENCES memory_items(id),
  decision TEXT NOT NULL,
  reason TEXT,
  rejected TEXT,
  status TEXT NOT NULL,
  source_uri TEXT,
  supersedes_id TEXT REFERENCES decisions(id),
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE recalls (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  cold_object_id TEXT REFERENCES cold_objects(id),
  query_kind TEXT NOT NULL,
  query_value TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT
);

CREATE TABLE benchmarks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  baseline_session_id TEXT REFERENCES sessions(id),
  comparison_session_id TEXT REFERENCES sessions(id),
  fixture TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  scope TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (agent, scope)
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  installation_id TEXT REFERENCES installations(id),
  source_path TEXT NOT NULL,
  backup_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  restored_at TEXT
);

CREATE INDEX terminals_project_id_idx ON terminals(project_id);
CREATE INDEX sessions_project_started_idx ON sessions(project_id, started_at);
CREATE INDEX sessions_terminal_started_idx ON sessions(terminal_id, started_at);
CREATE INDEX requests_session_started_idx ON requests(session_id, started_at);
CREATE INDEX compression_events_request_idx ON compression_events(request_id);
CREATE INDEX cold_object_references_object_idx ON cold_object_references(cold_object_id);
CREATE INDEX cold_object_references_project_idx ON cold_object_references(project_id, created_at);
CREATE INDEX cold_object_references_session_idx ON cold_object_references(session_id, created_at);
CREATE INDEX cold_object_references_expiry_idx ON cold_object_references(expires_at);
CREATE INDEX memory_items_project_class_idx ON memory_items(project_id, class, status);
CREATE INDEX decisions_project_status_idx ON decisions(project_id, status);
CREATE INDEX recalls_session_requested_idx ON recalls(session_id, requested_at);
CREATE INDEX benchmarks_project_created_idx ON benchmarks(project_id, created_at);
CREATE INDEX backups_installation_idx ON backups(installation_id);
`;

export const INITIAL_SCHEMA_MIGRATION: Migration = {
  name: "initial schema",
  statements: [INITIAL_SCHEMA_SQL],
  version: 1,
};
