import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import {
  DEFAULT_CONFIG,
  loadConfig,
  type ConfigStoreOptions,
  type SzalConfig,
} from "../config/index.js";
import { recordTelemetryProject, type ProjectTelemetryIdentity } from "./telemetry-ledger.js";

export const MEMORY_CLASSES = [
  "requirement",
  "decision",
  "constraint",
  "rejected-approach",
  "task",
  "error",
  "file-state",
  "symbol",
  "test-state",
  "environment",
] as const;

export const MEMORY_STATUSES = [
  "selected",
  "considered",
  "rejected",
  "superseded",
  "temporary",
  "unknown",
] as const;

export const MEMORY_REPRESENTATIONS = ["exact", "summary", "unknown"] as const;

const GIT_PROJECT_SCOPE_ENVIRONMENT = new Set<string>([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

export type MemoryClass = (typeof MEMORY_CLASSES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryRepresentation = (typeof MEMORY_REPRESENTATIONS)[number];
export type WritableMemoryRepresentation = Exclude<MemoryRepresentation, "unknown">;
export type WritableMemoryStatus = Exclude<MemoryStatus, "superseded">;
export type MemoryExportFormat = "json" | "markdown";
export type MemoryProjectKind = "cwd" | "git-root";

export interface MemoryProjectIdentity extends ProjectTelemetryIdentity {
  kind: MemoryProjectKind;
}

export type MemorySource =
  { artifactUri: string; sessionId?: string } | { artifactUri?: string; sessionId: string };

export interface MemoryDecisionDetails {
  reason?: string;
  rejected?: string;
}

interface MemoryItemInputBase {
  content: string;
  createdAt?: string;
  id: string;
  representation: WritableMemoryRepresentation;
  source: MemorySource;
  status: WritableMemoryStatus;
  supersedesId?: string;
}

export type MemoryItemInput =
  | (MemoryItemInputBase & {
      class: "decision";
      decision: MemoryDecisionDetails;
    })
  | (MemoryItemInputBase & {
      class: Exclude<MemoryClass, "decision">;
      decision?: never;
    });

export interface MemoryPolicy {
  enabled: boolean;
  maxItems: number;
}

export type MemoryPolicyLoadOptions = ConfigStoreOptions;

interface MemoryItemRecordBase {
  content: string;
  createdAt: string;
  id: string;
  projectId: string;
  sessionId: string | null;
  sourceUri: string | null;
  supersedesId: string | null;
  updatedAt: string;
}

export interface StructuredMemoryItemRecord extends MemoryItemRecordBase {
  class: MemoryClass;
  representation: WritableMemoryRepresentation;
  status: MemoryStatus;
}

export interface MigratedMemoryItemRecord extends MemoryItemRecordBase {
  class: string;
  representation: "unknown";
  status: string;
}

export type MemoryItemRecord = StructuredMemoryItemRecord | MigratedMemoryItemRecord;

export interface MemoryDecisionRecord {
  decidedAt: string;
  decision: string;
  id: string;
  memoryItemId: string | null;
  projectId: string;
  reason: string | null;
  rejected: string | null;
  sessionId: string | null;
  sourceUri: string | null;
  status: string;
  supersedesId: string | null;
}

export interface MemoryCollection {
  decisions: MemoryDecisionRecord[];
  items: MemoryItemRecord[];
  projectId: string;
}

export interface ReadMemoryArchiveOptions {
  currentOnly?: boolean;
}

export interface MemoryExportDocument {
  decisions: MemoryDecisionRecord[];
  items: MemoryItemRecord[];
  project: MemoryProjectIdentity;
  schemaVersion: 1;
}

export interface StoredMemoryItem {
  decision: MemoryDecisionRecord | null;
  item: MemoryItemRecord;
}

interface MemoryItemRow {
  class: string;
  content: string;
  created_at: string;
  id: string;
  project_id: string;
  representation: MemoryRepresentation;
  session_id: string | null;
  source_uri: string | null;
  status: string;
  supersedes_id: string | null;
  updated_at: string;
}

interface MemoryDecisionRow {
  decided_at: string;
  decision: string;
  id: string;
  memory_item_id: string | null;
  project_id: string;
  reason: string | null;
  rejected: string | null;
  session_id: string | null;
  source_uri: string | null;
  status: string;
  supersedes_id: string | null;
}

const MEMORY_ITEM_COLUMNS = `
  id, project_id, session_id, class, status, content, source_uri,
  supersedes_id, created_at, updated_at, representation
`;

const MEMORY_DECISION_COLUMNS = `
  id, project_id, session_id, memory_item_id, decision, reason, rejected,
  status, source_uri, supersedes_id, decided_at
`;

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  enabled: DEFAULT_CONFIG.memory.enabled,
  maxItems: DEFAULT_CONFIG.memory.maxItems,
};

export const memoryPolicyFromConfig = (config: SzalConfig): MemoryPolicy => ({
  enabled: config.memory.enabled,
  maxItems: config.memory.maxItems,
});

export const loadMemoryPolicy = (options: MemoryPolicyLoadOptions = {}): MemoryPolicy =>
  memoryPolicyFromConfig(loadConfig(options).config);

const assertPolicy = (policy: MemoryPolicy | undefined): void => {
  if (policy === undefined) {
    throw new Error("Structured memory policy is required.");
  }
  if (typeof policy.enabled !== "boolean") {
    throw new Error("Structured memory enabled must be a boolean.");
  }
  if (!Number.isSafeInteger(policy.maxItems) || policy.maxItems <= 0) {
    throw new Error("Structured memory maxItems must be a positive integer.");
  }
};

const assertNonEmpty = (value: string, label: string): void => {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
};

const assertCanonicalTimestamp = (value: string, label: string): void => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO 8601 timestamp.`);
  }
};

// Keep unconstrained legacy class and status strings visible behind the unknown discriminator.
const mapMemoryItem = (row: MemoryItemRow): MemoryItemRecord => {
  const common = {
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sourceUri: row.source_uri,
    supersedesId: row.supersedes_id,
    updatedAt: row.updated_at,
  };
  if (row.representation === "unknown") {
    return {
      ...common,
      class: row.class,
      representation: "unknown",
      status: row.status,
    };
  }
  return {
    ...common,
    class: row.class as MemoryClass,
    representation: row.representation,
    status: row.status as MemoryStatus,
  };
};

const mapMemoryDecision = (row: MemoryDecisionRow): MemoryDecisionRecord => ({
  decidedAt: row.decided_at,
  decision: row.decision,
  id: row.id,
  memoryItemId: row.memory_item_id,
  projectId: row.project_id,
  reason: row.reason,
  rejected: row.rejected,
  sessionId: row.session_id,
  sourceUri: row.source_uri,
  status: row.status,
  supersedesId: row.supersedes_id,
});

// Ignore ambient repository selectors so the requested directory alone determines project identity.
const unscopedGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !GIT_PROJECT_SCOPE_ENVIRONMENT.has(name) &&
        !name.startsWith("GIT_CONFIG_KEY_") &&
        !name.startsWith("GIT_CONFIG_VALUE_"),
    ),
  );

// Resolve a stable external project identity without invoking a command shell.
export const resolveProjectIdentity = (
  workingDirectory: string = process.cwd(),
): MemoryProjectIdentity => {
  const absoluteWorkingDirectory = resolve(workingDirectory);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absoluteWorkingDirectory).isDirectory();
  } catch {
    throw new Error(`Project directory is not accessible: ${absoluteWorkingDirectory}`);
  }
  if (!isDirectory) {
    throw new Error(`Project path is not a directory: ${absoluteWorkingDirectory}`);
  }

  let gitRoot: string | undefined;
  try {
    const output = execFileSync(
      "git",
      ["-C", absoluteWorkingDirectory, "rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        encoding: "utf8",
        env: unscopedGitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    gitRoot = output.replace(/\r?\n$/, "");
    if (gitRoot.length === 0) {
      gitRoot = undefined;
    }
  } catch {
    gitRoot = undefined;
  }

  const rootPath = gitRoot ?? absoluteWorkingDirectory;
  const digest = createHash("sha256").update(rootPath).digest("hex");
  return {
    ...(gitRoot === undefined ? {} : { gitRoot }),
    id: `szal://project/sha256/${digest}`,
    kind: gitRoot === undefined ? "cwd" : "git-root",
    rootPath,
  };
};

