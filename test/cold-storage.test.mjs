import assert from "node:assert/strict";
import { dirname } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupColdStorage,
  openSzalDatabase,
  readColdObject,
  storeColdObject,
} from "../dist/core/storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const START = new Date("2026-01-01T00:00:00.000Z");

const createStorage = () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cold-storage-"));
  const database = openSzalDatabase({ environment: {}, homeDirectory });
  return { database, homeDirectory };
};

const closeStorage = ({ database, homeDirectory }) => {
  database.connection.close();
  rmSync(homeDirectory, { force: true, recursive: true });
};

test("cold objects preserve byte-exact content and complete immutable metadata", () => {
  const storage = createStorage();
  const payload = Buffer.from([0, 1, 2, 10, 13, 255]);
  const expiresAt = new Date(START.getTime() + 2 * DAY_MS).toISOString();

  try {
    storage.database.connection
      .prepare("INSERT INTO projects (id, root_path) VALUES (?, ?)")
      .run("project-1", "/workspace/project-1");
    storage.database.connection
      .prepare("INSERT INTO sessions (id, project_id, host, mode) VALUES (?, ?, ?, ?)")
      .run("session-1", "project-1", "claude", "on");

    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      payload,
      {
        category: "tool_output",
        compressedTokens: 2,
        compressionMode: "balanced",
        compressor: "llmtrim",
        createdAt: START.toISOString(),
        expiresAt,
        projectId: "project-1",
        rawTokens: 8,
        referenceId: "reference-1",
        sessionId: "session-1",
        sourcePath: "/workspace/project-1/output.bin",
        sourceTool: "shell",
      },
      { now: START },
    );
    const read = readColdObject(storage.database.connection, storage.database.paths, stored.id, {
      now: START,
    });
    const reference = storage.database.connection
      .prepare(
        `SELECT session_id, project_id, category, raw_tokens, compressed_tokens,
                compressor, compression_mode, source_tool, source_path, created_at, expires_at
           FROM cold_object_references WHERE id = ?`,
      )
      .get("reference-1");

    assert.equal(read.status, "found");
    assert.deepEqual(Buffer.from(read.content), payload);
    assert.deepEqual(reference, {
      category: "tool_output",
      compressed_tokens: 2,
      compression_mode: "balanced",
      compressor: "llmtrim",
      created_at: START.toISOString(),
      expires_at: expiresAt,
      project_id: "project-1",
      raw_tokens: 8,
      session_id: "session-1",
      source_path: "/workspace/project-1/output.bin",
      source_tool: "shell",
    });
    assert.equal(statSync(stored.filePath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(stored.filePath)).mode & 0o777, 0o700);
  } finally {
    closeStorage(storage);
  }
});

test("cold reads distinguish expired, missing, and corrupt objects", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 1_000, retentionDays: 1 };

  try {
    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "canonical",
      { category: "conversation", createdAt: START.toISOString(), referenceId: "reference-1" },
      { now: START, policy },
    );

    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, stored.id, {
        now: new Date(START.getTime() + DAY_MS + 1),
      }).status,
      "expired",
    );
    assert.equal(
      readColdObject(
        storage.database.connection,
        storage.database.paths,
        "szal://cold/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).status,
      "missing",
    );

    writeFileSync(stored.filePath, "tampered!");
    const corrupt = readColdObject(storage.database.connection, storage.database.paths, stored.id, {
      allowExpired: true,
    });
    assert.equal(corrupt.status, "corrupt");
    assert.equal(corrupt.reason, "hash-mismatch");
  } finally {
    closeStorage(storage);
  }
});

test("cold reads reject database paths that do not match the content identity", () => {
  const storage = createStorage();

  try {
    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "canonical",
      { category: "conversation", referenceId: "reference-1" },
    );
    storage.database.connection
      .prepare("UPDATE cold_objects SET relative_path = ? WHERE id = ?")
      .run("../../outside", stored.id);

    const read = readColdObject(storage.database.connection, storage.database.paths, stored.id);
    assert.equal(read.status, "corrupt");
    assert.equal(read.reason, "metadata-mismatch");
  } finally {
    closeStorage(storage);
  }
});

