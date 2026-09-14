import type { Migration } from "./types.js";

const COLD_STORAGE_CLEANUP_AUDIT_SQL = `
CREATE TABLE cold_storage_cleanup_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_errors')),
  retention_days INTEGER NOT NULL CHECK (retention_days >= 0),
  max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  before_bytes INTEGER NOT NULL CHECK (before_bytes >= 0),
  after_bytes INTEGER NOT NULL CHECK (after_bytes >= 0),
  expired_references INTEGER NOT NULL DEFAULT 0 CHECK (expired_references >= 0),
  deleted_objects INTEGER NOT NULL DEFAULT 0 CHECK (deleted_objects >= 0),
  deleted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (deleted_bytes >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE cold_storage_cleanup_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES cold_storage_cleanup_runs(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('reference', 'object')),
  record_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('expiry', 'orphan', 'size')),
  relative_path TEXT,
  raw_bytes INTEGER CHECK (raw_bytes IS NULL OR raw_bytes >= 0),
  file_status TEXT NOT NULL CHECK (file_status IN ('pending', 'deleted', 'missing', 'failed', 'not_applicable')),
  error TEXT
);

CREATE INDEX cold_storage_cleanup_runs_started_idx
  ON cold_storage_cleanup_runs(started_at);
CREATE INDEX cold_storage_cleanup_items_run_idx
  ON cold_storage_cleanup_items(run_id, id);
`;

export const COLD_STORAGE_CLEANUP_AUDIT_MIGRATION: Migration = {
  name: "cold storage cleanup audit",
  statements: [COLD_STORAGE_CLEANUP_AUDIT_SQL],
  version: 2,
};
