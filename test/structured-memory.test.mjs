import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import BetterSqlite3 from "better-sqlite3";

import {
  captureHostLifecycleMemory,
  exportMemoryArchive,
  findMemoryProject,
  loadMemoryPolicy,
  MEMORY_CLASSES,
  MEMORY_STATUSES,
  openSzalDatabase,
  readMemoryArchive,
  readMemoryForSummarization,
  readWorkingMemory,
  recordTelemetrySession,
  renderMemoryExport,
  resolveMemoryProject,
  resolveProjectIdentity,
  storeMemoryItem,
} from "szal/memory";
import { DEFAULT_CONFIG, writeConfig } from "../dist/core/config/index.js";
import { applyMigrations, MIGRATIONS, recordTelemetryProject } from "../dist/core/storage/index.js";

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
const ENABLED_MEMORY_POLICY = { enabled: true, maxItems: 10_000 };

const storeMemory = (database, projectId, input, policy = ENABLED_MEMORY_POLICY) =>
  storeMemoryItem(database, projectId, input, policy);

const readWorking = (database, projectId, policy = ENABLED_MEMORY_POLICY) =>
  readWorkingMemory(database, projectId, policy);

const readForSummarization = (database, projectId, policy = ENABLED_MEMORY_POLICY) =>
  readMemoryForSummarization(database, projectId, policy);