test("retention cleanup removes expired references only when their content is no longer needed", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 1_000, retentionDays: 0 };
  const payload = "shared canonical bytes";

  try {
    const first = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      payload,
      {
        category: "conversation",
        createdAt: START.toISOString(),
        expiresAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-1",
      },
      { now: START, policy },
    );
    storeColdObject(
      storage.database.connection,
      storage.database.paths,
      payload,
      {
        category: "conversation",
        createdAt: START.toISOString(),
        expiresAt: new Date(START.getTime() + 3 * DAY_MS).toISOString(),
        referenceId: "reference-2",
      },
      { now: START, policy },
    );

    const partialCleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      policy,
      { now: new Date(START.getTime() + 2 * DAY_MS) },
    );
    assert.deepEqual(partialCleanup.expiredReferenceIds, ["reference-1"]);
    assert.deepEqual(partialCleanup.deletedObjects, []);
    assert.equal(readFileSync(first.filePath, "utf8"), payload);

    const completeCleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      policy,
      { now: new Date(START.getTime() + 4 * DAY_MS) },
    );
    assert.deepEqual(completeCleanup.expiredReferenceIds, ["reference-2"]);
    assert.deepEqual(
      completeCleanup.deletedObjects.map(({ id, reason }) => ({ id, reason })),
      [{ id: first.id, reason: "expiry" }],
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, first.id).status,
      "missing",
    );
    assert.deepEqual(
      storage.database.connection
        .prepare(
          "SELECT status, expired_references FROM cold_storage_cleanup_runs WHERE id = ?",
        )
        .get(completeCleanup.runId),
      { expired_references: 1, status: "completed" },
    );
    assert.deepEqual(
      storage.database.connection
        .prepare(
          "SELECT item_kind, record_id, reason, file_status FROM cold_storage_cleanup_items WHERE run_id = ? ORDER BY id",
        )
        .all(completeCleanup.runId),
      [
        {
          file_status: "not_applicable",
          item_kind: "reference",
          reason: "expiry",
          record_id: "reference-2",
        },
        {
          file_status: "deleted",
          item_kind: "object",
          reason: "expiry",
          record_id: first.id,
        },
      ],
    );
  } finally {
    closeStorage(storage);
  }
});

test("size enforcement evicts the oldest object deterministically and rejects oversized writes", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 8, retentionDays: 0 };

  try {
    const first = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "first",
      { category: "memory", createdAt: START.toISOString(), referenceId: "reference-1" },
      { now: START, policy },
    );
    const second = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "second",
      {
        category: "memory",
        createdAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-2",
      },
      { now: new Date(START.getTime() + DAY_MS), policy },
    );

    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, first.id).status,
      "missing",
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, second.id).status,
      "found",
    );
    assert.equal(
      storage.database.connection.prepare("SELECT SUM(raw_bytes) FROM cold_objects").pluck().get(),
      6,
    );
    assert.equal(
      storage.database.connection
        .prepare("SELECT COUNT(*) FROM cold_storage_cleanup_items WHERE reason = 'size'")
        .pluck()
        .get(),
      1,
    );
    assert.throws(
      () =>
        storeColdObject(
          storage.database.connection,
          storage.database.paths,
          "too-large",
          { category: "memory" },
          { policy },
        ),
      /exceeds the configured cold storage limit/i,
    );
  } finally {
    closeStorage(storage);
  }
});

