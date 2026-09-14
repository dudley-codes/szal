import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import BetterSqlite3 from "better-sqlite3";

import {
  applyMigrations,
  exportMemoryArchive,
  findMemoryProject,
  MEMORY_CLASSES,
  MIGRATIONS,
  MEMORY_STATUSES,
  openSzalDatabase,
  readMemoryArchive,
  readMemoryForSummarization,
  readWorkingMemory,
  recordTelemetryProject,
  recordTelemetrySession,
  renderMemoryExport,
  resolveMemoryProject,
  resolveProjectIdentity,
  storeMemoryItem,
} from "../dist/core/storage/index.js";

const createTemporaryDirectory = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

const createMemoryDatabase = () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");
  applyMigrations(database);
  recordTelemetryProject(database, {
    id: "project-1",
    rootPath: "/workspace/project-1",
  });
  return database;
};

const recordSession = (database, id, projectId = "project-1") => {
  recordTelemetrySession(database, {
    host: "test-host",
    id,
    mode: "on",
    projectId,
  });
};

const fixedTime = (seconds) => `2026-01-02T03:04:${String(seconds).padStart(2, "0")}.000Z`;

test("project identity uses Git roots, deterministic IDs, fallback paths, and legacy rows", () => {
  const repository = createTemporaryDirectory("szal-memory-git");
  const outsideGit = createTemporaryDirectory("szal-memory-cwd");
  const nested = join(repository, "nested", "directory");
  const database = new BetterSqlite3(":memory:");

  try {
    execFileSync("git", ["init", "--quiet", repository]);
    mkdirSync(nested, { recursive: true });
    applyMigrations(database);

    const first = resolveProjectIdentity(nested);
    const second = resolveProjectIdentity(repository);
    assert.equal(first.rootPath, second.rootPath);
    assert.equal(first.gitRoot, first.rootPath);
    assert.equal(first.kind, "git-root");
    assert.equal(first.id, second.id);
    assert.match(first.id, /^szal:\/\/project\/sha256\/[a-f0-9]{64}$/);
    assert.equal(findMemoryProject(database, nested), null);

    database
      .prepare("INSERT INTO projects (id, root_path) VALUES (?, ?)")
      .run("legacy-project-id", first.rootPath);
    const recorded = resolveMemoryProject(database, nested);
    assert.equal(recorded.id, "legacy-project-id");
    assert.equal(findMemoryProject(database, nested)?.id, "legacy-project-id");
    assert.deepEqual(database.prepare("SELECT id, root_path, git_root FROM projects").get(), {
      git_root: first.rootPath,
      id: "legacy-project-id",
      root_path: first.rootPath,
    });

    const fallback = resolveProjectIdentity(outsideGit);
    assert.equal(fallback.rootPath, resolve(outsideGit));
    assert.equal(fallback.gitRoot, undefined);
    assert.equal(fallback.kind, "cwd");
    assert.throws(
      () => resolveProjectIdentity(join(outsideGit, "missing")),
      /Project directory is not accessible/,
    );
    assert.equal(existsSync(join(repository, ".szal")), false);
  } finally {
    database.close();
    rmSync(repository, { force: true, recursive: true });
    rmSync(outsideGit, { force: true, recursive: true });
  }
});

