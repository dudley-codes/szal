import { chmodSync } from "node:fs";

import BetterSqlite3 from "better-sqlite3";

import { applyMigrations } from "./migrations/index.js";
import { ensureStorageDirectories, resolveStoragePaths, type StoragePaths } from "./paths.js";

export interface OpenDatabaseOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  paths?: StoragePaths;
}

export interface SzalDatabase {
  connection: BetterSqlite3.Database;
  paths: StoragePaths;
}

// Open a private WAL database and migrate it before returning it to callers.
export const openSzalDatabase = (options: OpenDatabaseOptions = {}): SzalDatabase => {
  const paths =
    options.paths ?? resolveStoragePaths(options.environment ?? process.env, options.homeDirectory);
  ensureStorageDirectories(paths);

  const connection = new BetterSqlite3(paths.databasePath);

  try {
    chmodSync(paths.databasePath, 0o600);
    connection.pragma("foreign_keys = ON");
    connection.pragma("busy_timeout = 5000");
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = NORMAL");
    applyMigrations(connection);
    return { connection, paths };
  } catch (error) {
    connection.close();
    throw error;
  }
};
