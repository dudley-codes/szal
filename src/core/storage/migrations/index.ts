import { createHash } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { INITIAL_SCHEMA_MIGRATION } from "./001-initial-schema.js";
import { COLD_STORAGE_CLEANUP_AUDIT_MIGRATION } from "./002-cold-storage-cleanup-audit.js";
import { STRUCTURED_MEMORY_CORE_MIGRATION } from "./003-structured-memory-core.js";
import { STRUCTURED_MEMORY_SAFEGUARDS_MIGRATION } from "./004-structured-memory-safeguards.js";
import type { Migration } from "./types.js";

interface AppliedMigration {
  checksum: string;
  name: string;
  version: number;
}

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

export const MIGRATIONS: readonly Migration[] = [
  INITIAL_SCHEMA_MIGRATION,
  COLD_STORAGE_CLEANUP_AUDIT_MIGRATION,
  STRUCTURED_MEMORY_CORE_MIGRATION,
  STRUCTURED_MEMORY_SAFEGUARDS_MIGRATION,
];

const calculateChecksum = (migration: Migration): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        name: migration.name,
        statements: migration.statements,
        version: migration.version,
      }),
    )
    .digest("hex");

// Reject ambiguous histories before touching the database.
const validateMigrations = (migrations: readonly Migration[]): void => {
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("Migrations must have unique, positive versions in ascending order.");
    }
    if (migration.name.trim().length === 0 || migration.statements.length === 0) {
      throw new Error(
        `Migration ${String(migration.version)} must have a name and SQL statements.`,
      );
    }
    previousVersion = migration.version;
  }
};

// Apply and record every pending migration atomically while serializing competing writers.
export const applyMigrations = (
  database: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void => {
  validateMigrations(migrations);

  const migrate = database.transaction(() => {
    database.exec(MIGRATION_TABLE_SQL);

    const appliedMigrations = database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as AppliedMigration[];

    for (const [index, appliedMigration] of appliedMigrations.entries()) {
      const knownMigration = migrations[index];
      if (knownMigration === undefined) {
        throw new Error(
          `Database migration ${String(appliedMigration.version)} is newer than this Szal version.`,
        );
      }
      if (appliedMigration.version !== knownMigration.version) {
        throw new Error("Applied migrations are not a contiguous prefix of the migration history.");
      }
      if (
        appliedMigration.name !== knownMigration.name ||
        appliedMigration.checksum !== calculateChecksum(knownMigration)
      ) {
        throw new Error(`Applied migration ${String(appliedMigration.version)} has been modified.`);
      }
    }

    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
    );

    for (const migration of migrations.slice(appliedMigrations.length)) {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      insertMigration.run(migration.version, migration.name, calculateChecksum(migration));
    }
  });

  migrate.immediate();
};

export type { Migration } from "./types.js";