test("exact writes preserve every class, writable status, and provenance form", () => {
  const database = createMemoryDatabase();
  recordSession(database, "session-1");
  const writableStatuses = MEMORY_STATUSES.filter((status) => status !== "superseded");
  const exactContent = "  Keep src/a b.ts::Widget<T> and do NOT remove --flag.\n";

  try {
    for (const [index, memoryClass] of MEMORY_CLASSES.entries()) {
      const id = `item-${String(index)}`;
      const source =
        index % 3 === 0
          ? { sessionId: "session-1" }
          : index % 3 === 1
            ? { artifactUri: `opaque artifact ${String(index)}:#value` }
            : {
                artifactUri: `szal://cold/not-required/${String(index)}`,
                sessionId: "session-1",
              };
      const common = {
        class: memoryClass,
        content: exactContent,
        createdAt: fixedTime(index),
        id,
        source,
        status: writableStatuses[index % writableStatuses.length],
      };
      const stored = storeMemoryItem(
        database,
        "project-1",
        memoryClass === "decision"
          ? {
              ...common,
              class: "decision",
              decision: { reason: "  exact reason\n", rejected: "A | B; not C" },
            }
          : common,
      );
      assert.equal(stored.item.content, exactContent);
      assert.equal(stored.item.sourceUri, source.artifactUri ?? null);
      assert.equal(stored.item.sessionId, source.sessionId ?? null);
    }

    const archive = readMemoryArchive(database, "project-1");
    assert.deepEqual(
      archive.items.map((item) => item.class),
      [...MEMORY_CLASSES],
    );
    assert.deepEqual(new Set(archive.items.map((item) => item.status)), new Set(writableStatuses));
    const decision = archive.decisions[0];
    assert.equal(decision.reason, "  exact reason\n");
    assert.equal(decision.rejected, "A | B; not C");

    const retryInput = {
      class: "requirement",
      content: exactContent,
      createdAt: fixedTime(0),
      id: "item-0",
      source: { sessionId: "session-1" },
      status: "selected",
    };
    assert.equal(storeMemoryItem(database, "project-1", retryInput).item.id, "item-0");
    assert.throws(
      () => storeMemoryItem(database, "project-1", { ...retryInput, content: "changed" }),
      /already used by different content or metadata/,
    );
    assert.throws(
      () =>
        storeMemoryItem(database, "project-1", {
          ...retryInput,
          id: "missing-source",
          source: {},
        }),
      /requires a source session or artifact URI/,
    );
    assert.throws(
      () =>
        storeMemoryItem(database, "project-1", {
          ...retryInput,
          id: "empty-artifact",
          source: { artifactUri: "" },
        }),
      /artifactUri must not be empty/,
    );
    assert.throws(
      () =>
        storeMemoryItem(database, "project-1", {
          ...retryInput,
          id: "starts-superseded",
          status: "superseded",
        }),
      /cannot begin with status superseded/,
    );
  } finally {
    database.close();
  }
});