test("memory policy loads configured state and is required by capture and working reads", () => {
  const homeDirectory = createTemporaryDirectory("szal-memory-policy");
  const database = createMemoryDatabase();

  try {
    writeConfig(
      {
        ...DEFAULT_CONFIG,
        memory: { enabled: false, maxItems: 7 },
      },
      { environment: {}, homeDirectory },
    );
    assert.deepEqual(loadMemoryPolicy({ environment: {}, homeDirectory }), {
      enabled: false,
      maxItems: 7,
    });
    assert.throws(
      () =>
        storeMemoryItem(database, "project-1", {
          class: "task",
          content: "requires policy",
          id: "requires-policy",
          representation: "exact",
          source: { artifactUri: "artifact://policy" },
          status: "selected",
        }),
      /policy is required/,
    );
    assert.throws(() => readWorkingMemory(database, "project-1"), /policy is required/);
  } finally {
    database.close();
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

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
        representation: "exact",
        source,
        status: writableStatuses[index % writableStatuses.length],
      };
      const stored = storeMemory(
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
      representation: "exact",
      source: { sessionId: "session-1" },
      status: "selected",
    };
    assert.equal(storeMemory(database, "project-1", retryInput).item.id, "item-0");
    assert.throws(
      () => storeMemory(database, "project-1", { ...retryInput, content: "changed" }),
      /already used by different content or metadata/,
    );
    assert.throws(
      () =>
        storeMemory(database, "project-1", {
          ...retryInput,
          id: "missing-representation",
          representation: undefined,
        }),
      /representation must be exact or summary/,
    );
    assert.throws(
      () =>
        storeMemory(database, "project-1", {
          ...retryInput,
          id: "missing-source",
          source: {},
        }),
      /requires a source session or artifact URI/,
    );
    assert.throws(
      () =>
        storeMemory(database, "project-1", {
          ...retryInput,
          id: "empty-artifact",
          source: { artifactUri: "" },
        }),
      /artifactUri must not be empty/,
    );
    assert.throws(
      () =>
        storeMemory(database, "project-1", {
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

test("host lifecycle capture is deterministic, exact, provenance-aware, and records rejections", () => {
  const database = createMemoryDatabase();
  recordSession(database, "session-1");
  const exactContent = "Keep src/a b.ts::Widget<T> and do NOT remove --flag.";
  const event = {
    candidates: [
      {
        class: "requirement",
        confidence: 0.9,
        content: exactContent,
        key: "requirement:widget-flag",
        status: "selected",
      },
      {
        class: "task",
        content: "invalid status is rejected without losing valid candidates",
        key: "task:invalid",
        status: "superseded",
      },
    ],
    eventId: "event-1",
    host: "claude",
    kind: "prompt-lifecycle",
    occurredAt: fixedTime(7),
    sessionId: "session-1",
  };

  try {
    const first = captureHostLifecycleMemory(database, "project-1", event, ENABLED_MEMORY_POLICY);
    const second = captureHostLifecycleMemory(database, "project-1", event, ENABLED_MEMORY_POLICY);

    assert.equal(first.accepted.length, 1);
    assert.equal(first.rejected.length, 1);
    assert.equal(second.accepted[0].item.id, first.accepted[0].item.id);
    assert.equal(second.rejected[0].id, first.rejected[0].id);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) FROM memory_items WHERE project_id = 'project-1'")
        .pluck()
        .get(),
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) FROM memory_capture_rejections").pluck().get(),
      1,
    );

    const [item] = readMemoryArchive(database, "project-1").items;
    assert.equal(item.content, exactContent);
    assert.equal(item.sourceHost, "claude");
    assert.equal(item.sessionId, "session-1");
    assert.equal(item.sourceEventId, "event-1");
    assert.equal(item.sourceEventKind, "prompt-lifecycle");
    assert.equal(item.confidence, 0.9);

    const repeatedFactDifferentEvent = {
      ...event,
      eventId: "event-2",
      candidates: [event.candidates[0]],
      occurredAt: fixedTime(8),
    };
    captureHostLifecycleMemory(
      database,
      "project-1",
      repeatedFactDifferentEvent,
      ENABLED_MEMORY_POLICY,
    );
    assert.deepEqual(
      readMemoryArchive(database, "project-1").items.map(({ content, sourceEventId }) => ({
        content,
        sourceEventId,
      })),
      [
        { content: exactContent, sourceEventId: "event-1" },
        { content: exactContent, sourceEventId: "event-2" },
      ],
    );
  } finally {
    database.close();
  }
});

test("host lifecycle capture covers each adapter lifecycle event class", () => {
  const database = createMemoryDatabase();
  recordSession(database, "session-1");
  const fixtures = [
    ["session-lifecycle", "environment", "node 24.0.0"],
    ["prompt-lifecycle", "requirement", "Preserve --exact-symbol"],
    ["tool-lifecycle", "file-state", "src/index.ts modified"],
    ["subagent-lifecycle", "task", "Review delegated to subagent"],
    ["compaction-lifecycle", "test-state", "npm run check passed"],
  ];

  try {
    for (const [index, [kind, memoryClass, content]] of fixtures.entries()) {
      captureHostLifecycleMemory(
        database,
        "project-1",
        {
          candidates: [
            {
              class: memoryClass,
              content,
              key: `${kind}:${memoryClass}`,
              status: "selected",
            },
          ],
          eventId: `lifecycle-${String(index)}`,
          host: "adapter-contract",
          kind,
          occurredAt: fixedTime(index),
          sessionId: "session-1",
        },
        ENABLED_MEMORY_POLICY,
      );
    }

    assert.deepEqual(
      readMemoryArchive(database, "project-1").items.map(
        ({ class: memoryClass, sourceEventKind }) => ({
          class: memoryClass,
          sourceEventKind,
        }),
      ),
      fixtures.map(([sourceEventKind, memoryClass]) => ({ class: memoryClass, sourceEventKind })),
    );
  } finally {
    database.close();
  }
});

test("host lifecycle capture respects working memory limits without deleting provenance", () => {
  const database = createMemoryDatabase();
  recordSession(database, "session-1");
  const limited = { enabled: true, maxItems: 1 };

  try {
    for (const index of [1, 2]) {
      captureHostLifecycleMemory(
        database,
        "project-1",
        {
          candidates: [
            {
              class: "environment",
              content: `environment fact ${String(index)}`,
              key: `environment:${String(index)}`,
              status: "selected",
            },
          ],
          eventId: `event-${String(index)}`,
          host: "pi",
          kind: "session-lifecycle",
          occurredAt: fixedTime(index),
          sessionId: "session-1",
        },
        ENABLED_MEMORY_POLICY,
      );
    }

    assert.deepEqual(
      readWorking(database, "project-1", limited).items.map(({ content }) => content),
      ["environment fact 2"],
    );
    assert.equal(readMemoryArchive(database, "project-1").items.length, 2);
  } finally {
    database.close();
  }
});

test("host lifecycle memory migration keeps existing structured rows readable", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 4));
    database.exec(`
      INSERT INTO projects (id, root_path) VALUES ('project-1', '/workspace/project-1');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, created_at, updated_at, representation
      ) VALUES (
        'pre-capture-memory', 'project-1', 'requirement', 'selected', 'existing exact',
        'artifact://legacy', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'exact'
      );
    `);
    applyMigrations(database);

    assert.deepEqual(readMemoryArchive(database, "project-1").items, [
      {
        class: "requirement",
        confidence: null,
        content: "existing exact",
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "pre-capture-memory",
        projectId: "project-1",
        representation: "exact",
        sessionId: null,
        sourceEventId: null,
        sourceEventKind: null,
        sourceHost: null,
        sourceUri: "artifact://legacy",
        status: "selected",
        supersedesId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
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
    storeMemory(firstDatabase.connection, "project-1", {
      class: "decision",
      content: "Use exact v1",
      createdAt: fixedTime(1),
      decision: { reason: "Keeps symbols", rejected: "Use lossy v0" },
      id: "decision-1",
      representation: "exact",
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
        representation: "exact",
        source: { sessionId: "session-2" },
        status: "selected",
        supersedesId: "decision-1",
      };
      storeMemory(reopened.connection, "project-1", successorInput);
      assert.equal(
        storeMemory(reopened.connection, "project-1", successorInput).item.id,
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
        readWorking(reopened.connection, "project-1").items.map(({ id }) => id),
        ["decision-2"],
      );
      assert.throws(
        () =>
          storeMemory(reopened.connection, "project-1", {
            class: "decision",
            content: "Use exact v1",
            createdAt: fixedTime(1),
            decision: { reason: "Keeps symbols", rejected: "Use lossy v0" },
            id: "decision-1",
            representation: "exact",
            source: { artifactUri: "artifact://plan/1", sessionId: "session-1" },
            status: "selected",
          }),
        /already used by different content or metadata/,
      );
      assert.throws(
        () =>
          storeMemory(reopened.connection, "project-1", {
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
        id, project_id, class, status, content, source_uri, supersedes_id,
        created_at, updated_at
      ) VALUES
        (
          'legacy-summary-maybe', 'project-1', 'legacy', 'legacy', 'legacy bytes', NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        ),
        (
          'legacy-successor', 'project-1', 'legacy', 'selected', 'later legacy bytes', NULL,
          'legacy-summary-maybe', '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z'
        );
    `);
    applyMigrations(database);
    storeMemory(database, "project-1", {
      class: "requirement",
      content: "new exact bytes",
      createdAt: fixedTime(1),
      id: "new-exact",
      representation: "exact",
      source: { artifactUri: "artifact://new" },
      status: "selected",
    });

    assert.deepEqual(
      readWorking(database, "project-1").items.map(({ id, representation }) => ({
        id,
        representation,
      })),
      [
        { id: "legacy-successor", representation: "unknown" },
        { id: "new-exact", representation: "exact" },
      ],
    );
    assert.deepEqual(
      readMemoryArchive(database, "project-1").items.map(({ id }) => id),
      ["legacy-summary-maybe", "legacy-successor", "new-exact"],
    );
    assert.deepEqual(
      readForSummarization(database, "project-1").items.map(({ id }) => id),
      ["new-exact"],
    );
  } finally {
    database.close();
  }
});

test("legacy decision keys remain supersedable and leave one current decision", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 2));
    database.exec(`
      INSERT INTO projects (id, root_path)
      VALUES ('project-1', '/workspace/project-1');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, created_at, updated_at
      ) VALUES (
        'legacy-memory-id', 'project-1', 'decision', 'selected', 'legacy choice',
        'artifact://legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO decisions (
        id, project_id, memory_item_id, decision, reason, rejected, status,
        source_uri, decided_at
      ) VALUES (
        'legacy-decision-id', 'project-1', 'legacy-memory-id', 'legacy choice',
        'legacy reason', 'legacy rejection', 'selected', 'artifact://legacy',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    applyMigrations(database);

    storeMemory(database, "project-1", {
      class: "decision",
      content: "structured choice",
      createdAt: fixedTime(1),
      decision: { reason: "structured reason", rejected: "legacy choice" },
      id: "structured-memory-id",
      representation: "exact",
      source: { artifactUri: "artifact://structured" },
      status: "selected",
      supersedesId: "legacy-memory-id",
    });

    const archive = readMemoryArchive(database, "project-1");
    assert.deepEqual(
      archive.items.map(({ id, status }) => ({ id, status })),
      [
        { id: "legacy-memory-id", status: "superseded" },
        { id: "structured-memory-id", status: "selected" },
      ],
    );
    assert.deepEqual(
      archive.decisions.map(({ id, status, supersedesId }) => ({ id, status, supersedesId })),
      [
        { id: "legacy-decision-id", status: "superseded", supersedesId: null },
        {
          id: "structured-memory-id",
          status: "selected",
          supersedesId: "legacy-decision-id",
        },
      ],
    );
    const current = readMemoryArchive(database, "project-1", { currentOnly: true });
    assert.deepEqual(
      current.items.map(({ id }) => id),
      ["structured-memory-id"],
    );
    assert.deepEqual(
      current.decisions.map(({ id }) => id),
      ["structured-memory-id"],
    );
  } finally {
    database.close();
  }
});

test("legacy decision memory without a mirror remains supersedable", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 2));
    database.exec(`
      INSERT INTO projects (id, root_path)
      VALUES ('project-1', '/workspace/project-1');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, created_at, updated_at
      ) VALUES (
        'legacy-memory-id', 'project-1', 'decision', 'selected', 'legacy choice',
        'artifact://legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    applyMigrations(database);

    storeMemory(database, "project-1", {
      class: "decision",
      content: "structured choice",
      createdAt: fixedTime(1),
      decision: { reason: "structured reason", rejected: "legacy choice" },
      id: "structured-memory-id",
      representation: "exact",
      source: { artifactUri: "artifact://structured" },
      status: "selected",
      supersedesId: "legacy-memory-id",
    });

    const archive = readMemoryArchive(database, "project-1");
    assert.deepEqual(
      archive.items.map(({ id, status }) => ({ id, status })),
      [
        { id: "legacy-memory-id", status: "superseded" },
        { id: "structured-memory-id", status: "selected" },
      ],
    );
    assert.deepEqual(
      archive.decisions.map(({ id, supersedesId }) => ({ id, supersedesId })),
      [{ id: "structured-memory-id", supersedesId: null }],
    );
  } finally {
    database.close();
  }
});

test("legacy cross-project decision links cannot enter structured supersession", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 2));
    database.exec(`
      INSERT INTO projects (id, root_path) VALUES
        ('project-1', '/workspace/project-1'),
        ('project-2', '/workspace/project-2');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, supersedes_id,
        created_at, updated_at
      ) VALUES
        (
          'legacy-memory-id', 'project-1', 'decision', 'selected', 'legacy choice',
          'artifact://legacy', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        ),
        (
          'cross-project-memory-successor', 'project-2', 'decision', 'selected',
          'unrelated project choice', 'artifact://other', 'legacy-memory-id',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
        );
      INSERT INTO decisions (
        id, project_id, memory_item_id, decision, status, source_uri, decided_at
      ) VALUES (
        'cross-project-decision', 'project-2', 'legacy-memory-id', 'legacy choice',
        'selected', 'artifact://legacy', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO decisions (
        id, project_id, decision, status, source_uri, supersedes_id, decided_at
      ) VALUES
        (
          'standalone-old', 'project-1', 'standalone old', 'selected',
          'artifact://standalone-old', NULL, '2026-01-01T00:00:02.000Z'
        ),
        (
          'standalone-new', 'project-1', 'standalone new', 'selected',
          'artifact://standalone-new', 'standalone-old', '2026-01-01T00:00:03.000Z'
        );
    `);
    applyMigrations(database);

    assert.throws(
      () =>
        storeMemory(database, "project-1", {
          class: "decision",
          content: "structured choice",
          createdAt: fixedTime(1),
          decision: { reason: "structured reason" },
          id: "structured-memory-id",
          representation: "exact",
          source: { artifactUri: "artifact://structured" },
          status: "selected",
          supersedesId: "legacy-memory-id",
        }),
      /Decision predecessor must belong to the same project/,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM memory_items WHERE id = 'legacy-memory-id'")
        .pluck()
        .get(),
      "selected",
    );
    assert.equal(database.prepare("SELECT COUNT(*) FROM memory_items").pluck().get(), 2);
    assert.deepEqual(
      readWorking(database, "project-1").items.map(({ id }) => id),
      ["legacy-memory-id"],
    );
    const current = readMemoryArchive(database, "project-1", { currentOnly: true });
    assert.deepEqual(
      current.items.map(({ id }) => id),
      ["legacy-memory-id"],
    );
    assert.deepEqual(
      current.decisions.map(({ id }) => id),
      ["standalone-new"],
    );
    assert.deepEqual(
      readMemoryArchive(database, "project-1").decisions.map(({ id }) => id),
      ["standalone-old", "standalone-new"],
    );
  } finally {
    database.close();
  }
});

test("working memory omits superseded legacy decision mirrors", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    applyMigrations(database, MIGRATIONS.slice(0, 2));
    database.exec(`
      INSERT INTO projects (id, root_path)
      VALUES ('project-1', '/workspace/project-1');
      INSERT INTO memory_items (
        id, project_id, class, status, content, source_uri, created_at, updated_at
      ) VALUES (
        'legacy-memory-id', 'project-1', 'decision', 'selected', 'legacy choice',
        'artifact://legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO decisions (
        id, project_id, memory_item_id, decision, status, source_uri, decided_at
      ) VALUES (
        'legacy-decision-id', 'project-1', 'legacy-memory-id', 'legacy choice',
        'superseded', 'artifact://legacy', '2026-01-01T00:00:00.000Z'
      );
    `);
    applyMigrations(database);

    const working = readWorking(database, "project-1");
    assert.deepEqual(
      working.items.map(({ id }) => id),
      ["legacy-memory-id"],
    );
    assert.deepEqual(working.decisions, []);
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
    storeMemory(database, "project-2", {
      class: "environment",
      content: "other project",
      createdAt: fixedTime(4),
      id: "other-project-item",
      representation: "exact",
      source: { artifactUri: "artifact://other-project" },
      status: "selected",
    });
    storeMemory(database, "project-1", {
      class: "requirement",
      content: "old exact",
      createdAt: fixedTime(1),
      id: "old-exact",
      representation: "exact",
      source: { artifactUri: "artifact://old" },
      status: "selected",
    });
    assert.throws(
      () =>
        storeMemory(database, "project-1", {
          class: "requirement",
          content: "lossy replacement",
          createdAt: fixedTime(2),
          id: "lossy-successor",
          representation: "summary",
          source: { artifactUri: "artifact://lossy" },
          status: "selected",
          supersedesId: "old-exact",
        }),
      /summary memory cannot supersede exact or unknown memory/,
    );
    assert.equal(
      database.prepare("SELECT status FROM memory_items WHERE id = 'old-exact'").pluck().get(),
      "selected",
    );
    storeMemory(database, "project-1", {
      class: "constraint",
      content: "stored summary verbatim ```",
      createdAt: fixedTime(2),
      id: "stored-summary",
      representation: "summary",
      source: { artifactUri: "artifact://summary" },
      status: "temporary",
    });
    storeMemory(database, "project-1", {
      class: "symbol",
      content: "new exact",
      createdAt: fixedTime(3),
      id: "new-exact",
      representation: "exact",
      source: { artifactUri: "artifact://new" },
      status: "selected",
    });

    assert.deepEqual(
      readWorking(database, "project-1", enabled).items.map(({ id }) => id),
      ["stored-summary", "new-exact"],
    );
    assert.deepEqual(
      readWorking(database, "project-2", enabled).items.map(({ id }) => id),
      ["other-project-item"],
    );
    assert.deepEqual(
      readForSummarization(database, "project-1", enabled).items.map(({ id }) => id),
      ["old-exact", "new-exact"],
    );
    assert.deepEqual(readWorking(database, "project-1", disabled).items, []);
    assert.deepEqual(readForSummarization(database, "project-1", disabled).items, []);
    assert.equal(database.prepare("SELECT COUNT(*) FROM memory_items").pluck().get(), 4);
    assert.throws(
      () =>
        storeMemory(
          database,
          "project-1",
          {
            class: "task",
            content: "disabled",
            id: "disabled-write",
            representation: "exact",
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

test("memory export ordering is a locale-independent total order", () => {
  const project = { id: "project-1", kind: "cwd", rootPath: "/workspace/project-1" };
  const common = {
    class: "symbol",
    content: "exact",
    createdAt: fixedTime(1),
    projectId: project.id,
    representation: "exact",
    sessionId: null,
    sourceUri: "artifact://unicode",
    status: "selected",
    supersedesId: null,
    updatedAt: fixedTime(1),
  };
  const composed = { ...common, id: "é" };
  const decomposed = { ...common, id: "é" };
  const first = renderMemoryExport(
    project,
    { decisions: [], items: [composed, decomposed], projectId: project.id },
    "json",
  );
  const second = renderMemoryExport(
    project,
    { decisions: [], items: [decomposed, composed], projectId: project.id },
    "json",
  );

  assert.equal(first, second);
  assert.deepEqual(
    JSON.parse(first).items.map(({ id }) => id),
    ["é", "é"],
  );
});
