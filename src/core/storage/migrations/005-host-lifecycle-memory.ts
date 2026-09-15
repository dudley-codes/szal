import type { Migration } from "./types.js";

const HOST_LIFECYCLE_MEMORY_SQL = `
ALTER TABLE memory_items ADD COLUMN source_host TEXT;
ALTER TABLE memory_items ADD COLUMN source_event_id TEXT;
ALTER TABLE memory_items ADD COLUMN source_event_kind TEXT;
ALTER TABLE memory_items ADD COLUMN confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

CREATE INDEX memory_items_source_event_idx
  ON memory_items(project_id, source_event_id, source_event_kind);

CREATE TABLE memory_capture_rejections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  host TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_event_kind TEXT NOT NULL,
  candidate_key TEXT,
  candidate_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX memory_capture_rejections_project_created_idx
  ON memory_capture_rejections(project_id, created_at, id);
`;

export const HOST_LIFECYCLE_MEMORY_MIGRATION: Migration = {
  name: "host lifecycle memory capture",
  statements: [HOST_LIFECYCLE_MEMORY_SQL],
  version: 5,
};
