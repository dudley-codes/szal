import { readFileSync } from "node:fs";

import { loadConfig } from "../../core/config/index.js";
import {
  coldStoragePolicyFromConfig,
  openSzalDatabase,
  storeColdObject,
} from "../../core/storage/index.js";
import type { CommandHandler } from "./types.js";

const COLD_STORE_USAGE =
  "Usage: szal cold store [--category <category>] [--source-tool <tool>] [--source-path <path>] [--json]";

interface ColdStoreOptions {
  category: string;
  json: boolean;
  sourcePath?: string;
  sourceTool?: string;
}

const parseColdStoreOptions = (arguments_: readonly string[]): ColdStoreOptions => {
  if (arguments_[0] !== "store") {
    throw new Error(COLD_STORE_USAGE);
  }

  let category = "pi-tool-result";
  let categorySpecified = false;
  let json = false;
  let sourcePath: string | undefined;
  let sourceTool: string | undefined;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--json") {
      if (json) {
        throw new Error("The --json option may be specified only once.");
      }
      json = true;
      continue;
    }

    const readValue = (name: string): string => {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`The ${name} option requires a value.\n${COLD_STORE_USAGE}`);
      }
      index += 1;
      return value;
    };

    if (argument === "--category") {
      if (categorySpecified) {
        throw new Error("The --category option may be specified only once.");
      }
      categorySpecified = true;
      category = readValue("--category");
      continue;
    }
    if (argument === "--source-tool") {
      if (sourceTool !== undefined) {
        throw new Error("The --source-tool option may be specified only once.");
      }
      sourceTool = readValue("--source-tool");
      continue;
    }
    if (argument === "--source-path") {
      if (sourcePath !== undefined) {
        throw new Error("The --source-path option may be specified only once.");
      }
      sourcePath = readValue("--source-path");
      continue;
    }

    throw new Error(`Unknown cold store option: ${argument || "(empty)"}.\n${COLD_STORE_USAGE}`);
  }

  if (category.trim().length === 0) {
    throw new Error("The --category option must not be empty.");
  }

  return {
    category,
    json,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(sourceTool === undefined ? {} : { sourceTool }),
  };
};

// Private CLI helper for integrations that need to publish exact bytes before lossy shaping.
export const runCold: CommandHandler = ({
  arguments_,
  environment,
  homeDirectory,
  stderr,
  stdout,
}) => {
  try {
    const options = parseColdStoreOptions(arguments_);
    const payload = readFileSync(0);
    const loaded = loadConfig({ environment, homeDirectory });
    const policy = coldStoragePolicyFromConfig(loaded.config);
    const storage = openSzalDatabase({ environment: { ...environment }, homeDirectory });

    try {
      const stored = storeColdObject(
        storage.connection,
        storage.paths,
        payload,
        {
          category: options.category,
          ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
          ...(options.sourceTool === undefined ? {} : { sourceTool: options.sourceTool }),
        },
        { policy },
      );
      stdout(
        options.json
          ? JSON.stringify({
              contentHash: stored.contentHash,
              expiresAt: stored.expiresAt,
              id: stored.id,
              referenceId: stored.referenceId,
            })
          : stored.id,
      );
      return 0;
    } finally {
      storage.connection.close();
    }
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