test("size enforcement orders legacy offset timestamps chronologically", () => {
  const storage = createStorage();
  const initialPolicy = { enabled: true, maxBytes: 12, retentionDays: 0 };
  const reducedPolicy = { enabled: true, maxBytes: 6, retentionDays: 0 };

  try {
    const earlier = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", referenceId: "reference-1" },
      { policy: initialPolicy },
    );
    const later = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "bbbbbb",
      { category: "memory", referenceId: "reference-2" },
      { policy: initialPolicy },
    );
    storage.database.connection
      .prepare("UPDATE cold_object_references SET created_at = ? WHERE id = ?")
      .run("2026-01-01T01:00:00+02:00", "reference-1");
    storage.database.connection
      .prepare("UPDATE cold_object_references SET created_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00Z", "reference-2");
    storage.database.connection
      .prepare("UPDATE cold_objects SET created_at = ? WHERE id = ?")
      .run("2026-01-01T01:00:00+02:00", earlier.id);
    storage.database.connection
      .prepare("UPDATE cold_objects SET created_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00Z", later.id);

    cleanupColdStorage(storage.database.connection, storage.database.paths, reducedPolicy);

    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, earlier.id).status,
      "missing",
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, later.id).status,
      "found",
    );
  } finally {
    closeStorage(storage);
  }
});

test("deduplicated stores preserve prior references while enforcing a reduced limit", () => {
  const storage = createStorage();
  const originalPolicy = { enabled: true, maxBytes: 10, retentionDays: 0 };
  const reducedPolicy = { enabled: true, maxBytes: 8, retentionDays: 0 };

  try {
    const first = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", createdAt: START.toISOString(), referenceId: "reference-1" },
      { now: START, policy: originalPolicy },
    );
    const second = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "bbbb",
      {
        category: "memory",
        createdAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-2",
      },
      { now: new Date(START.getTime() + DAY_MS), policy: originalPolicy },
    );

    storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      {
        category: "memory",
        createdAt: new Date(START.getTime() + 2 * DAY_MS).toISOString(),
        referenceId: "reference-3",
      },
      { now: new Date(START.getTime() + 2 * DAY_MS), policy: reducedPolicy },
    );

    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, first.id).status,
      "found",
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, second.id).status,
      "missing",
    );
    assert.deepEqual(
      storage.database.connection
        .prepare("SELECT id FROM cold_object_references WHERE cold_object_id = ? ORDER BY id")
        .pluck()
        .all(first.id),
      ["reference-1", "reference-3"],
    );
  } finally {
    closeStorage(storage);
  }
});

test("invalid new references cannot trigger capacity eviction", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 10, retentionDays: 0 };

  try {
    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", referenceId: "reference-1" },
      { policy },
    );

    assert.throws(
      () =>
        storeColdObject(
          storage.database.connection,
          storage.database.paths,
          "bbbbbb",
          { category: "memory", referenceId: "reference-1" },
          { policy },
        ),
      /reference reference-1 already exists/i,
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, stored.id).status,
      "found",
    );
    assert.equal(
      storage.database.connection.prepare("SELECT SUM(raw_bytes) FROM cold_objects").pluck().get(),
      6,
    );
    assert.equal(
      storage.database.connection
        .prepare("SELECT COUNT(*) FROM cold_storage_cleanup_items WHERE reason = 'size'")
        .pluck()
        .get(),
      0,
    );
  } finally {
    closeStorage(storage);
  }
});

