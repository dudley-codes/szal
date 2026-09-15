import type { Migration } from "./types.js";

// Harden structured writes without changing the checksum of the previously committed core migration.
const STRUCTURED_MEMORY_SAFEGUARDS_SQL = `
DROP TRIGGER memory_items_structured_insert;
CREATE TRIGGER memory_items_structured_insert
BEFORE INSERT ON memory_items
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM memory_items WHERE memory_items.id = NEW.id)
    THEN RAISE(ABORT, 'memory id already exists')
  END;
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
      AND NEW.representation = 'summary'
      AND EXISTS (
        SELECT 1
          FROM memory_items AS predecessor
         WHERE predecessor.id = NEW.supersedes_id
           AND predecessor.representation <> 'summary'
      )
    THEN RAISE(ABORT, 'summary memory cannot supersede exact or unknown memory')
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

DROP TRIGGER memory_items_mirror_decision_supersession;
CREATE TRIGGER memory_items_mirror_decision_supersession
AFTER UPDATE OF status ON memory_items
WHEN OLD.status IS NOT NEW.status
  AND NEW.status = 'superseded'
BEGIN
  UPDATE decisions
     SET status = 'superseded'
   WHERE memory_item_id = NEW.id;
END;

DROP TRIGGER decisions_structured_insert;
CREATE TRIGGER decisions_structured_insert
BEFORE INSERT ON decisions
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM decisions WHERE decisions.id = NEW.id)
    THEN RAISE(ABORT, 'decision id already exists')
  END;
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
         AND NEW.decided_at IS memory_items.created_at
         AND (
           (
             memory_items.supersedes_id IS NULL
             AND NEW.supersedes_id IS NULL
           )
           OR EXISTS (
             SELECT 1
               FROM decisions AS predecessor
              WHERE predecessor.id = NEW.supersedes_id
                AND predecessor.memory_item_id = memory_items.supersedes_id
                AND predecessor.project_id = NEW.project_id
           )
           OR (
             memory_items.supersedes_id IS NOT NULL
             AND NEW.supersedes_id IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM decisions AS predecessor
                WHERE predecessor.memory_item_id = memory_items.supersedes_id
             )
           )
         )
    )
    THEN RAISE(ABORT, 'linked decision must mirror its memory item')
  END;
END;
`;

export const STRUCTURED_MEMORY_SAFEGUARDS_MIGRATION: Migration = {
  name: "structured memory safeguards",
  statements: [STRUCTURED_MEMORY_SAFEGUARDS_SQL],
  version: 4,
};
