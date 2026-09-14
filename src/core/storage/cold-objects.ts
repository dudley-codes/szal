import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import { DEFAULT_CONFIG, type SzalConfig } from "../config/index.js";
import type { StoragePaths } from "./paths.js";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ColdObjectMetadata {
  category: string;
  compressedTokens?: number;
  compressionMode?: string;
  compressor?: string;
  createdAt?: string;
  expiresAt?: string;
  projectId?: string;
  rawTokens?: number;
  referenceId?: string;
  sessionId?: string;
  sourcePath?: string;
  sourceTool?: string;
}

export interface ColdStoragePolicy {
  enabled: boolean;
  maxBytes: number;
  retentionDays: number;
}

export interface StoreColdObjectOptions {
  now?: Date;
  policy?: ColdStoragePolicy;
}

export interface StoredColdObject {
  contentHash: string;
  expiresAt: string | null;
  filePath: string;
  id: string;
  referenceId: string;
}

export interface ReadColdObjectOptions {
  allowExpired?: boolean;
  now?: Date;
}

export type ColdObjectCorruptionReason =
  "hash-mismatch" | "metadata-mismatch" | "missing-file" | "size-mismatch" | "unreadable";

export type ColdObjectReadResult =
  | {
      content: Uint8Array;
      contentHash: string;
      filePath: string;
      id: string;
      rawBytes: number;
      status: "found";
    }
  | { id: string; status: "expired" | "missing" }
  | {
      error?: string;
      id: string;
      reason: ColdObjectCorruptionReason;
      status: "corrupt";
    };

export type ColdStorageDeletionReason = "expiry" | "orphan" | "size";
export type ColdStorageFileStatus = "deleted" | "failed" | "missing";

export interface DeletedColdObject {
  error?: string;
  filePath: string;
  fileStatus: ColdStorageFileStatus;
  id: string;
  rawBytes: number;
  reason: ColdStorageDeletionReason;
}

export interface ColdStorageCleanupOptions {
  now?: Date;
  reserveBytes?: number;
}

export interface ColdStorageCleanupResult {
  afterBytes: number;
  beforeBytes: number;
  completedAt: string;
  deletedBytes: number;
  deletedObjects: DeletedColdObject[];
  errorCount: number;
  expiredReferenceIds: string[];
  runId: string;
  startedAt: string;
  status: "completed" | "completed_with_errors";
}

interface ColdObjectRow {
  content_hash: string;
  created_at: string;
  id: string;
  raw_bytes: number;
  relative_path: string;
}

interface ColdObjectReferenceRow {
  cold_object_id: string;
  created_at: string;
  expires_at: string | null;
  id: string;
}

interface PlannedColdObjectDeletion extends ColdObjectRow {
  reason: ColdStorageDeletionReason;
}

export const DEFAULT_COLD_STORAGE_POLICY: ColdStoragePolicy = {
  enabled: DEFAULT_CONFIG.coldStorage.enabled,
  maxBytes: DEFAULT_CONFIG.coldStorage.maxBytes,
  retentionDays: DEFAULT_CONFIG.retention.coldStorageDays,
};

export const coldStoragePolicyFromConfig = (config: SzalConfig): ColdStoragePolicy => ({
  enabled: config.coldStorage.enabled,
  maxBytes: config.coldStorage.maxBytes,
  retentionDays: config.retention.coldStorageDays,
});

const hashContent = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const identityForHash = (
  paths: StoragePaths,
  contentHash: string,
): { filePath: string; id: string; relativePath: string } => {
  const id = `szal://cold/sha256/${contentHash}`;
  const relativePath = join("sha256", contentHash.slice(0, 2), contentHash);
  return { filePath: join(paths.coldDirectory, relativePath), id, relativePath };
};

