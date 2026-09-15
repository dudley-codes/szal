import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  captureHostLifecycleMemory,
  findMemoryProject,
  loadMemoryPolicy,
  openSzalDatabase,
  readMemoryArchive,
  readWorkingMemory,
  recordTelemetrySession,
  renderMemoryExport,
  resolveMemoryProject,
  resolveProjectIdentity,
  type HostLifecycleMemoryCandidate,
  type MemoryCollection,
  type MemoryExportFormat,
  type MemoryItemRecord,
} from "../../core/storage/index.js";
import type { CommandHandler } from "./types.js";

const MEMORY_EXPORT_USAGE =
  "Usage: szal memory export [--project <directory>] [--current] [--json]";
const MEMORY_RECALL_USAGE =
  "Usage: szal memory recall [--project <directory>] [--query <text>] [--limit <count>] [--json]";
const MEMORY_CAPTURE_USAGE =
  "Usage: szal memory capture-host-lifecycle --host <host> --session-id <id> --kind <kind> --event-id <id> [--project <directory>] [--mode on|off] [--json]";
const DEFAULT_RECALL_LIMIT = 8;
const MAX_RECALL_LIMIT = 20;
const MEMORY_LINE_MAX_CHARS = 320;

interface MemoryExportOptions {
  currentOnly: boolean;
  format: MemoryExportFormat;
  projectDirectory: string;
}

interface MemoryRecallOptions {
  format: MemoryExportFormat;
  limit: number;
  projectDirectory: string;
  query?: string;
}

interface MemoryCaptureOptions {
  eventId: string;
  format: MemoryExportFormat;
  host: string;
  kind: string;
  mode: "off" | "on";
  projectDirectory: string;
  sessionId: string;
}

const readOptionValue = (
  arguments_: readonly string[],
  index: number,
  name: string,
  usage: string,
): { nextIndex: number; value: string } => {
  const value = arguments_[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`The ${name} option requires a value.\n${usage}`);
  }
  return { nextIndex: index + 1, value };
};

const parseProjectOption = (
  arguments_: readonly string[],
  index: number,
  argument: string,
  currentDirectory: string,
  projectSpecified: boolean,
  usage: string,
): { nextIndex: number; projectDirectory: string; projectSpecified: boolean } => {
  let requestedProject: string | undefined;
  let nextIndex = index;
  if (argument === "--project") {
    const read = readOptionValue(arguments_, index, "--project", usage);
    requestedProject = read.value;
    nextIndex = read.nextIndex;
  } else if (argument.startsWith("--project=")) {
    requestedProject = argument.slice("--project=".length);
  } else {
    throw new Error(`Unknown memory option: ${argument || "(empty)"}.\n${usage}`);
  }

  if (projectSpecified) {
    throw new Error("The --project option may be specified only once.");
  }
  if (requestedProject.length === 0) {
    throw new Error(`The --project option requires a directory.\n${usage}`);
  }
  return {
    nextIndex,
    projectDirectory: resolve(currentDirectory, requestedProject),
    projectSpecified: true,
  };
};

// Parse the export-only surface strictly so ignored options cannot imply a different archive.
const parseMemoryExportOptions = (
  arguments_: readonly string[],
  currentDirectory: string,
): MemoryExportOptions => {
  let currentOnly = false;
  let format: MemoryExportFormat = "markdown";
  let projectDirectory = currentDirectory;
  let projectSpecified = false;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--current") {
      if (currentOnly) {
        throw new Error("The --current option may be specified only once.");
      }
      currentOnly = true;
      continue;
    }
    if (argument === "--json") {
      if (format === "json") {
        throw new Error("The --json option may be specified only once.");
      }
      format = "json";
      continue;
    }

    if (argument !== "--project" && !argument.startsWith("--project=")) {
      throw new Error(
        `Unknown memory export option: ${argument || "(empty)"}.\n${MEMORY_EXPORT_USAGE}`,
      );
    }
    const parsed = parseProjectOption(
      arguments_,
      index,
      argument,
      currentDirectory,
      projectSpecified,
      MEMORY_EXPORT_USAGE,
    );
    index = parsed.nextIndex;
    projectDirectory = parsed.projectDirectory;
    projectSpecified = parsed.projectSpecified;
  }

  return { currentOnly, format, projectDirectory };
};