const readStoredProjectId = (
  database: BetterSqlite3.Database,
  rootPath: string,
): string | undefined =>
  database.prepare("SELECT id FROM projects WHERE root_path = ?").pluck().get(rootPath) as
    string | undefined;

// Resolve an existing project without registering a new row during read-only operations.
export const findMemoryProject = (
  database: BetterSqlite3.Database,
  workingDirectory: string = process.cwd(),
): MemoryProjectIdentity | null => {
  const resolved = resolveProjectIdentity(workingDirectory);
  const storedId = readStoredProjectId(database, resolved.rootPath);
  return storedId === undefined ? null : { ...resolved, id: storedId };
};

// Record the resolved identity while retaining a pre-v3 project ID already assigned to this root.
export const resolveMemoryProject = (
  database: BetterSqlite3.Database,
  workingDirectory: string = process.cwd(),
): MemoryProjectIdentity => {
  const resolved = resolveProjectIdentity(workingDirectory);
  const project = {
    ...resolved,
    id: readStoredProjectId(database, resolved.rootPath) ?? resolved.id,
  };
  recordTelemetryProject(database, project);
  return project;
};

// Validate caller-owned identity and provenance without changing any exact input strings.
const validateMemoryInput = (input: MemoryItemInput): void => {
  assertNonEmpty(input.id, "Memory id");
  if (typeof input.content !== "string") {
    throw new TypeError("Memory content must be a string.");
  }
  if (!MEMORY_CLASSES.includes(input.class)) {
    throw new Error(`Unsupported memory class: ${input.class}.`);
  }
  const status: string = input.status;
  if (!(MEMORY_STATUSES as readonly string[]).includes(status) || status === "superseded") {
    throw new Error(`Memory cannot begin with status ${status}.`);
  }
  const representation: unknown = input.representation;
  if (representation !== "exact" && representation !== "summary") {
    throw new Error("Memory representation must be exact or summary for new items.");
  }
  if (input.source.sessionId === undefined && input.source.artifactUri === undefined) {
    throw new Error("Memory requires a source session or artifact URI.");
  }
  if (input.source.sessionId !== undefined) {
    assertNonEmpty(input.source.sessionId, "Memory source sessionId");
  }
  if (input.source.artifactUri !== undefined) {
    assertNonEmpty(input.source.artifactUri, "Memory source artifactUri");
  }
  if (input.supersedesId !== undefined) {
    assertNonEmpty(input.supersedesId, "Memory supersedesId");
    if (input.supersedesId === input.id) {
      throw new Error("Memory cannot supersede itself.");
    }
  }
  if (input.createdAt !== undefined) {
    assertCanonicalTimestamp(input.createdAt, "Memory createdAt");
  }
  if (input.class === "decision") {
    if (input.decision.reason !== undefined && typeof input.decision.reason !== "string") {
      throw new TypeError("Memory decision reason must be a string.");
    }
    if (input.decision.rejected !== undefined && typeof input.decision.rejected !== "string") {
      throw new TypeError("Memory decision rejected must be a string.");
    }
  } else {
    const decision: unknown = (input as { decision?: unknown }).decision;
    if (decision !== undefined) {
      throw new Error("Decision details are only valid for decision memory.");
    }
  }
};

