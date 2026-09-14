import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";

import BetterSqlite3 from "better-sqlite3";

import {
  applyMigrations,
  cleanupColdStorage,
  MIGRATIONS,
  openSzalDatabase,
  readColdObject,
  resolveStoragePaths,
  storeColdObject,
} from "../dist/core/storage/index.js";

const EXPECTED_TABLES = [
  "backups",
  "benchmarks",
  "cold_object_references",
  "cold_objects",
  "cold_storage_cleanup_items",
  "cold_storage_cleanup_runs",
  "cold_storage_migration_repairs",
  "compression_events",
  "decisions",
  "installations",
  "memory_items",
  "projects",
  "recalls",
  "requests",
  "schema_migrations",
  "sessions",
  "terminals",
  "token_usage",
];

const createTemporaryHome = () => mkdtempSync(join(tmpdir(), "szal-storage-"));

test("storage paths honor absolute XDG data homes", () => {
  const paths = resolveStoragePaths({ XDG_DATA_HOME: "/custom/data" }, "/unused/home");

  assert.equal(paths.dataDirectory, "/custom/data/szal");
  assert.equal(paths.databasePath, "/custom/data/szal/szal.db");
  assert.equal(paths.coldDirectory, "/custom/data/szal/cold");
});

test("storage paths ignore relative XDG data homes", () => {
  const paths = resolveStoragePaths({ XDG_DATA_HOME: "relative/data" }, "/safe/home");

  assert.equal(paths.dataDirectory, "/safe/home/.local/share/szal");
});