const isFileSystemError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const normalizeDate = (value: string | Date, label: string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date.`);
  }
  return date.toISOString();
};

const addRetentionDays = (createdAt: string, retentionDays: number): string => {
  const expiresAt = new Date(new Date(createdAt).getTime() + retentionDays * DAY_MILLISECONDS);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Cold storage retention produces an invalid expiry date.");
  }
  return expiresAt.toISOString();
};

const assertNonNegativeInteger = (value: unknown, label: string): void => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
};

const validatePolicy = (policy: ColdStoragePolicy): void => {
  if (typeof policy.enabled !== "boolean") {
    throw new Error("Cold storage enabled must be a boolean.");
  }
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new Error("Cold storage maxBytes must be a positive integer.");
  }
  assertNonNegativeInteger(policy.retentionDays, "Cold storage retentionDays");
};

const validateMetadata = (metadata: ColdObjectMetadata): void => {
  if (metadata.category.trim().length === 0) {
    throw new Error("Cold object category must not be empty.");
  }
  if (metadata.referenceId !== undefined && metadata.referenceId.trim().length === 0) {
    throw new Error("Cold object referenceId must not be empty.");
  }
  if (metadata.rawTokens !== undefined) {
    assertNonNegativeInteger(metadata.rawTokens, "Cold object rawTokens");
  }
  if (metadata.compressedTokens !== undefined) {
    assertNonNegativeInteger(metadata.compressedTokens, "Cold object compressedTokens");
  }
};

const resolveExpiry = (
  metadata: ColdObjectMetadata,
  policy: ColdStoragePolicy,
  createdAt: string,
  now: string,
): string | null => {
  const requestedExpiry =
    metadata.expiresAt === undefined
      ? undefined
      : normalizeDate(metadata.expiresAt, "Cold object expiresAt");
  const retentionExpiry =
    policy.retentionDays === 0 ? undefined : addRetentionDays(createdAt, policy.retentionDays);
  const expiresAt =
    requestedExpiry === undefined
      ? retentionExpiry
      : retentionExpiry === undefined || requestedExpiry < retentionExpiry
        ? requestedExpiry
        : retentionExpiry;

  if (expiresAt !== undefined && expiresAt <= createdAt) {
    throw new Error("Cold object expiresAt must be later than createdAt.");
  }
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new Error("Cold object expiresAt must be in the future.");
  }
  return expiresAt ?? null;
};

// Publish a fully written payload with a hard link so concurrent writers never expose partial data.
const writeColdPayload = (filePath: string, content: Uint8Array, contentHash: string): boolean => {
  const directory = dirname(filePath);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  let published = false;

  if (!existsSync(filePath)) {
    const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
      try {
        linkSync(temporaryPath, filePath);
        published = true;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) {
          throw error;
        }
      }
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }

  const storedContent = readFileSync(filePath);
  if (
    storedContent.byteLength !== content.byteLength ||
    hashContent(storedContent) !== contentHash
  ) {
    throw new Error(`Cold object ${contentHash} failed its integrity check.`);
  }
  chmodSync(filePath, 0o600);
  return published;
};

const effectiveReferenceExpiry = (
  reference: ColdObjectReferenceRow,
  retentionDays: number,
): string | undefined => {
  const configuredExpiry =
    reference.expires_at === null
      ? undefined
      : normalizeDate(reference.expires_at, `Cold reference ${reference.id} expires_at`);
  if (retentionDays === 0) {
    return configuredExpiry;
  }
  const retentionExpiry = addRetentionDays(
    normalizeDate(reference.created_at, `Cold reference ${reference.id} created_at`),
    retentionDays,
  );
  return configuredExpiry === undefined || retentionExpiry < configuredExpiry
    ? retentionExpiry
    : configuredExpiry;
};

const deleteColdPayload = (
  paths: StoragePaths,
  object: PlannedColdObjectDeletion,
): Omit<DeletedColdObject, "id" | "rawBytes" | "reason"> => {
  if (!CONTENT_HASH_PATTERN.test(object.content_hash)) {
    return {
      error: "Stored content hash is invalid; no file was deleted.",
      filePath: join(paths.coldDirectory, object.relative_path),
      fileStatus: "failed",
    };
  }
  const identity = identityForHash(paths, object.content_hash);
  if (object.id !== identity.id || object.relative_path !== identity.relativePath) {
    return {
      error: "Stored cold object identity does not match its content hash; no file was deleted.",
      filePath: identity.filePath,
      fileStatus: "failed",
    };
  }

  try {
    unlinkSync(identity.filePath);
    try {
      rmdirSync(dirname(identity.filePath));
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "ENOTEMPTY")) {
        throw error;
      }
    }
    return { filePath: identity.filePath, fileStatus: "deleted" };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { filePath: identity.filePath, fileStatus: "missing" };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      filePath: identity.filePath,
      fileStatus: "failed",
    };
  }
};

const executeCleanup = (
  database: BetterSqlite3.Database,
  paths: StoragePaths,
  policy: ColdStoragePolicy,
  startedAt: string,
  reserveBytes: number,
  protectedObjectId?: string,
  rejectionObjectId?: string,
): ColdStorageCleanupResult => {
  const runId = randomUUID();
  const beforeBytes = Number(
    database.prepare("SELECT COALESCE(SUM(raw_bytes), 0) FROM cold_objects").pluck().get(),
  );
  database
    .prepare(
      `INSERT INTO cold_storage_cleanup_runs (
         id, status, retention_days, max_bytes, reserved_bytes, before_bytes,
         after_bytes, started_at
       ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      policy.retentionDays,
      policy.maxBytes,
      reserveBytes,
      beforeBytes,
      beforeBytes,
      startedAt,
    );

  const references = database
    .prepare(
      `SELECT id, cold_object_id, created_at, expires_at
         FROM cold_object_references
        ORDER BY created_at, id`,
    )
    .all() as ColdObjectReferenceRow[];
  const expiredReferences = references
    .map((reference) => ({
      expiresAt: effectiveReferenceExpiry(reference, policy.retentionDays),
      reference,
    }))
    .filter(
      (entry): entry is { expiresAt: string; reference: ColdObjectReferenceRow } =>
        entry.expiresAt !== undefined && entry.expiresAt <= startedAt,
    )
    .sort(
      (left, right) =>
        left.expiresAt.localeCompare(right.expiresAt) ||
        left.reference.id.localeCompare(right.reference.id),
    );
  const expiredReferenceIds = new Set(
    expiredReferences.map(({ reference }) => reference.id),
  );
  const activeReferences = references.filter(
    (reference) => !expiredReferenceIds.has(reference.id),
  );
  const activeReferenceCount = new Map<string, number>();
  for (const reference of activeReferences) {
    activeReferenceCount.set(
      reference.cold_object_id,
      (activeReferenceCount.get(reference.cold_object_id) ?? 0) + 1,
    );
  }

  const objects = database
    .prepare(
      "SELECT id, content_hash, relative_path, raw_bytes, created_at FROM cold_objects",
    )
    .all() as ColdObjectRow[];
  const normalizedObjectCreatedAt = new Map(
    objects.map((object) => [
      object.id,
      normalizeDate(object.created_at, `Cold object ${object.id} created_at`),
    ]),
  );
  const expiredObjectIds = new Set(
    expiredReferences.map(({ reference }) => reference.cold_object_id),
  );
  const orphanedObjects = objects
    .filter((object) => (activeReferenceCount.get(object.id) ?? 0) === 0)
    .sort(
      (left, right) =>
        (normalizedObjectCreatedAt.get(left.id) ?? "").localeCompare(
          normalizedObjectCreatedAt.get(right.id) ?? "",
        ) || left.id.localeCompare(right.id),
    )
    .map(
      (object): PlannedColdObjectDeletion => ({
        ...object,
        reason: expiredObjectIds.has(object.id) ? "expiry" : "orphan",
      }),
    );
  const oldestActiveReference = new Map<string, string>();
  for (const reference of activeReferences) {
    const createdAt = normalizeDate(
      reference.created_at,
      `Cold reference ${reference.id} created_at`,
    );
    const oldest = oldestActiveReference.get(reference.cold_object_id);
    if (oldest === undefined || createdAt < oldest) {
      oldestActiveReference.set(reference.cold_object_id, createdAt);
    }
  }
  const evictionCandidates = objects
    .filter(
      (object) =>
        (activeReferenceCount.get(object.id) ?? 0) > 0 && object.id !== protectedObjectId,
    )
    .sort(
      (left, right) =>
        (oldestActiveReference.get(left.id) ?? "").localeCompare(
          oldestActiveReference.get(right.id) ?? "",
        ) ||
        (normalizedObjectCreatedAt.get(left.id) ?? "").localeCompare(
          normalizedObjectCreatedAt.get(right.id) ?? "",
        ) ||
        left.id.localeCompare(right.id),
    )
    .map((object): PlannedColdObjectDeletion => ({ ...object, reason: "size" }));

  const insertItem = database.prepare(
    `INSERT INTO cold_storage_cleanup_items (
       run_id, item_kind, record_id, reason, relative_path, raw_bytes, file_status, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const clearCompressionEvent = database.prepare(
    "UPDATE compression_events SET cold_object_reference_id = NULL WHERE cold_object_reference_id = ?",
  );
  const deleteReference = database.prepare("DELETE FROM cold_object_references WHERE id = ?");
  const listObjectReferences = database
    .prepare("SELECT id FROM cold_object_references WHERE cold_object_id = ? ORDER BY id")
    .pluck();
  const clearRecall = database.prepare(
    "UPDATE recalls SET cold_object_id = NULL WHERE cold_object_id = ?",
  );
  const deleteObjectReferences = database.prepare(
    "DELETE FROM cold_object_references WHERE cold_object_id = ?",
  );
  const deleteObject = database.prepare("DELETE FROM cold_objects WHERE id = ?");
  const removedExpiredReferenceIds: string[] = [];
  const removedExpiredReferenceIdSet = new Set<string>();
  const deletedObjects: DeletedColdObject[] = [];
  let afterBytes = beforeBytes;

  const removeObject = (object: PlannedColdObjectDeletion): void => {
    const fileResult = deleteColdPayload(paths, object);
    if (fileResult.fileStatus !== "failed") {
      const referenceIds = listObjectReferences.all(object.id) as string[];
      for (const referenceId of referenceIds) {
        if (expiredReferenceIds.has(referenceId)) {
          insertItem.run(
            runId,
            "reference",
            referenceId,
            "expiry",
            null,
            null,
            "not_applicable",
            null,
          );
          removedExpiredReferenceIds.push(referenceId);
          removedExpiredReferenceIdSet.add(referenceId);
        }
        clearCompressionEvent.run(referenceId);
      }
      deleteObjectReferences.run(object.id);
      clearRecall.run(object.id);
      deleteObject.run(object.id);
      afterBytes -= object.raw_bytes;
    }
    insertItem.run(
      runId,
      "object",
      object.id,
      object.reason,
      object.relative_path,
      object.raw_bytes,
      fileResult.fileStatus,
      fileResult.error ?? null,
    );
    deletedObjects.push({
      ...fileResult,
      id: object.id,
      rawBytes: object.raw_bytes,
      reason: object.reason,
    });
  };

  for (const object of orphanedObjects) {
    removeObject(object);
  }

  const retainedFailedObjectIds = new Set(
    deletedObjects
      .filter(({ fileStatus }) => fileStatus === "failed")
      .map(({ id }) => id),
  );
  for (const { reference } of expiredReferences) {
    if (
      removedExpiredReferenceIdSet.has(reference.id) ||
      retainedFailedObjectIds.has(reference.cold_object_id)
    ) {
      continue;
    }
    insertItem.run(runId, "reference", reference.id, "expiry", null, null, "not_applicable", null);
    clearCompressionEvent.run(reference.id);
    deleteReference.run(reference.id);
    removedExpiredReferenceIds.push(reference.id);
    removedExpiredReferenceIdSet.add(reference.id);
  }

  const targetBytes = policy.maxBytes - reserveBytes;
  for (const object of evictionCandidates) {
    if (afterBytes <= targetBytes) {
      break;
    }
    removeObject(object);
  }
  if (afterBytes > targetBytes && rejectionObjectId !== undefined) {
    const rejectionObject = objects.find(({ id }) => id === rejectionObjectId);
    if (rejectionObject !== undefined) {
      removeObject({ ...rejectionObject, reason: "size" });
    }
  }

  const errorCount = deletedObjects.filter(
    ({ fileStatus }) => fileStatus === "failed" || fileStatus === "missing",
  ).length;
  const status = errorCount === 0 ? "completed" : "completed_with_errors";
  const deletedBytes = deletedObjects
    .filter(({ fileStatus }) => fileStatus !== "failed")
    .reduce((total, object) => total + object.rawBytes, 0);
  const deletedObjectCount = deletedObjects.filter(
    ({ fileStatus }) => fileStatus !== "failed",
  ).length;
  const completedAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE cold_storage_cleanup_runs
          SET status = ?, after_bytes = ?, expired_references = ?, deleted_objects = ?,
              deleted_bytes = ?, error_count = ?, completed_at = ?
        WHERE id = ?`,
    )
    .run(
      status,
      afterBytes,
      removedExpiredReferenceIds.length,
      deletedObjectCount,
      deletedBytes,
      errorCount,
      completedAt,
      runId,
    );

  return {
    afterBytes,
    beforeBytes,
    completedAt,
    deletedBytes,
    deletedObjects,
    errorCount,
    expiredReferenceIds: removedExpiredReferenceIds,
    runId,
    startedAt,
    status,
  };
};