// Reject legacy duplicate links where a structured write expects one decision mirror.
const readDecisionForItem = (
  database: BetterSqlite3.Database,
  itemId: string,
): MemoryDecisionRecord | null => {
  const rows = database
    .prepare(
      `SELECT ${MEMORY_DECISION_COLUMNS} FROM decisions WHERE memory_item_id = ? ORDER BY id`,
    )
    .all(itemId) as MemoryDecisionRow[];
  if (rows.length > 1) {
    throw new Error(`Structured memory item ${itemId} has multiple linked decisions.`);
  }
  const row = rows[0];
  return row === undefined ? null : mapMemoryDecision(row);
};

// Follow the memory predecessor edge to the independently keyed legacy decision record.
const resolveDecisionPredecessorId = (
  database: BetterSqlite3.Database,
  projectId: string,
  input: MemoryItemInput,
): string | null => {
  if (input.class !== "decision" || input.supersedesId === undefined) {
    return null;
  }
  const predecessor = readDecisionForItem(database, input.supersedesId);
  if (predecessor === null) {
    return null;
  }
  if (predecessor.projectId !== projectId) {
    throw new Error("Decision predecessor must belong to the same project.");
  }
  return predecessor.id;
};

const readItemById = (
  database: BetterSqlite3.Database,
  id: string,
): MemoryItemRecord | undefined => {
  const row = database
    .prepare(`SELECT ${MEMORY_ITEM_COLUMNS} FROM memory_items WHERE id = ?`)
    .get(id) as MemoryItemRow | undefined;
  return row === undefined ? undefined : mapMemoryItem(row);
};

