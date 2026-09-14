import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface StoragePaths {
  coldDirectory: string;
  dataDirectory: string;
  databasePath: string;
}

// Resolve storage externally from repositories while honoring an absolute XDG data override.
export const resolveStoragePaths = (
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): StoragePaths => {
  const configuredDataHome = environment.XDG_DATA_HOME;
  const dataHome =
    configuredDataHome !== undefined &&
    configuredDataHome.length > 0 &&
    isAbsolute(configuredDataHome)
      ? configuredDataHome
      : join(homeDirectory, ".local", "share");
  const dataDirectory = join(dataHome, "szal");

  return {
    coldDirectory: join(dataDirectory, "cold"),
    dataDirectory,
    databasePath: join(dataDirectory, "szal.db"),
  };
};

// Create private storage directories before any database or cold payload is written.
export const ensureStorageDirectories = (paths: StoragePaths): void => {
  for (const directory of [paths.dataDirectory, paths.coldDirectory]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
  }
};
