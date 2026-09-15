import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ManagedFile {
  contents: Buffer;
  mode: number;
  ownedPrefix?: Buffer;
  path: string;
  validate?: (temporaryPath: string) => string | null;
}

export interface FileCommit {
  backupPaths: readonly string[];
  changedPaths: readonly string[];
  rollback: () => boolean;
}

export interface FileTransactionOptions {
  now?: () => Date;
}

interface FileSnapshot {
  candidate: Buffer;
  existed: boolean;
  logicalPath: string;
  mode: number;
  original: Buffer;
  originalMode: number;
  targetPath: string;
  validate?: (temporaryPath: string) => string | null;
}

const BACKUP_INFIX = ".szal-backup.";

export class FileTransactionError extends Error {
  public readonly backupPaths: readonly string[];
  public readonly rolledBack: boolean;

  public constructor(
    message: string,
    rolledBack: boolean,
    backupPaths: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.backupPaths = backupPaths;
    this.name = "FileTransactionError";
    this.rolledBack = rolledBack;
  }
}

// Preserve symlinks by writing their targets and reject dangling links rather than replacing them.
const resolveWriteTarget = (logicalPath: string): string => {
  let symbolicLink: boolean;
  try {
    symbolicLink = lstatSync(logicalPath).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return logicalPath;
    }
    throw error;
  }
  if (!symbolicLink) {
    return logicalPath;
  }
  try {
    return realpathSync(logicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Refusing to replace dangling symbolic link at ${logicalPath}.`, {
        cause: error,
      });
    }
    throw error;
  }
};

// Capture bytes, mode, and symlink target before any mutation and reject unowned replacements.
const snapshotFile = (change: ManagedFile): FileSnapshot | undefined => {
  const targetPath = resolveWriteTarget(change.path);
  const existed = existsSync(targetPath);
  const original = existed ? readFileSync(targetPath) : Buffer.alloc(0);
  const originalMode = existed ? statSync(targetPath).mode & 0o777 : change.mode;
  if (
    change.ownedPrefix !== undefined &&
    existed &&
    !original.subarray(0, change.ownedPrefix.length).equals(change.ownedPrefix)
  ) {
    throw new Error(
      `Refusing to replace unowned file at ${change.path}; move it or restore the ownership marker first.`,
    );
  }
  if (original.equals(change.contents) && originalMode === change.mode) {
    return undefined;
  }
  return {
    candidate: change.contents,
    existed,
    logicalPath: change.path,
    mode: change.mode,
    original,
    originalMode,
    targetPath,
    ...(change.validate === undefined ? {} : { validate: change.validate }),
  };
};

const compactTimestamp = (date: Date): string => date.toISOString().replaceAll(/[-:.]/gu, "");

// Allocate an exclusive private backup so clock collisions cannot overwrite prior user data.
const createBackup = (snapshot: FileSnapshot, now: () => Date): string => {
  mkdirSync(dirname(snapshot.logicalPath), { mode: 0o700, recursive: true });
  const basePath = `${snapshot.logicalPath}${BACKUP_INFIX}${compactTimestamp(now())}`;
  for (let attempt = 0; attempt <= Number.MAX_SAFE_INTEGER; attempt += 1) {
    const path = attempt === 0 ? basePath : `${basePath}.${String(attempt)}`;
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, snapshot.original);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(path, 0o600);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(`Unable to allocate a unique backup for ${snapshot.logicalPath}.`);
};

const matchesOriginal = (snapshot: FileSnapshot): boolean => {
  if (!existsSync(snapshot.targetPath)) {
    return !snapshot.existed;
  }
  return (
    snapshot.existed &&
    readFileSync(snapshot.targetPath).equals(snapshot.original) &&
    (statSync(snapshot.targetPath).mode & 0o777) === snapshot.originalMode
  );
};

const currentMatchesSnapshot = (snapshot: FileSnapshot): boolean =>
  resolveWriteTarget(snapshot.logicalPath) === snapshot.targetPath && matchesOriginal(snapshot);

// Write, fsync, validate, and atomically rename a private same-directory temporary file.
const writeAtomic = (
  targetPath: string,
  contents: Buffer,
  mode: number,
  validate?: (temporaryPath: string) => string | null,
): void => {
  mkdirSync(dirname(targetPath), { mode: 0o700, recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.szal-${String(process.pid)}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    const validationError = validate?.(temporaryPath) ?? null;
    if (validationError !== null) {
      throw new Error(`Validation failed for ${targetPath}: ${validationError}`);
    }
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, mode);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
};

// Restore only files still carrying this transaction's candidate bytes, preserving concurrent edits.
const restoreSnapshots = (snapshots: readonly FileSnapshot[]): boolean => {
  let restored = true;
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (matchesOriginal(snapshot)) {
        continue;
      }
      if (
        !existsSync(snapshot.targetPath) ||
        !readFileSync(snapshot.targetPath).equals(snapshot.candidate)
      ) {
        restored = false;
        continue;
      }
      if (snapshot.existed) {
        writeAtomic(snapshot.targetPath, snapshot.original, snapshot.originalMode);
      } else {
        rmSync(snapshot.targetPath, { force: true });
      }
      restored = matchesOriginal(snapshot) && restored;
    } catch {
      restored = false;
    }
  }
  return restored;
};

// Convert all preflight failures into a transaction result with no mutation to compensate.
const prepareSnapshots = (changes: readonly ManagedFile[]): readonly FileSnapshot[] => {
  try {
    return changes
      .map((change) => snapshotFile(change))
      .filter((snapshot): snapshot is FileSnapshot => snapshot !== undefined);
  } catch (error) {
    throw new FileTransactionError(
      error instanceof Error ? error.message : String(error),
      true,
      [],
      { cause: error },
    );
  }
};

// Commit changed files in order and retain a compensating rollback for later health failures.
export const commitFileTransaction = (
  changes: readonly ManagedFile[],
  options: FileTransactionOptions = {},
): FileCommit => {
  const snapshots = prepareSnapshots(changes);
  const committed: FileSnapshot[] = [];
  const backupPaths: string[] = [];
  const now = options.now ?? (() => new Date());

  try {
    for (const snapshot of snapshots) {
      if (!currentMatchesSnapshot(snapshot)) {
        throw new Error(
          `Refusing to overwrite ${snapshot.logicalPath} because it changed during installation.`,
        );
      }
      backupPaths.push(createBackup(snapshot, now));
      committed.push(snapshot);
      writeAtomic(snapshot.targetPath, snapshot.candidate, snapshot.mode, snapshot.validate);
    }
  } catch (error) {
    const rolledBack = restoreSnapshots(committed);
    throw new FileTransactionError(
      error instanceof Error ? error.message : String(error),
      rolledBack,
      backupPaths,
      { cause: error },
    );
  }

  let active = true;
  return {
    backupPaths,
    changedPaths: snapshots.map((snapshot) => snapshot.logicalPath),
    rollback: () => {
      if (!active) {
        return true;
      }
      active = false;
      return restoreSnapshots(committed);
    },
  };
};