// Treat a byte-for-byte equivalent retry as success while rejecting reuse of an existing identity.
const assertIdempotentRetry = (
  database: BetterSqlite3.Database,
  projectId: string,
  input: MemoryItemInput,
  existing: MemoryItemRecord,
): StoredMemoryItem => {
  const expectedRepresentation = input.representation;
  const matches =
    existing.projectId === projectId &&
    existing.sessionId === (input.source.sessionId ?? null) &&
    existing.class === input.class &&
    existing.status === input.status &&
    existing.content === input.content &&
    existing.sourceUri === (input.source.artifactUri ?? null) &&
    existing.supersedesId === (input.supersedesId ?? null) &&
    existing.representation === expectedRepresentation &&
    (input.createdAt === undefined || existing.createdAt === input.createdAt);
  const decision = readDecisionForItem(database, input.id);
  const expectedDecisionSupersedesId = resolveDecisionPredecessorId(database, projectId, input);
  const decisionMatches =
    input.class === "decision"
      ? decision !== null &&
        decision.id === input.id &&
        decision.projectId === projectId &&
        decision.sessionId === (input.source.sessionId ?? null) &&
        decision.decision === input.content &&
        decision.reason === (input.decision.reason ?? null) &&
        decision.rejected === (input.decision.rejected ?? null) &&
        decision.status === input.status &&
        decision.sourceUri === (input.source.artifactUri ?? null) &&
        decision.supersedesId === expectedDecisionSupersedesId
      : decision === null;

  if (!matches || !decisionMatches) {
    throw new Error(`Memory id ${input.id} is already used by different content or metadata.`);
  }
  return { decision, item: existing };
};

// Persist one immutable item and its decision mirror, including predecessor transition, atomically.
export const storeMemoryItem = (
  database: BetterSqlite3.Database,
  projectId: string,
  input: MemoryItemInput,
  policy: MemoryPolicy,
): StoredMemoryItem => {
  assertPolicy(policy);
  if (!policy.enabled) {
    throw new Error("Structured memory is disabled by configuration.");
  }
  assertNonEmpty(projectId, "Memory projectId");
  validateMemoryInput(input);

  return database
    .transaction(() => {
      const existing = readItemById(database, input.id);
      if (existing !== undefined) {
        return assertIdempotentRetry(database, projectId, input, existing);
      }
      if (
        database.prepare("SELECT 1 FROM projects WHERE id = ?").pluck().get(projectId) === undefined
      ) {
        throw new Error(`Memory project ${projectId} does not exist.`);
      }

      const createdAt = input.createdAt ?? new Date().toISOString();
      const decisionSupersedesId = resolveDecisionPredecessorId(database, projectId, input);
      database
        .prepare(
          `INSERT INTO memory_items (
             id, project_id, session_id, class, status, content, source_uri,
             supersedes_id, created_at, updated_at, representation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          projectId,
          input.source.sessionId ?? null,
          input.class,
          input.status,
          input.content,
          input.source.artifactUri ?? null,
          input.supersedesId ?? null,
          createdAt,
          createdAt,
          input.representation,
        );

      if (input.class === "decision") {
        database
          .prepare(
            `INSERT INTO decisions (
               id, project_id, session_id, memory_item_id, decision, reason, rejected,
               status, source_uri, supersedes_id, decided_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            projectId,
            input.source.sessionId ?? null,
            input.id,
            input.content,
            input.decision.reason ?? null,
            input.decision.rejected ?? null,
            input.status,
            input.source.artifactUri ?? null,
            decisionSupersedesId,
            createdAt,
          );
      }

      const item = readItemById(database, input.id);
      if (item === undefined) {
        throw new Error(`Memory item ${input.id} was not stored.`);
      }
      return { decision: readDecisionForItem(database, input.id), item };
    })
    .immediate();
};

const readProjectDecisions = (
  database: BetterSqlite3.Database,
  projectId: string,
  currentOnly = false,
): MemoryDecisionRecord[] => {
  const currentFilter = currentOnly
    ? `AND status <> 'superseded'
       AND (
         memory_item_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM memory_items
            WHERE memory_items.id = decisions.memory_item_id
              AND memory_items.status <> 'superseded'
              AND NOT EXISTS (
                SELECT 1
                  FROM memory_items AS successor
                 WHERE successor.supersedes_id = memory_items.id
              )
         )
       )`
    : "";
  return (
    database
      .prepare(
        `SELECT ${MEMORY_DECISION_COLUMNS}
           FROM decisions
          WHERE project_id = ?
            ${currentFilter}
          ORDER BY decided_at, id`,
      )
      .all(projectId) as MemoryDecisionRow[]
  ).map(mapMemoryDecision);
};