test("a fresh file database initializes privately through migrations", () => {
  const homeDirectory = createTemporaryHome();
  const database = openSzalDatabase({ environment: {}, homeDirectory });

  try {
    const tables = database.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    assert.deepEqual(tables, EXPECTED_TABLES);
    assert.equal(database.connection.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.connection.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.connection.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(statSync(database.paths.dataDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(database.paths.coldDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(database.paths.databasePath).mode & 0o777, 0o600);
    database.connection
      .prepare("INSERT INTO projects (id, root_path) VALUES (?, ?)")
      .run("project-1", "/workspace/project-1");
    assert.match(
      database.connection.prepare("SELECT created_at FROM projects").pluck().get(),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    assert.throws(
      () =>
        database.connection
          .prepare("INSERT INTO sessions (id, project_id, host, mode) VALUES (?, ?, ?, ?)")
          .run("session-1", "missing-project", "claude", "on"),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.connection.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("reopening a database is idempotent and preserves data", () => {
  const homeDirectory = createTemporaryHome();
  const firstDatabase = openSzalDatabase({ environment: {}, homeDirectory });

  firstDatabase.connection
    .prepare("INSERT INTO projects (id, root_path) VALUES (?, ?)")
    .run("project-1", "/workspace/project-1");
  applyMigrations(firstDatabase.connection);
  firstDatabase.connection.close();

  const reopenedDatabase = openSzalDatabase({ environment: {}, homeDirectory });
  try {
    assert.equal(
      reopenedDatabase.connection.prepare("SELECT COUNT(*) FROM projects").pluck().get(),
      1,
    );
    assert.equal(
      reopenedDatabase.connection.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
      MIGRATIONS.length,
    );
  } finally {
    reopenedDatabase.connection.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("cold-storage audit migration upgrades the initial schema without losing metadata", () => {
  const database = new BetterSqlite3(":memory:");
  const initialMigration = MIGRATIONS[0];
  assert.notEqual(initialMigration, undefined);

  try {
    applyMigrations(database, [initialMigration]);
    database
      .prepare(
        "INSERT INTO cold_objects (id, content_hash, relative_path, raw_bytes) VALUES (?, ?, ?, ?)",
      )
      .run("object-1", "hash-1", "sha256/ha/hash-1", 7);

    applyMigrations(database);

    assert.equal(database.prepare("SELECT COUNT(*) FROM cold_objects").pluck().get(), 1);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'cold_storage_cleanup_runs'",
        )
        .pluck()
        .get(),
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
      MIGRATIONS.length,
    );
  } finally {
    database.close();
  }
});

test("cold-storage migration repairs malformed legacy timestamps without losing content", () => {
  const database = new BetterSqlite3(":memory:");
  const homeDirectory = createTemporaryHome();
  const paths = resolveStoragePaths({}, homeDirectory);
  const initialMigration = MIGRATIONS[0];
  assert.notEqual(initialMigration, undefined);
  const payload = Buffer.from("recoverable legacy payload");
  const contentHash = createHash("sha256").update(payload).digest("hex");
  const id = `szal://cold/sha256/${contentHash}`;
  const relativePath = join("sha256", contentHash.slice(0, 2), contentHash);
  const filePath = join(paths.coldDirectory, relativePath);
  const policy = { enabled: true, maxBytes: 1_000, retentionDays: 0 };

  try {
    applyMigrations(database, [initialMigration]);
    mkdirSync(join(paths.coldDirectory, "sha256", contentHash.slice(0, 2)), {
      mode: 0o700,
      recursive: true,
    });
    writeFileSync(filePath, payload, { mode: 0o600 });
    database
      .prepare(
        `INSERT INTO cold_objects (
           id, content_hash, relative_path, raw_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, contentHash, relativePath, payload.byteLength, "broken-object-date");
    database
      .prepare(
        `INSERT INTO cold_object_references (
           id, cold_object_id, category, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-reference", id, "memory", "broken-reference-date", "broken-expiry");

    applyMigrations(database);

    const repairedObjectCreatedAt = database
      .prepare("SELECT created_at FROM cold_objects WHERE id = ?")
      .pluck()
      .get(id);
    const repairedReference = database
      .prepare("SELECT created_at, expires_at FROM cold_object_references WHERE id = ?")
      .get("legacy-reference");
    assert.match(repairedObjectCreatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(repairedReference.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(repairedReference.expires_at, null);
    assert.deepEqual(
      database
        .prepare(
          `SELECT record_kind, field_name, original_value, reason
             FROM cold_storage_migration_repairs
            ORDER BY id`,
        )
        .all(),
      [
        {
          field_name: "created_at",
          original_value: "broken-object-date",
          reason: "invalid_timestamp",
          record_kind: "object",
        },
        {
          field_name: "created_at",
          original_value: "broken-reference-date",
          reason: "invalid_timestamp",
          record_kind: "reference",
        },
        {
          field_name: "expires_at",
          original_value: "broken-expiry",
          reason: "invalid_timestamp",
          record_kind: "reference",
        },
      ],
    );
    const read = readColdObject(database, paths, id);
    assert.equal(read.status, "found");
    assert.deepEqual(Buffer.from(read.content), payload);
    assert.equal(cleanupColdStorage(database, paths, policy).status, "completed");
    assert.doesNotThrow(() =>
      storeColdObject(database, paths, "new payload", { category: "memory" }, { policy }),
    );
  } finally {
    database.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("cold-storage migration canonicalizes numeric legacy timestamps", () => {
  const database = new BetterSqlite3(":memory:");
  const homeDirectory = createTemporaryHome();
  const paths = resolveStoragePaths({}, homeDirectory);
  const initialMigration = MIGRATIONS[0];
  assert.notEqual(initialMigration, undefined);
  const payload = Buffer.from("recoverable numeric-timestamp payload");
  const contentHash = createHash("sha256").update(payload).digest("hex");
  const id = `szal://cold/sha256/${contentHash}`;
  const relativePath = join("sha256", contentHash.slice(0, 2), contentHash);
  const filePath = join(paths.coldDirectory, relativePath);
  const policy = { enabled: true, maxBytes: 1_000, retentionDays: 0 };

  try {
    applyMigrations(database, [initialMigration]);
    mkdirSync(join(paths.coldDirectory, "sha256", contentHash.slice(0, 2)), {
      mode: 0o700,
      recursive: true,
    });
    writeFileSync(filePath, payload, { mode: 0o600 });
    database
      .prepare(
        `INSERT INTO cold_objects (
           id, content_hash, relative_path, raw_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, contentHash, relativePath, payload.byteLength, "2451545");
    database
      .prepare(
        `INSERT INTO cold_object_references (
           id, cold_object_id, category, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("numeric-legacy-reference", id, "memory", "2451545", "2451546");

    applyMigrations(database);

    assert.equal(
      database.prepare("SELECT created_at FROM cold_objects WHERE id = ?").pluck().get(id),
      "2000-01-01T12:00:00.000Z",
    );
    assert.deepEqual(
      database
        .prepare("SELECT created_at, expires_at FROM cold_object_references WHERE id = ?")
        .get("numeric-legacy-reference"),
      {
        created_at: "2000-01-01T12:00:00.000Z",
        expires_at: "2000-01-02T12:00:00.000Z",
      },
    );
    assert.deepEqual(readFileSync(filePath), payload);
    assert.equal(cleanupColdStorage(database, paths, policy).status, "completed");
    assert.doesNotThrow(() =>
      storeColdObject(database, paths, "new payload", { category: "memory" }, { policy }),
    );
  } finally {
    database.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("an upgrade applies only pending migrations and keeps existing rows", () => {
  const database = new BetterSqlite3(":memory:");
  const migrationOne = {
    name: "create records",
    statements: ["CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"],
    version: 1,
  };
  const migrationTwo = {
    name: "add record state",
    statements: ["ALTER TABLE records ADD COLUMN state TEXT NOT NULL DEFAULT 'active'"],
    version: 2,
  };

  try {
    applyMigrations(database, [migrationOne]);
    database.prepare("INSERT INTO records (value) VALUES (?)").run("preserve me");
    applyMigrations(database, [migrationOne, migrationTwo]);

    assert.deepEqual(database.prepare("SELECT value, state FROM records").get(), {
      state: "active",
      value: "preserve me",
    });
    assert.equal(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(), 2);
  } finally {
    database.close();
  }
});

test("a failed migration rolls back its schema and migration record", () => {
  const database = new BetterSqlite3(":memory:");
  const invalidMigration = {
    name: "fail atomically",
    statements: ["CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)", "THIS IS NOT VALID SQL"],
    version: 1,
  };

  try {
    assert.throws(() => applyMigrations(database, [invalidMigration]), /syntax error/);
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'should_rollback')",
        )
        .all(),
      [],
    );
  } finally {
    database.close();
  }
});

test("migration checksums reject changes to applied history", () => {
  const database = new BetterSqlite3(":memory:");
  const originalMigration = {
    name: "create example",
    statements: ["CREATE TABLE example (id INTEGER PRIMARY KEY)"],
    version: 1,
  };

  try {
    applyMigrations(database, [originalMigration]);
    assert.throws(
      () =>
        applyMigrations(database, [
          {
            ...originalMigration,
            statements: ["CREATE TABLE example (id INTEGER PRIMARY KEY, changed TEXT)"],
          },
        ]),
      /Applied migration 1 has been modified/,
    );
  } finally {
    database.close();
  }
});

test("older code refuses a database with unknown migrations", () => {
  const database = new BetterSqlite3(":memory:");
  const migrationOne = {
    name: "first",
    statements: ["CREATE TABLE first_table (id INTEGER PRIMARY KEY)"],
    version: 1,
  };
  const migrationTwo = {
    name: "second",
    statements: ["CREATE TABLE second_table (id INTEGER PRIMARY KEY)"],
    version: 2,
  };

  try {
    applyMigrations(database, [migrationOne, migrationTwo]);
    assert.throws(
      () => applyMigrations(database, [migrationOne]),
      /Database migration 2 is newer than this Szal version/,
    );
  } finally {
    database.close();
  }
});

test("migration histories cannot contain an applied gap", () => {
  const database = new BetterSqlite3(":memory:");
  const migrationOne = {
    name: "first",
    statements: ["CREATE TABLE first_table (id INTEGER PRIMARY KEY)"],
    version: 1,
  };
  const migrationTwo = {
    name: "second",
    statements: ["CREATE TABLE second_table (id INTEGER PRIMARY KEY)"],
    version: 2,
  };

  try {
    applyMigrations(database, [migrationTwo]);
    assert.throws(
      () => applyMigrations(database, [migrationOne, migrationTwo]),
      /not a contiguous prefix/,
    );
  } finally {
    database.close();
  }
});

test("cold payloads are private, content-addressed, and deduplicated", () => {
  const homeDirectory = createTemporaryHome();
  const database = openSzalDatabase({ environment: {}, homeDirectory });
  const payload = "canonical tool output\n";

  try {
    database.connection
      .prepare("INSERT INTO projects (id, root_path) VALUES (?, ?)")
      .run("project-1", "/workspace/project-1");

    const firstObject = storeColdObject(database.connection, database.paths, payload, {
      category: "tool_output",
      projectId: "project-1",
      referenceId: "reference-1",
      sourceTool: "shell",
    });
    const secondObject = storeColdObject(database.connection, database.paths, payload, {
      category: "tool_output",
      projectId: "project-1",
      referenceId: "reference-2",
      sourceTool: "shell",
    });

    assert.equal(firstObject.id, secondObject.id);
    assert.match(firstObject.id, /^szal:\/\/cold\/sha256\/[a-f0-9]{64}$/);
    assert.equal(readFileSync(firstObject.filePath, "utf8"), payload);
    assert.equal(statSync(firstObject.filePath).mode & 0o777, 0o600);
    assert.equal(database.connection.prepare("SELECT COUNT(*) FROM cold_objects").pluck().get(), 1);
    assert.equal(
      database.connection.prepare("SELECT COUNT(*) FROM cold_object_references").pluck().get(),
      2,
    );
    assert.deepEqual(
      database.connection
        .prepare("SELECT category, project_id, source_tool FROM cold_object_references ORDER BY id")
        .all(),
      [
        { category: "tool_output", project_id: "project-1", source_tool: "shell" },
        { category: "tool_output", project_id: "project-1", source_tool: "shell" },
      ],
    );
  } finally {
    database.connection.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("structured-memory migration preserves arbitrary v2 rows as unknown", () => {
  const database = new BetterSqlite3(":memory:");
  const v2Migrations = MIGRATIONS.slice(0, 2);

  try {
    applyMigrations(database, v2Migrations);
    database.exec(`
      INSERT INTO projects (id, root_path) VALUES
        ('project-1', '/workspace/one'),
        ('project-2', '/workspace/two');
      INSERT INTO sessions (id, project_id, host, mode) VALUES
        ('other-project-session', 'project-2', 'host', 'on');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri
      ) VALUES (
        'legacy-root', 'project-1', 'legacy-class', 'legacy-status', '  exact legacy bytes\n', NULL
      );
      INSERT INTO memory_items (
        id, project_id, session_id, class, status, content, supersedes_id
      ) VALUES
        (
          'legacy-child-a', 'project-1', 'other-project-session', 'anything', 'invalid',
          'child a', 'legacy-root'
        ),
        (
          'legacy-child-b', 'project-1', NULL, 'anything-else', 'also-invalid',
          'child b', 'legacy-root'
        );
      INSERT INTO decisions (
        id, project_id, session_id, memory_item_id, decision, reason, rejected,
        status, source_uri, supersedes_id
      ) VALUES (
        'legacy-decision', 'project-1', 'other-project-session', 'legacy-child-a',
        'legacy decision', ' legacy reason ', 'not this', 'invented', NULL, NULL
      );
    `);

    assert.doesNotThrow(() => applyMigrations(database));
    assert.deepEqual(
      database
        .prepare(
          `SELECT id, class, status, content, session_id, source_uri, supersedes_id, representation
             FROM memory_items
            ORDER BY id`,
        )
        .all(),
      [
        {
          class: "anything",
          content: "child a",
          id: "legacy-child-a",
          representation: "unknown",
          session_id: "other-project-session",
          source_uri: null,
          status: "invalid",
          supersedes_id: "legacy-root",
        },
        {
          class: "anything-else",
          content: "child b",
          id: "legacy-child-b",
          representation: "unknown",
          session_id: null,
          source_uri: null,
          status: "also-invalid",
          supersedes_id: "legacy-root",
        },
        {
          class: "legacy-class",
          content: "  exact legacy bytes\n",
          id: "legacy-root",
          representation: "unknown",
          session_id: null,
          source_uri: null,
          status: "legacy-status",
          supersedes_id: null,
        },
      ],
    );
    assert.deepEqual(
      database.prepare("SELECT decision, reason, rejected, status FROM decisions").get(),
      {
        decision: "legacy decision",
        reason: " legacy reason ",
        rejected: "not this",
        status: "invented",
      },
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO memory_items (id, project_id, class, status, content, source_uri)
             VALUES ('post-v3-unknown', 'project-1', 'task', 'selected', 'new', 'artifact://new')`,
          )
          .run(),
      /representation must be exact or summary/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE memory_items SET representation = 'exact' WHERE id = 'legacy-root'")
          .run(),
      /unknown memory representation is migration-only/,
    );
  } finally {
    database.close();
  }
});

test("structured-memory database invariants protect new rows and decision mirrors", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database);
    database.exec(`
      INSERT INTO projects (id, root_path) VALUES
        ('project-1', '/workspace/one'),
        ('project-2', '/workspace/two');
      INSERT INTO sessions (id, project_id, host, mode) VALUES
        ('session-1', 'project-1', 'host', 'on'),
        ('session-2', 'project-2', 'host', 'on');
    `);
    const insertMemory = database.prepare(`
      INSERT INTO memory_items (
        id, project_id, session_id, class, status, content, source_uri,
        supersedes_id, created_at, updated_at, representation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const values = ({
      id,
      projectId = "project-1",
      sessionId = null,
      memoryClass = "requirement",
      status = "selected",
      content = "content",
      sourceUri = "artifact://source",
      supersedesId = null,
      representation = "exact",
    }) => [
      id,
      projectId,
      sessionId,
      memoryClass,
      status,
      content,
      sourceUri,
      supersedesId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      representation,
    ];

    assert.throws(
      () => insertMemory.run(...values({ id: "no-source", sourceUri: null })),
      /requires a source session or artifact URI/,
    );
    assert.throws(
      () =>
        insertMemory.run(...values({ id: "unknown-representation", representation: "unknown" })),
      /representation must be exact or summary/,
    );
    assert.throws(
      () => insertMemory.run(...values({ id: "bad-class", memoryClass: "idea" })),
      /unsupported memory class/,
    );
    assert.throws(
      () => insertMemory.run(...values({ id: "bad-status", status: "active" })),
      /unsupported memory status/,
    );
    assert.throws(
      () => insertMemory.run(...values({ id: "starts-superseded", status: "superseded" })),
      /cannot begin as superseded/,
    );
    assert.throws(
      () =>
        insertMemory.run(
          ...values({ id: "cross-project-session", sessionId: "session-2", sourceUri: null }),
        ),
      /session must belong to its project/,
    );

    insertMemory.run(...values({ id: "predecessor", sessionId: "session-1" }));
    assert.throws(
      () =>
        database
          .prepare("UPDATE sessions SET project_id = 'project-2' WHERE id = 'session-1'")
          .run(),
      /source session must remain in its project/,
    );
    assert.throws(
      () =>
        insertMemory.run(
          ...values({
            id: "cross-project-successor",
            projectId: "project-2",
            supersedesId: "predecessor",
          }),
        ),
      /predecessor must belong to the same project/,
    );
    insertMemory.run(...values({ id: "successor", supersedesId: "predecessor" }));
    assert.equal(
      database.prepare("SELECT status FROM memory_items WHERE id = 'predecessor'").pluck().get(),
      "superseded",
    );
    assert.throws(
      () => insertMemory.run(...values({ id: "second-successor", supersedesId: "predecessor" })),
      /already superseded|already has a successor/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE memory_items SET content = 'changed' WHERE id = 'successor'")
          .run(),
      /identity, content, and provenance are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM memory_items WHERE id = 'successor'").run(),
      /append-only/,
    );

    insertMemory.run(
      ...values({ id: "decision-1", memoryClass: "decision", sessionId: "session-1" }),
    );
    const insertDecision = database.prepare(`
      INSERT INTO decisions (
        id, project_id, session_id, memory_item_id, decision, reason, rejected,
        status, source_uri, supersedes_id, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    assert.throws(
      () =>
        insertDecision.run(
          "decision-1",
          "project-1",
          "session-1",
          "decision-1",
          "different content",
          "reason",
          "rejected",
          "selected",
          "artifact://source",
          null,
          "2026-01-01T00:00:00.000Z",
        ),
      /must mirror its memory item/,
    );
    insertDecision.run(
      "decision-1",
      "project-1",
      "session-1",
      "decision-1",
      "content",
      " exact reason ",
      "not another",
      "selected",
      "artifact://source",
      null,
      "2026-01-01T00:00:00.000Z",
    );
    assert.throws(
      () => database.prepare("UPDATE decisions SET reason = 'changed'").run(),
      /identity, content, and provenance are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM decisions WHERE id = 'decision-1'").run(),
      /append-only/,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'memory_items_project_archive_idx',
                'memory_items_supersedes_idx',
                'memory_items_structured_single_successor_idx'
              )
            ORDER BY name`,
        )
        .pluck()
        .all(),
      [
        "memory_items_project_archive_idx",
        "memory_items_structured_single_successor_idx",
        "memory_items_supersedes_idx",
      ],
    );
  } finally {
    database.close();
  }
});