test("memory and decision history survives reopen and supersedes atomically", () => {
  const homeDirectory = createTemporaryDirectory("szal-memory-home");
  const firstDatabase = openSzalDatabase({ environment: {}, homeDirectory });

  try {
    recordTelemetryProject(firstDatabase.connection, {
      id: "project-1",
      rootPath: "/workspace/project-1",
    });
    recordSession(firstDatabase.connection, "session-1");
    storeMemoryItem(firstDatabase.connection, "project-1", {
      class: "decision",
      content: "Use exact v1",
      createdAt: fixedTime(1),
      decision: { reason: "Keeps symbols", rejected: "Use lossy v0" },
      id: "decision-1",
      source: { artifactUri: "artifact://plan/1", sessionId: "session-1" },
      status: "selected",
    });
    firstDatabase.connection.close();

    const reopened = openSzalDatabase({ environment: {}, homeDirectory });
    try {
      recordSession(reopened.connection, "session-2");
      const successorInput = {
        class: "decision",
        content: "Use exact v2",
        createdAt: fixedTime(2),
        decision: { reason: "Handles negation", rejected: "Keep exact v1" },
        id: "decision-2",
        source: { sessionId: "session-2" },
        status: "selected",
        supersedesId: "decision-1",
      };
      storeMemoryItem(reopened.connection, "project-1", successorInput);
      assert.equal(
        storeMemoryItem(reopened.connection, "project-1", successorInput).item.id,
        "decision-2",
      );

      const archive = readMemoryArchive(reopened.connection, "project-1");
      assert.deepEqual(
        archive.items.map(({ id, status, supersedesId }) => ({ id, status, supersedesId })),
        [
          { id: "decision-1", status: "superseded", supersedesId: null },
          { id: "decision-2", status: "selected", supersedesId: "decision-1" },
        ],
      );
      assert.deepEqual(
        archive.decisions.map(({ id, status, supersedesId }) => ({ id, status, supersedesId })),
        [
          { id: "decision-1", status: "superseded", supersedesId: null },
          { id: "decision-2", status: "selected", supersedesId: "decision-1" },
        ],
      );
      assert.deepEqual(
        readMemoryArchive(reopened.connection, "project-1", { currentOnly: true }).items.map(
          ({ id }) => id,
        ),
        ["decision-2"],
      );
      assert.deepEqual(
        readWorkingMemory(reopened.connection, "project-1").items.map(({ id }) => id),
        ["decision-2"],
      );
      assert.throws(
        () =>
          storeMemoryItem(reopened.connection, "project-1", {
            class: "decision",
            content: "Use exact v1",
            createdAt: fixedTime(1),
            decision: { reason: "Keeps symbols", rejected: "Use lossy v0" },
            id: "decision-1",
            source: { artifactUri: "artifact://plan/1", sessionId: "session-1" },
            status: "selected",
          }),
        /already used by different content or metadata/,
      );
      assert.throws(
        () =>
          storeMemoryItem(reopened.connection, "project-1", {
            ...successorInput,
            content: "Competing successor",
            id: "decision-3",
          }),
        /already superseded|already has a successor/,
      );
      assert.throws(
        () =>
          reopened.connection
            .prepare("UPDATE memory_items SET content = ? WHERE id = ?")
            .run("mutated", "decision-2"),
        /identity, content, and provenance are immutable/,
      );
    } finally {
      reopened.connection.close();
    }
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("migrated unknown rows are readable but never offered for summarization", () => {
  const database = new BetterSqlite3(":memory:");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 2));
    database.exec(`
      INSERT INTO projects (id, root_path) VALUES ('project-1', '/workspace/project-1');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, created_at, updated_at
      ) VALUES (
        'legacy-summary-maybe', 'project-1', 'legacy', 'legacy', 'legacy bytes', NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    applyMigrations(database);
    storeMemoryItem(database, "project-1", {
      class: "requirement",
      content: "new exact bytes",
      createdAt: fixedTime(1),
      id: "new-exact",
      source: { artifactUri: "artifact://new" },
      status: "selected",
    });

    assert.deepEqual(
      readWorkingMemory(database, "project-1").items.map(({ id, representation }) => ({
        id,
        representation,
      })),
      [
        { id: "legacy-summary-maybe", representation: "unknown" },
        { id: "new-exact", representation: "exact" },
      ],
    );
    assert.deepEqual(
      readMemoryForSummarization(database, "project-1").items.map(({ id }) => id),
      ["new-exact"],
    );
  } finally {
    database.close();
  }
});

test("working policy caps without deletion and summarization reads exact rows only", () => {
  const database = createMemoryDatabase();
  const enabled = { enabled: true, maxItems: 2 };
  const disabled = { enabled: false, maxItems: 2 };

  try {
    recordTelemetryProject(database, {
      id: "project-2",
      rootPath: "/workspace/project-2",
    });
    storeMemoryItem(database, "project-2", {
      class: "environment",
      content: "other project",
      createdAt: fixedTime(4),
      id: "other-project-item",
      source: { artifactUri: "artifact://other-project" },
      status: "selected",
    });
    storeMemoryItem(database, "project-1", {
      class: "requirement",
      content: "old exact",
      createdAt: fixedTime(1),
      id: "old-exact",
      source: { artifactUri: "artifact://old" },
      status: "selected",
    });
    storeMemoryItem(database, "project-1", {
      class: "constraint",
      content: "stored summary verbatim ```",
      createdAt: fixedTime(2),
      id: "stored-summary",
      representation: "summary",
      source: { artifactUri: "artifact://summary" },
      status: "temporary",
    });
    storeMemoryItem(database, "project-1", {
      class: "symbol",
      content: "new exact",
      createdAt: fixedTime(3),
      id: "new-exact",
      source: { artifactUri: "artifact://new" },
      status: "selected",
    });

    assert.deepEqual(
      readWorkingMemory(database, "project-1", enabled).items.map(({ id }) => id),
      ["stored-summary", "new-exact"],
    );
    assert.deepEqual(
      readWorkingMemory(database, "project-2", enabled).items.map(({ id }) => id),
      ["other-project-item"],
    );
    assert.deepEqual(
      readMemoryForSummarization(database, "project-1", enabled).items.map(({ id }) => id),
      ["old-exact", "new-exact"],
    );
    assert.deepEqual(readWorkingMemory(database, "project-1", disabled).items, []);
    assert.deepEqual(readMemoryForSummarization(database, "project-1", disabled).items, []);
    assert.equal(database.prepare("SELECT COUNT(*) FROM memory_items").pluck().get(), 4);
    assert.throws(
      () =>
        storeMemoryItem(
          database,
          "project-1",
          {
            class: "task",
            content: "disabled",
            id: "disabled-write",
            source: { artifactUri: "artifact://disabled" },
            status: "selected",
          },
          disabled,
        ),
      /disabled by configuration/,
    );

    const archive = readMemoryArchive(database, "project-1");
    const project = {
      id: "project-1",
      kind: "cwd",
      rootPath: "/workspace/project-1",
    };
    const json = exportMemoryArchive(database, project, "json");
    assert.deepEqual(JSON.parse(json), {
      decisions: archive.decisions,
      items: archive.items,
      project,
      schemaVersion: 1,
    });
    assert.equal(json, renderMemoryExport(project, archive, "json"));
    assert.equal(json, exportMemoryArchive(database, project, "json"));
    const markdown = exportMemoryArchive(database, project, "markdown");
    assert.match(markdown, /^# Structured Memory Archive\n\n````json\n/);
    assert.match(markdown, /stored summary verbatim ```/);
    assert.match(markdown, /"sourceUri": "artifact:\/\/new"/);
  } finally {
    database.close();
  }
});