const parseRecallLimit = (value: string): number => {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`The --limit option requires a positive integer.\n${MEMORY_RECALL_USAGE}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`The --limit option requires a positive integer.\n${MEMORY_RECALL_USAGE}`);
  }
  return Math.min(limit, MAX_RECALL_LIMIT);
};

const parseMemoryRecallOptions = (
  arguments_: readonly string[],
  currentDirectory: string,
): MemoryRecallOptions => {
  let format: MemoryExportFormat = "markdown";
  let limit = DEFAULT_RECALL_LIMIT;
  let limitSpecified = false;
  let projectDirectory = currentDirectory;
  let projectSpecified = false;
  let query: string | undefined;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--json") {
      if (format === "json") {
        throw new Error("The --json option may be specified only once.");
      }
      format = "json";
      continue;
    }
    if (argument === "--limit") {
      if (limitSpecified) {
        throw new Error("The --limit option may be specified only once.");
      }
      const read = readOptionValue(arguments_, index, "--limit", MEMORY_RECALL_USAGE);
      limit = parseRecallLimit(read.value);
      limitSpecified = true;
      index = read.nextIndex;
      continue;
    }
    if (argument.startsWith("--limit=")) {
      if (limitSpecified) {
        throw new Error("The --limit option may be specified only once.");
      }
      limit = parseRecallLimit(argument.slice("--limit=".length));
      limitSpecified = true;
      continue;
    }
    if (argument === "--query") {
      if (query !== undefined) {
        throw new Error("The --query option may be specified only once.");
      }
      const read = readOptionValue(arguments_, index, "--query", MEMORY_RECALL_USAGE);
      query = read.value;
      index = read.nextIndex;
      continue;
    }
    if (argument.startsWith("--query=")) {
      if (query !== undefined) {
        throw new Error("The --query option may be specified only once.");
      }
      query = argument.slice("--query=".length);
      if (query.length === 0) {
        throw new Error(`The --query option requires a value.\n${MEMORY_RECALL_USAGE}`);
      }
      continue;
    }

    if (argument !== "--project" && !argument.startsWith("--project=")) {
      throw new Error(
        `Unknown memory recall option: ${argument || "(empty)"}.\n${MEMORY_RECALL_USAGE}`,
      );
    }
    const parsed = parseProjectOption(
      arguments_,
      index,
      argument,
      currentDirectory,
      projectSpecified,
      MEMORY_RECALL_USAGE,
    );
    index = parsed.nextIndex;
    projectDirectory = parsed.projectDirectory;
    projectSpecified = parsed.projectSpecified;
  }

  return {
    format,
    limit,
    projectDirectory,
    ...(query === undefined ? {} : { query }),
  };
};

const requireNonEmptyOption = (
  options: { [key: string]: string | undefined },
  name: string,
): string => {
  const value = options[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`The --${name} option is required.\n${MEMORY_CAPTURE_USAGE}`);
  }
  return value;
};

const parseMemoryCaptureOptions = (
  arguments_: readonly string[],
  currentDirectory: string,
): MemoryCaptureOptions => {
  let format: MemoryExportFormat = "markdown";
  let mode: "off" | "on" = "on";
  let modeSpecified = false;
  let projectDirectory = currentDirectory;
  let projectSpecified = false;
  const stringOptions: { [key: string]: string | undefined } = {};

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--json") {
      if (format === "json") {
        throw new Error("The --json option may be specified only once.");
      }
      format = "json";
      continue;
    }
    if (argument === "--mode") {
      if (modeSpecified) {
        throw new Error("The --mode option may be specified only once.");
      }
      const read = readOptionValue(arguments_, index, "--mode", MEMORY_CAPTURE_USAGE);
      if (read.value !== "on" && read.value !== "off") {
        throw new Error(`The --mode option must be on or off.\n${MEMORY_CAPTURE_USAGE}`);
      }
      mode = read.value;
      modeSpecified = true;
      index = read.nextIndex;
      continue;
    }
    if (
      argument === "--host" ||
      argument === "--session-id" ||
      argument === "--kind" ||
      argument === "--event-id"
    ) {
      const key = argument.slice(2);
      if (stringOptions[key] !== undefined) {
        throw new Error(`The ${argument} option may be specified only once.`);
      }
      const read = readOptionValue(arguments_, index, argument, MEMORY_CAPTURE_USAGE);
      stringOptions[key] = read.value;
      index = read.nextIndex;
      continue;
    }

    if (argument !== "--project" && !argument.startsWith("--project=")) {
      throw new Error(
        `Unknown memory capture option: ${argument || "(empty)"}.\n${MEMORY_CAPTURE_USAGE}`,
      );
    }
    const parsed = parseProjectOption(
      arguments_,
      index,
      argument,
      currentDirectory,
      projectSpecified,
      MEMORY_CAPTURE_USAGE,
    );
    index = parsed.nextIndex;
    projectDirectory = parsed.projectDirectory;
    projectSpecified = parsed.projectSpecified;
  }

  return {
    eventId: requireNonEmptyOption(stringOptions, "event-id"),
    format,
    host: requireNonEmptyOption(stringOptions, "host"),
    kind: requireNonEmptyOption(stringOptions, "kind"),
    mode,
    projectDirectory,
    sessionId: requireNonEmptyOption(stringOptions, "session-id"),
  };
};

const escapeMarkdown = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`");

const singleLinePreview = (content: string): string => {
  const singleLine = content.replace(/\s+/gu, " ").trim();
  return singleLine.length <= MEMORY_LINE_MAX_CHARS
    ? singleLine
    : `${singleLine.slice(0, MEMORY_LINE_MAX_CHARS - 1)}…`;
};

const matchesQuery = (item: MemoryItemRecord, query: string): boolean => {
  const haystack = [
    item.class,
    item.content,
    item.id,
    item.sourceEventId ?? "",
    item.sourceEventKind ?? "",
    item.sourceHost ?? "",
    item.sourceUri ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
};

const boundedWorkingMemory = (
  collection: MemoryCollection,
  options: MemoryRecallOptions,
): MemoryCollection => {
  const filteredItems =
    options.query === undefined || options.query.trim().length === 0
      ? collection.items
      : collection.items.filter((item) => matchesQuery(item, options.query ?? ""));
  const items = filteredItems.slice(-options.limit);
  const itemIds = new Set(items.map(({ id }) => id));
  const decisions = collection.decisions.filter(
    ({ memoryItemId }) => memoryItemId !== null && itemIds.has(memoryItemId),
  );
  return { decisions, items, projectId: collection.projectId };
};

const renderMemoryRecall = (collection: MemoryCollection, format: MemoryExportFormat): string => {
  if (format === "json") {
    return JSON.stringify({
      decisions: collection.decisions,
      items: collection.items,
      projectId: collection.projectId,
      schemaVersion: 1,
    });
  }
  if (collection.items.length === 0) {
    return "## Szal memory\nNo matching Szal memory.";
  }
  return [
    "## Szal memory",
    ...collection.items.map((item) => {
      const source = [item.sourceHost, item.sourceEventKind].filter(Boolean).join("/");
      const suffix = source.length === 0 ? "" : ` (${source})`;
      return `- [${item.class}:${item.status}]${suffix} ${escapeMarkdown(singleLinePreview(item.content))}`;
    }),
  ].join("\n");
};

const readLifecycleCandidates = (): HostLifecycleMemoryCandidate[] => {
  const payload = readFileSync(0, "utf8");
  const parsed = payload.trim().length === 0 ? [] : (JSON.parse(payload) as unknown);
  if (!Array.isArray(parsed)) {
    throw new Error("Host lifecycle candidates must be a JSON array.");
  }
  return parsed as HostLifecycleMemoryCandidate[];
};

const runMemoryExport = (context: Parameters<CommandHandler>[0]) => {
  const options = parseMemoryExportOptions(context.arguments_, context.projectDirectory);
  const resolvedProject = resolveProjectIdentity(options.projectDirectory);
  const storage = openSzalDatabase({
    environment: { ...context.environment },
    homeDirectory: context.homeDirectory,
  });

  try {
    const storedProject = findMemoryProject(storage.connection, options.projectDirectory);
    const project = storedProject ?? resolvedProject;
    const collection: MemoryCollection =
      storedProject === null
        ? { decisions: [], items: [], projectId: project.id }
        : readMemoryArchive(storage.connection, project.id, {
            currentOnly: options.currentOnly,
          });
    return renderMemoryExport(project, collection, options.format);
  } finally {
    storage.connection.close();
  }
};

const runMemoryRecall = (context: Parameters<CommandHandler>[0]) => {
  const options = parseMemoryRecallOptions(context.arguments_, context.projectDirectory);
  const policy = loadMemoryPolicy({
    environment: context.environment,
    homeDirectory: context.homeDirectory,
  });
  const storage = openSzalDatabase({
    environment: { ...context.environment },
    homeDirectory: context.homeDirectory,
  });

  try {
    const project = findMemoryProject(storage.connection, options.projectDirectory);
    const collection: MemoryCollection =
      project === null
        ? {
            decisions: [],
            items: [],
            projectId: resolveProjectIdentity(options.projectDirectory).id,
          }
        : readWorkingMemory(storage.connection, project.id, policy);
    return renderMemoryRecall(boundedWorkingMemory(collection, options), options.format);
  } finally {
    storage.connection.close();
  }
};

const runMemoryCapture = (context: Parameters<CommandHandler>[0]) => {
  const options = parseMemoryCaptureOptions(context.arguments_, context.projectDirectory);
  const policy = loadMemoryPolicy({
    environment: context.environment,
    homeDirectory: context.homeDirectory,
  });
  const candidates = readLifecycleCandidates();
  const storage = openSzalDatabase({
    environment: { ...context.environment },
    homeDirectory: context.homeDirectory,
  });

  try {
    const project = resolveMemoryProject(storage.connection, options.projectDirectory);
    recordTelemetrySession(storage.connection, {
      host: options.host,
      id: options.sessionId,
      mode: options.mode,
      projectId: project.id,
    });
    const result = captureHostLifecycleMemory(
      storage.connection,
      project.id,
      {
        candidates,
        eventId: options.eventId,
        host: options.host,
        kind: options.kind,
        sessionId: options.sessionId,
      },
      policy,
    );
    return options.format === "json"
      ? JSON.stringify({
          accepted: result.accepted.length,
          projectId: project.id,
          rejected: result.rejected.length,
          schemaVersion: 1,
        })
      : `Captured ${String(result.accepted.length)} Szal memory item(s); rejected ${String(result.rejected.length)}.`;
  } finally {
    storage.connection.close();
  }
};

// Export external memory to stdout without registering a new project unless an integration captures facts.
export const runMemory: CommandHandler = (context) => {
  try {
    if (context.arguments_[0] === "export") {
      const rendered = runMemoryExport(context);
      context.stdout(rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered);
      return 0;
    }
    if (context.arguments_[0] === "recall") {
      const rendered = runMemoryRecall(context);
      context.stdout(rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered);
      return 0;
    }
    if (context.arguments_[0] === "capture-host-lifecycle") {
      const rendered = runMemoryCapture(context);
      context.stdout(rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered);
      return 0;
    }
    throw new Error(`${MEMORY_EXPORT_USAGE}\n${MEMORY_RECALL_USAGE}`);
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