test("capacity rejection audits compensating payload deletion", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 10, retentionDays: 0 };
  let payloadDirectory;

  try {
    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", referenceId: "reference-1" },
      { policy },
    );
    payloadDirectory = dirname(stored.filePath);
    chmodSync(payloadDirectory, 0o500);

    assert.throws(
      () =>
        storeColdObject(
          storage.database.connection,
          storage.database.paths,
          "bbbbbb",
          { category: "memory", referenceId: "reference-2" },
          { policy },
        ),
      /could not enforce the configured storage limit/i,
    );

    const run = storage.database.connection
      .prepare(
        `SELECT id, status, before_bytes, after_bytes, deleted_objects, deleted_bytes, error_count
           FROM cold_storage_cleanup_runs
          ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get();
    assert.deepEqual(
      {
        after_bytes: run.after_bytes,
        before_bytes: run.before_bytes,
        deleted_bytes: run.deleted_bytes,
        deleted_objects: run.deleted_objects,
        error_count: run.error_count,
        status: run.status,
      },
      {
        after_bytes: 6,
        before_bytes: 12,
        deleted_bytes: 6,
        deleted_objects: 1,
        error_count: 1,
        status: "completed_with_errors",
      },
    );
    assert.deepEqual(
      storage.database.connection
        .prepare(
          `SELECT reason, raw_bytes, file_status
             FROM cold_storage_cleanup_items
            WHERE run_id = ? AND item_kind = 'object'
            ORDER BY id`,
        )
        .all(run.id),
      [
        { file_status: "failed", raw_bytes: 6, reason: "size" },
        { file_status: "deleted", raw_bytes: 6, reason: "size" },
      ],
    );
    assert.equal(
      readColdObject(storage.database.connection, storage.database.paths, stored.id).status,
      "found",
    );
    assert.equal(
      storage.database.connection.prepare("SELECT COUNT(*) FROM cold_objects").pluck().get(),
      1,
    );
    assert.equal(
      storage.database.connection
        .prepare("SELECT COUNT(*) FROM cold_object_references WHERE id = ?")
        .pluck()
        .get("reference-2"),
      0,
    );
  } finally {
    if (payloadDirectory !== undefined) {
      chmodSync(payloadDirectory, 0o700);
    }
    closeStorage(storage);
  }
});

test("cleanup retries failed size deletions after reaching the size target", () => {
  const storage = createStorage();
  const initialPolicy = { enabled: true, maxBytes: 12, retentionDays: 0 };
  const reducedPolicy = { enabled: true, maxBytes: 6, retentionDays: 0 };
  let payloadDirectory;

  try {
    const first = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", createdAt: START.toISOString(), referenceId: "reference-1" },
      { now: START, policy: initialPolicy },
    );
    const second = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "bbbbbb",
      {
        category: "memory",
        createdAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-2",
      },
      { now: new Date(START.getTime() + DAY_MS), policy: initialPolicy },
    );
    payloadDirectory = dirname(first.filePath);
    chmodSync(payloadDirectory, 0o500);

    const initialCleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      reducedPolicy,
    );
    assert.equal(initialCleanup.afterBytes, 6);
    assert.deepEqual(
      initialCleanup.deletedObjects.map(({ fileStatus, id }) => ({ fileStatus, id })),
      [
        { fileStatus: "failed", id: first.id },
        { fileStatus: "deleted", id: second.id },
      ],
    );

    chmodSync(payloadDirectory, 0o700);
    payloadDirectory = undefined;
    const retry = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      reducedPolicy,
    );

    assert.equal(retry.beforeBytes, 6);
    assert.equal(retry.afterBytes, 0);
    assert.deepEqual(
      retry.deletedObjects.map(({ fileStatus, id, reason }) => ({ fileStatus, id, reason })),
      [{ fileStatus: "deleted", id: first.id, reason: "size" }],
    );
    assert.deepEqual(
      storage.database.connection
        .prepare(
          `SELECT record_id, reason, file_status
             FROM cold_storage_cleanup_items
            WHERE run_id = ? AND item_kind = 'object'`,
        )
        .all(retry.runId),
      [{ file_status: "deleted", reason: "size", record_id: first.id }],
    );
  } finally {
    if (payloadDirectory !== undefined) {
      chmodSync(payloadDirectory, 0o700);
    }
    closeStorage(storage);
  }
});

test("failed expiry attempts do not cancel pending size retries", () => {
  const storage = createStorage();
  const initialPolicy = { enabled: true, maxBytes: 12, retentionDays: 0 };
  const reducedPolicy = { enabled: true, maxBytes: 6, retentionDays: 0 };
  let payloadDirectory;

  try {
    const first = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      {
        category: "memory",
        createdAt: START.toISOString(),
        expiresAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-1",
      },
      { now: START, policy: initialPolicy },
    );
    const secondTime = new Date(START.getTime() + 60 * 60 * 1_000);
    storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "bbbbbb",
      { category: "memory", createdAt: secondTime.toISOString(), referenceId: "reference-2" },
      { now: secondTime, policy: initialPolicy },
    );
    payloadDirectory = dirname(first.filePath);
    chmodSync(payloadDirectory, 0o500);

    const sizeCleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      reducedPolicy,
      { now: new Date(START.getTime() + 2 * 60 * 60 * 1_000) },
    );
    assert.deepEqual(
      sizeCleanup.deletedObjects.map(({ fileStatus, reason }) => ({ fileStatus, reason })),
      [
        { fileStatus: "failed", reason: "size" },
        { fileStatus: "deleted", reason: "size" },
      ],
    );

    const expiryTime = new Date(START.getTime() + 2 * DAY_MS);
    const expiryCleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      reducedPolicy,
      { now: expiryTime },
    );
    assert.deepEqual(
      expiryCleanup.deletedObjects.map(({ fileStatus, reason }) => ({ fileStatus, reason })),
      [{ fileStatus: "failed", reason: "expiry" }],
    );

    chmodSync(payloadDirectory, 0o700);
    payloadDirectory = undefined;
    storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "aaaaaa",
      { category: "memory", referenceId: "reference-3" },
      { now: expiryTime, policy: reducedPolicy },
    );
    const retry = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      reducedPolicy,
      { now: expiryTime },
    );

    assert.equal(retry.beforeBytes, 6);
    assert.equal(retry.afterBytes, 0);
    assert.deepEqual(
      retry.deletedObjects.map(({ fileStatus, id, reason }) => ({ fileStatus, id, reason })),
      [{ fileStatus: "deleted", id: first.id, reason: "size" }],
    );
  } finally {
    if (payloadDirectory !== undefined) {
      chmodSync(payloadDirectory, 0o700);
    }
    closeStorage(storage);
  }
});

test("cleanup records file permission failures instead of claiming successful deletion", () => {
  const storage = createStorage();
  const policy = { enabled: true, maxBytes: 1_000, retentionDays: 0 };
  let payloadDirectory;

  try {
    const stored = storeColdObject(
      storage.database.connection,
      storage.database.paths,
      "canonical",
      {
        category: "conversation",
        expiresAt: new Date(START.getTime() + DAY_MS).toISOString(),
        referenceId: "reference-1",
      },
      { now: START, policy },
    );
    payloadDirectory = dirname(stored.filePath);
    chmodSync(payloadDirectory, 0o500);

    const cleanup = cleanupColdStorage(
      storage.database.connection,
      storage.database.paths,
      policy,
      { now: new Date(START.getTime() + 2 * DAY_MS) },
    );
    assert.equal(cleanup.status, "completed_with_errors");
    assert.equal(cleanup.errorCount, 1);
    assert.equal(cleanup.deletedObjects[0]?.fileStatus, "failed");
    assert.equal(cleanup.afterBytes, Buffer.byteLength("canonical"));
    assert.equal(
      storage.database.connection.prepare("SELECT COUNT(*) FROM cold_objects").pluck().get(),
      1,
    );
    assert.equal(
      storage.database.connection
        .prepare("SELECT COUNT(*) FROM cold_object_references WHERE id = ?")
        .pluck()
        .get("reference-1"),
      1,
    );
    assert.equal(
      storage.database.connection
        .prepare(
          "SELECT file_status FROM cold_storage_cleanup_items WHERE run_id = ? AND item_kind = 'object'",
        )
        .pluck()
        .get(cleanup.runId),
      "failed",
    );

    chmodSync(payloadDirectory, 0o700);
    payloadDirectory = undefined;
    const retry = cleanupColdStorage(storage.database.connection, storage.database.paths, policy, {
      now: new Date(START.getTime() + 2 * DAY_MS),
    });
    assert.equal(retry.status, "completed");
    assert.equal(retry.deletedObjects[0]?.reason, "expiry");
    assert.equal(retry.deletedObjects[0]?.fileStatus, "deleted");
    assert.equal(retry.afterBytes, 0);
  } finally {
    if (payloadDirectory !== undefined) {
      chmodSync(payloadDirectory, 0o700);
    }
    closeStorage(storage);
  }
});
