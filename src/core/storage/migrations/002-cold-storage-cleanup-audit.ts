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

CREATE TABLE cold_storage_migration_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_version INTEGER NOT NULL CHECK (migration_version > 0),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('object', 'reference')),
  record_id TEXT NOT NULL,
  field_name TEXT NOT NULL CHECK (field_name IN ('created_at', 'expires_at')),
  original_value TEXT NOT NULL,
  repaired_value TEXT,
  reason TEXT NOT NULL CHECK (reason = 'invalid_timestamp'),
  repaired_at TEXT NOT NULL,
  UNIQUE (migration_version, record_kind, record_id, field_name)
);

INSERT INTO cold_storage_migration_repairs (
  migration_version, record_kind, record_id, field_name, original_value,
  repaired_value, reason, repaired_at
)
SELECT 2, 'object', id, 'created_at', created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'invalid_timestamp',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM cold_objects
 WHERE julianday(created_at) IS NULL;

UPDATE cold_objects
   SET created_at = (
     SELECT repair.repaired_value
       FROM cold_storage_migration_repairs AS repair
      WHERE repair.migration_version = 2
        AND repair.record_kind = 'object'
        AND repair.record_id = cold_objects.id
        AND repair.field_name = 'created_at'
   )
 WHERE id IN (
   SELECT record_id
     FROM cold_storage_migration_repairs
    WHERE migration_version = 2
      AND record_kind = 'object'
      AND field_name = 'created_at'
 );

INSERT INTO cold_storage_migration_repairs (
  migration_version, record_kind, record_id, field_name, original_value,
  repaired_value, reason, repaired_at
)
SELECT 2, 'reference', id, 'created_at', created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'invalid_timestamp',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM cold_object_references
 WHERE julianday(created_at) IS NULL;

UPDATE cold_object_references
   SET created_at = (
     SELECT repair.repaired_value
       FROM cold_storage_migration_repairs AS repair
      WHERE repair.migration_version = 2
        AND repair.record_kind = 'reference'
        AND repair.record_id = cold_object_references.id
        AND repair.field_name = 'created_at'
   )
 WHERE id IN (
   SELECT record_id
     FROM cold_storage_migration_repairs
    WHERE migration_version = 2
      AND record_kind = 'reference'
      AND field_name = 'created_at'
 );

INSERT INTO cold_storage_migration_repairs (
  migration_version, record_kind, record_id, field_name, original_value,
  repaired_value, reason, repaired_at
)
SELECT 2, 'reference', id, 'expires_at', expires_at, NULL,
       'invalid_timestamp', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM cold_object_references
 WHERE expires_at IS NOT NULL
   AND julianday(expires_at) IS NULL;

UPDATE cold_object_references
   SET expires_at = NULL
 WHERE id IN (
   SELECT record_id
     FROM cold_storage_migration_repairs
    WHERE migration_version = 2
      AND record_kind = 'reference'
      AND field_name = 'expires_at'
 );

CREATE INDEX cold_storage_cleanup_runs_started_idx
  ON cold_storage_cleanup_runs(started_at);
CREATE INDEX cold_storage_cleanup_items_run_idx
  ON cold_storage_cleanup_items(run_id, id);
CREATE INDEX cold_storage_migration_repairs_record_idx
  ON cold_storage_migration_repairs(record_kind, record_id);
`;

export const COLD_STORAGE_CLEANUP_AUDIT_MIGRATION: Migration = {
  name: "cold storage cleanup audit",
  statements: [COLD_STORAGE_CLEANUP_AUDIT_SQL],
  version: 2,
};