// Read a policy-limited current snapshot, retaining chronological order among the newest items.
const readCurrentMemory = (
  database: BetterSqlite3.Database,
  projectId: string,
  policy: MemoryPolicy,
  exactOnly: boolean,
): MemoryCollection => {
  assertPolicy(policy);
  if (!policy.enabled) {
    return { decisions: [], items: [], projectId };
  }
  const representationFilter = exactOnly ? "AND representation = 'exact'" : "";
  const rows = database
    .prepare(
      `SELECT ${MEMORY_ITEM_COLUMNS}
         FROM (
           SELECT ${MEMORY_ITEM_COLUMNS}
             FROM memory_items
            WHERE project_id = ?
              AND status <> 'superseded'
              AND NOT EXISTS (
                SELECT 1
                  FROM memory_items AS successor
                 WHERE successor.supersedes_id = memory_items.id
              )
              ${representationFilter}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
         )
        ORDER BY created_at, id`,
    )
    .all(projectId, policy.maxItems) as MemoryItemRow[];
  const items = rows.map(mapMemoryItem);
  const itemIds = new Set(items.map(({ id }) => id));
  const decisions = readProjectDecisions(database, projectId, true).filter(
    ({ memoryItemId }) => memoryItemId !== null && itemIds.has(memoryItemId),
  );
  return { decisions, items, projectId };
};

export const readWorkingMemory = (
  database: BetterSqlite3.Database,
  projectId: string,
  policy: MemoryPolicy,
): MemoryCollection => readCurrentMemory(database, projectId, policy, false);

// Return only exact current rows so summaries and unclassified v2 rows cannot be summarized again.
export const readMemoryForSummarization = (
  database: BetterSqlite3.Database,
  projectId: string,
  policy: MemoryPolicy,
): MemoryCollection => readCurrentMemory(database, projectId, policy, true);

// Read every historical item and decision independently so even unconstrained v2 rows are retained.
export const readMemoryArchive = (
  database: BetterSqlite3.Database,
  projectId: string,
  options: ReadMemoryArchiveOptions = {},
): MemoryCollection => {
  const currentFilter =
    options.currentOnly === true
      ? `AND status <> 'superseded'
         AND NOT EXISTS (
           SELECT 1
             FROM memory_items AS successor
            WHERE successor.supersedes_id = memory_items.id
         )`
      : "";
  const items = (
    database
      .prepare(
        `SELECT ${MEMORY_ITEM_COLUMNS}
           FROM memory_items
          WHERE project_id = ?
            ${currentFilter}
          ORDER BY created_at, id`,
      )
      .all(projectId) as MemoryItemRow[]
  ).map(mapMemoryItem);
  return {
    decisions: readProjectDecisions(database, projectId, options.currentOnly === true),
    items,
    projectId,
  };
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// Canonicalize collection order and project fields before deterministic serialization.
const createExportDocument = (
  project: MemoryProjectIdentity,
  collection: MemoryCollection,
): MemoryExportDocument => ({
  decisions: [...collection.decisions].sort(
    (left, right) => compareText(left.decidedAt, right.decidedAt) || compareText(left.id, right.id),
  ),
  items: [...collection.items].sort(
    (left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
  ),
  project: {
    id: project.id,
    kind: project.kind,
    rootPath: project.rootPath,
    ...(project.gitRoot === undefined ? {} : { gitRoot: project.gitRoot }),
  },
  schemaVersion: 1,
});

// Outgrow every backtick run so arbitrary exact content cannot close the Markdown block.
const markdownFence = (contents: string): string => {
  const runs = contents.match(/`+/g) ?? [];
  const longestRun = runs.reduce((length, run) => Math.max(length, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
};

// Render lossless JSON, or Markdown containing the same canonical JSON behind a safe dynamic fence.
export const renderMemoryExport = (
  project: MemoryProjectIdentity,
  collection: MemoryCollection,
  format: MemoryExportFormat,
): string => {
  if (collection.projectId !== project.id) {
    throw new Error("Memory export project does not match its collection.");
  }
  const serialized = JSON.stringify(createExportDocument(project, collection), null, 2);
  if (format === "json") {
    return `${serialized}\n`;
  }
  const fence = markdownFence(serialized);
  return `# Structured Memory Archive\n\n${fence}json\n${serialized}\n${fence}\n`;
};

// Export requested history regardless of the current memory-enabled policy.
export const exportMemoryArchive = (
  database: BetterSqlite3.Database,
  project: MemoryProjectIdentity,
  format: MemoryExportFormat,
  options: ReadMemoryArchiveOptions = {},
): string => renderMemoryExport(project, readMemoryArchive(database, project.id, options), format);
