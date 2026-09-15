import type { Migration } from "./types.js";

// Add structured guarantees only to post-migration rows so unconstrained v2 memory remains readable.
const STRUCTURED_MEMORY_CORE_SQL = `
ALTER TABLE memory_items
  ADD COLUMN representation TEXT NOT NULL DEFAULT 'unknown'
  CHECK (representation IN ('exact', 'summary', 'unknown'));

CREATE INDEX memory_items_project_archive_idx
  ON memory_items(project_id, created_at, id);
CREATE INDEX memory_items_project_working_idx
  ON memory_items(project_id, status, created_at, id);
CREATE INDEX memory_items_supersedes_idx
  ON memory_items(supersedes_id);
CREATE UNIQUE INDEX memory_items_structured_single_successor_idx
  ON memory_items(supersedes_id)
  WHERE supersedes_id IS NOT NULL
    AND representation IN ('exact', 'summary');

CREATE TRIGGER memory_items_structured_insert
BEFORE INSERT ON memory_items
BEGIN
  SELECT CASE
    WHEN NEW.representation NOT IN ('exact', 'summary')
    THEN RAISE(ABORT, 'memory representation must be exact or summary for new rows')
  END;
  SELECT CASE
    WHEN NEW.class NOT IN (
      'requirement', 'decision', 'constraint', 'rejected-approach', 'task',
      'error', 'file-state', 'symbol', 'test-state', 'environment'
    )
    THEN RAISE(ABORT, 'unsupported memory class')
  END;
  SELECT CASE
    WHEN NEW.status NOT IN (
      'selected', 'considered', 'rejected', 'superseded', 'temporary', 'unknown'
    )
    THEN RAISE(ABORT, 'unsupported memory status')
  END;
  SELECT CASE
    WHEN NEW.status = 'superseded'
    THEN RAISE(ABORT, 'new memory cannot begin as superseded')
  END;
  SELECT CASE
    WHEN NEW.session_id IS NULL
      AND (NEW.source_uri IS NULL OR length(NEW.source_uri) = 0)
    THEN RAISE(ABORT, 'memory requires a source session or artifact URI')
  END;
  SELECT CASE
    WHEN NEW.source_uri IS NOT NULL AND length(NEW.source_uri) = 0
    THEN RAISE(ABORT, 'memory artifact URI must not be empty')
  END;
  SELECT CASE
    WHEN NEW.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM sessions
         WHERE sessions.id = NEW.session_id
           AND sessions.project_id = NEW.project_id
      )
    THEN RAISE(ABORT, 'memory session must belong to its project')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM memory_items AS predecessor WHERE predecessor.id = NEW.supersedes_id
      )
    THEN RAISE(ABORT, 'memory predecessor does not exist')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM memory_items AS predecessor
         WHERE predecessor.id = NEW.supersedes_id
           AND predecessor.project_id IS NOT NEW.project_id
      )
    THEN RAISE(ABORT, 'memory predecessor must belong to the same project')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM memory_items AS predecessor
         WHERE predecessor.id = NEW.supersedes_id
           AND predecessor.class IS NOT NEW.class
      )
    THEN RAISE(ABORT, 'memory successor must preserve its predecessor class')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM memory_items AS predecessor
         WHERE predecessor.id = NEW.supersedes_id
           AND predecessor.status = 'superseded'
      )
    THEN RAISE(ABORT, 'memory predecessor is already superseded')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM memory_items AS successor
         WHERE successor.supersedes_id = NEW.supersedes_id
      )
    THEN RAISE(ABORT, 'memory predecessor already has a successor')
  END;
END;

CREATE TRIGGER sessions_structured_project_update
BEFORE UPDATE OF project_id ON sessions
WHEN NEW.project_id IS NOT OLD.project_id
  AND EXISTS (
    SELECT 1
      FROM memory_items
     WHERE memory_items.session_id = OLD.id
       AND memory_items.representation IN ('exact', 'summary')
  )
BEGIN
  SELECT RAISE(ABORT, 'memory source session must remain in its project');
END;

CREATE TRIGGER memory_items_unknown_representation_immutable
BEFORE UPDATE OF representation ON memory_items
WHEN OLD.representation = 'unknown'
  AND NEW.representation IS NOT OLD.representation
BEGIN
  SELECT RAISE(ABORT, 'unknown memory representation is migration-only');
END;

CREATE TRIGGER memory_items_structured_update
BEFORE UPDATE ON memory_items
WHEN OLD.representation IN ('exact', 'summary')
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.session_id IS NOT OLD.session_id
      OR NEW.class IS NOT OLD.class
      OR NEW.content IS NOT OLD.content
      OR NEW.source_uri IS NOT OLD.source_uri
      OR NEW.supersedes_id IS NOT OLD.supersedes_id
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.representation IS NOT OLD.representation
    THEN RAISE(ABORT, 'structured memory identity, content, and provenance are immutable')
  END;
  SELECT CASE
    WHEN NEW.status IS NOT OLD.status
      AND NOT (
        OLD.status <> 'superseded'
        AND NEW.status = 'superseded'
        AND EXISTS (
          SELECT 1
            FROM memory_items AS successor
           WHERE successor.supersedes_id = OLD.id
             AND successor.representation IN ('exact', 'summary')
        )
      )
    THEN RAISE(ABORT, 'structured memory status changes require a successor')
  END;
END;

CREATE TRIGGER memory_items_structured_delete
BEFORE DELETE ON memory_items
WHEN OLD.representation IN ('exact', 'summary')
BEGIN
  SELECT RAISE(ABORT, 'structured memory is append-only');
END;

CREATE TRIGGER memory_items_mark_predecessor_superseded
AFTER INSERT ON memory_items
WHEN NEW.representation IN ('exact', 'summary')
  AND NEW.supersedes_id IS NOT NULL
BEGIN
  UPDATE memory_items
     SET status = 'superseded',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.supersedes_id;
END;

CREATE TRIGGER memory_items_mirror_decision_supersession
AFTER UPDATE OF status ON memory_items
WHEN NEW.representation IN ('exact', 'summary')
  AND NEW.status = 'superseded'
BEGIN
  UPDATE decisions
     SET status = 'superseded'
   WHERE memory_item_id = NEW.id;
END;

CREATE TRIGGER decisions_structured_insert
BEFORE INSERT ON decisions
BEGIN
  SELECT CASE
    WHEN NEW.memory_item_id IS NULL
      OR NOT EXISTS (
        SELECT 1
          FROM memory_items
         WHERE memory_items.id = NEW.memory_item_id
           AND memory_items.representation IN ('exact', 'summary')
           AND memory_items.class = 'decision'
      )
    THEN RAISE(ABORT, 'new decisions require a structured decision memory item')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM decisions AS linked WHERE linked.memory_item_id = NEW.memory_item_id
    )
    THEN RAISE(ABORT, 'decision memory item already has a linked decision')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
        FROM memory_items
       WHERE memory_items.id = NEW.memory_item_id
         AND NEW.id IS memory_items.id
         AND NEW.project_id IS memory_items.project_id
         AND NEW.session_id IS memory_items.session_id
         AND NEW.decision IS memory_items.content
         AND NEW.status IS memory_items.status
         AND NEW.source_uri IS memory_items.source_uri
         AND NEW.supersedes_id IS memory_items.supersedes_id
         AND NEW.decided_at IS memory_items.created_at
    )
    THEN RAISE(ABORT, 'linked decision must mirror its memory item')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM decisions AS predecessor
         WHERE predecessor.id = NEW.supersedes_id
           AND predecessor.memory_item_id = NEW.supersedes_id
      )
    THEN RAISE(ABORT, 'linked decision predecessor does not exist')
  END;
END;

CREATE TRIGGER decisions_structured_update
BEFORE UPDATE ON decisions
WHEN EXISTS (
  SELECT 1
    FROM memory_items
   WHERE memory_items.id = OLD.memory_item_id
     AND memory_items.representation IN ('exact', 'summary')
)
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.session_id IS NOT OLD.session_id
      OR NEW.memory_item_id IS NOT OLD.memory_item_id
      OR NEW.decision IS NOT OLD.decision
      OR NEW.reason IS NOT OLD.reason
      OR NEW.rejected IS NOT OLD.rejected
      OR NEW.source_uri IS NOT OLD.source_uri
      OR NEW.supersedes_id IS NOT OLD.supersedes_id
      OR NEW.decided_at IS NOT OLD.decided_at
    THEN RAISE(ABORT, 'linked decision identity, content, and provenance are immutable')
  END;
  SELECT CASE
    WHEN NEW.status IS NOT OLD.status
      AND NOT (
        NEW.status = 'superseded'
        AND EXISTS (
          SELECT 1
            FROM memory_items
           WHERE memory_items.id = OLD.memory_item_id
             AND memory_items.status = 'superseded'
        )
      )
    THEN RAISE(ABORT, 'linked decision status must mirror its memory item')
  END;
END;

CREATE TRIGGER decisions_structured_delete
BEFORE DELETE ON decisions
WHEN EXISTS (
  SELECT 1
    FROM memory_items
   WHERE memory_items.id = OLD.memory_item_id
     AND memory_items.representation IN ('exact', 'summary')
)
BEGIN
  SELECT RAISE(ABORT, 'structured decisions are append-only');
END;
`;

export const STRUCTURED_MEMORY_CORE_MIGRATION: Migration = {
  name: "structured memory core",
  statements: [STRUCTURED_MEMORY_CORE_SQL],
  version: 3,
};