// Remove expired and over-limit data in stable order and persist an audit for every decision.
export const cleanupColdStorage = (
  database: BetterSqlite3.Database,
  paths: StoragePaths,
  policy: ColdStoragePolicy = DEFAULT_COLD_STORAGE_POLICY,
  options: ColdStorageCleanupOptions = {},
): ColdStorageCleanupResult => {
  validatePolicy(policy);
  const reserveBytes = options.reserveBytes ?? 0;
  assertNonNegativeInteger(reserveBytes, "Cold storage reserveBytes");
  if (reserveBytes > policy.maxBytes) {
    throw new Error("Reserved bytes exceed the configured cold storage limit.");
  }
  const startedAt = normalizeDate(options.now ?? new Date(), "Cold storage cleanup time");
  return database
    .transaction(() => executeCleanup(database, paths, policy, startedAt, reserveBytes))
    .immediate();
};

// Read canonical bytes only after checking expiry, metadata identity, size, and content hash.
export const readColdObject = (
  database: BetterSqlite3.Database,
  paths: StoragePaths,
  id: string,
  options: ReadColdObjectOptions = {},
): ColdObjectReadResult => {
  const object = database
    .prepare(
      "SELECT id, content_hash, relative_path, raw_bytes, created_at FROM cold_objects WHERE id = ?",
    )
    .get(id) as ColdObjectRow | undefined;
  if (object === undefined) {
    return { id, status: "missing" };
  }

  const now = normalizeDate(options.now ?? new Date(), "Cold object read time");
  if (options.allowExpired !== true) {
    const references = database
      .prepare("SELECT id, expires_at FROM cold_object_references WHERE cold_object_id = ?")
      .all(id) as Array<{ expires_at: string | null; id: string }>;
    let hasActiveReference: boolean;
    try {
      hasActiveReference = references.some(
        ({ expires_at: expiresAt, id: referenceId }) =>
          expiresAt === null ||
          normalizeDate(expiresAt, `Cold reference ${referenceId} expires_at`) > now,
      );
    } catch {
      return { id, reason: "metadata-mismatch", status: "corrupt" };
    }
    if (references.length > 0 && !hasActiveReference) {
      return { id, status: "expired" };
    }
  }

  if (!CONTENT_HASH_PATTERN.test(object.content_hash)) {
    return { id, reason: "metadata-mismatch", status: "corrupt" };
  }
  const identity = identityForHash(paths, object.content_hash);
  if (object.id !== identity.id || object.relative_path !== identity.relativePath) {
    return { id, reason: "metadata-mismatch", status: "corrupt" };
  }

  let content: Buffer;
  try {
    content = readFileSync(identity.filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { id, reason: "missing-file", status: "corrupt" };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      id,
      reason: "unreadable",
      status: "corrupt",
    };
  }
  if (content.byteLength !== object.raw_bytes) {
    return { id, reason: "size-mismatch", status: "corrupt" };
  }
  if (hashContent(content) !== object.content_hash) {
    return { id, reason: "hash-mismatch", status: "corrupt" };
  }
  return {
    content,
    contentHash: object.content_hash,
    filePath: identity.filePath,
    id,
    rawBytes: object.raw_bytes,
    status: "found",
  };
};

