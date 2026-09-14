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
      .prepare(
        "SELECT created_at, expires_at FROM cold_object_references WHERE id = ?",
      )
      .get("legacy-reference");
    assert.match(repairedObjectCreatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(
      repairedReference.created_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
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
