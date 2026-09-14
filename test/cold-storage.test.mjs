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
    assert.equal(
      storage.database.connection
        .prepare("SELECT status FROM cold_storage_cleanup_runs WHERE id = ?")
        .pluck()
        .get(completeCleanup.runId),
      "completed",
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