// Store canonical bytes after applying configured retention and capacity policy.
export const storeColdObject = (
  database: BetterSqlite3.Database,
  paths: StoragePaths,
  content: string | Uint8Array,
  metadata: ColdObjectMetadata,
  options: StoreColdObjectOptions = {},
): StoredColdObject => {
  validateMetadata(metadata);
  const policy = options.policy ?? DEFAULT_COLD_STORAGE_POLICY;
  validatePolicy(policy);
  if (!policy.enabled) {
    throw new Error("Cold storage is disabled by configuration.");
  }

  const nowDate = options.now ?? new Date();
  const now = normalizeDate(nowDate, "Cold object store time");
  const createdAt = normalizeDate(metadata.createdAt ?? now, "Cold object createdAt");
  const expiresAt = resolveExpiry(metadata, policy, createdAt, now);
  const contentBytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (contentBytes.byteLength > policy.maxBytes) {
    throw new Error(
      `Cold object size ${String(contentBytes.byteLength)} exceeds the configured cold storage limit of ${String(policy.maxBytes)} bytes.`,
    );
  }
  const contentHash = hashContent(contentBytes);
  const identity = identityForHash(paths, contentHash);
  const referenceId = metadata.referenceId ?? randomUUID();
  let published = false;
  const recordMetadata = database.transaction(() => {
    if (
      database.prepare("SELECT 1 FROM cold_object_references WHERE id = ?").pluck().get(referenceId) !==
      undefined
    ) {
      throw new Error(`Cold object reference ${referenceId} already exists.`);
    }
    const objectExists =
      database.prepare("SELECT 1 FROM cold_objects WHERE id = ?").pluck().get(identity.id) !==
      undefined;
    published = writeColdPayload(identity.filePath, contentBytes, contentHash);
    database
      .prepare(
        `INSERT INTO cold_objects (id, content_hash, relative_path, raw_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(identity.id, contentHash, identity.relativePath, contentBytes.byteLength, createdAt);
    const storedObject = database
      .prepare("SELECT content_hash, relative_path, raw_bytes FROM cold_objects WHERE id = ?")
      .get(identity.id) as
      { content_hash: string; raw_bytes: number; relative_path: string } | undefined;
    if (
      storedObject === undefined ||
      storedObject.content_hash !== contentHash ||
      storedObject.relative_path !== identity.relativePath ||
      storedObject.raw_bytes !== contentBytes.byteLength
    ) {
      throw new Error(`Cold object ${identity.id} has inconsistent database metadata.`);
    }
    database
      .prepare(
        `INSERT INTO cold_object_references (
           id, cold_object_id, session_id, project_id, category, raw_tokens,
           compressed_tokens, compressor, compression_mode, source_tool,
           source_path, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        referenceId,
        identity.id,
        metadata.sessionId ?? null,
        metadata.projectId ?? null,
        metadata.category.trim(),
        metadata.rawTokens ?? null,
        metadata.compressedTokens ?? null,
        metadata.compressor ?? null,
        metadata.compressionMode ?? null,
        metadata.sourceTool ?? null,
        metadata.sourcePath ?? null,
        createdAt,
        expiresAt,
      );

    const cleanup = executeCleanup(
      database,
      paths,
      policy,
      now,
      0,
      identity.id,
      objectExists ? undefined : identity.id,
    );
    const referenceRetained =
      database.prepare("SELECT 1 FROM cold_object_references WHERE id = ?").pluck().get(referenceId) !==
      undefined;
    if (cleanup.afterBytes <= policy.maxBytes && referenceRetained) {
      return undefined;
    }

    if (referenceRetained) {
      database.prepare("DELETE FROM cold_object_references WHERE id = ?").run(referenceId);
    }
    return cleanup.runId;
  });

  let capacityCleanupRunId: string | undefined;
  try {
    capacityCleanupRunId = recordMetadata.immediate();
  } catch (error) {
    const recorded =
      database.prepare("SELECT 1 FROM cold_objects WHERE id = ?").pluck().get(identity.id) !==
      undefined;
    if (published && !recorded && existsSync(identity.filePath)) {
      unlinkSync(identity.filePath);
    }
    throw error;
  }
  if (capacityCleanupRunId !== undefined) {
    throw new Error(
      `Cold storage cleanup ${capacityCleanupRunId} could not enforce the configured storage limit.`,
    );
  }

  return {
    contentHash,
    expiresAt,
    filePath: identity.filePath,
    id: identity.id,
    referenceId,
  };
};
