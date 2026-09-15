import { openSzalDatabase, readColdObject } from "../../core/storage/index.js";
import type { CommandHandler } from "./types.js";

const COLD_OBJECT_ID_PATTERN = /^szal:\/\/cold\/sha256\/[a-f0-9]{64}$/u;
const RECALL_USAGE = "Usage: szal recall <szal://cold/sha256/<hash>>";

// Emit exact cold-object bytes by stable ID without adding framing or a trailing newline.
export const runRecall: CommandHandler = ({
  arguments_,
  environment,
  homeDirectory,
  stderr,
  stdoutRaw,
}) => {
  const id = arguments_[0];
  if (arguments_.length !== 1 || id === undefined || !COLD_OBJECT_ID_PATTERN.test(id)) {
    stderr(RECALL_USAGE);
    return 1;
  }

  try {
    const storage = openSzalDatabase({ environment: { ...environment }, homeDirectory });
    try {
      const result = readColdObject(storage.connection, storage.paths, id);
      if (result.status === "found") {
        stdoutRaw(result.content);
        return 0;
      }
      if (result.status === "corrupt") {
        stderr(`Cold object ${id} is corrupt: ${result.reason}.`);
        return 1;
      }
      stderr(`Cold object ${id} is ${result.status}.`);
      return 1;
    } finally {
      storage.connection.close();
    }
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
