import { resolve } from "node:path";

import {
  findMemoryProject,
  openSzalDatabase,
  readMemoryArchive,
  renderMemoryExport,
  resolveProjectIdentity,
  type MemoryCollection,
  type MemoryExportFormat,
} from "../../core/storage/index.js";
import type { CommandHandler } from "./types.js";

const MEMORY_EXPORT_USAGE =
  "Usage: szal memory export [--project <directory>] [--current] [--json]";

interface MemoryExportOptions {
  currentOnly: boolean;
  format: MemoryExportFormat;
  projectDirectory: string;
}

// Parse the export-only surface strictly so ignored options cannot imply a different archive.
const parseMemoryExportOptions = (
  arguments_: readonly string[],
  currentDirectory: string,
): MemoryExportOptions => {
  if (arguments_[0] !== "export") {
    throw new Error(MEMORY_EXPORT_USAGE);
  }

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

    let requestedProject: string | undefined;
    if (argument === "--project") {
      requestedProject = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("--project=")) {
      requestedProject = argument.slice("--project=".length);
    } else {
      throw new Error(
        `Unknown memory export option: ${argument || "(empty)"}.\n${MEMORY_EXPORT_USAGE}`,
      );
    }

    if (projectSpecified) {
      throw new Error("The --project option may be specified only once.");
    }
    if (
      requestedProject === undefined ||
      requestedProject.length === 0 ||
      (argument === "--project" && requestedProject.startsWith("--"))
    ) {
      throw new Error(`The --project option requires a directory.\n${MEMORY_EXPORT_USAGE}`);
    }
    projectSpecified = true;
    projectDirectory = resolve(currentDirectory, requestedProject);
  }

  return { currentOnly, format, projectDirectory };
};

// Export external memory to stdout without registering a new project or writing inside it.
export const runMemory: CommandHandler = ({
  arguments_,
  environment,
  homeDirectory,
  projectDirectory,
  stderr,
  stdout,
}) => {
  try {
    const options = parseMemoryExportOptions(arguments_, projectDirectory);
    const resolvedProject = resolveProjectIdentity(options.projectDirectory);
    const storage = openSzalDatabase({
      environment: { ...environment },
      homeDirectory,
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
      const rendered = renderMemoryExport(project, collection, options.format);
      stdout(rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered);
      return 0;
    } finally {
      storage.connection.close();
    }
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
