import {
  ConfigError,
  getConfigValue,
  loadConfig,
  setConfigValue,
  writeConfig,
} from "../../core/config/index.js";
import type { CommandHandler } from "./types.js";

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

const parseValue = (input: string): unknown => {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
};

const parseCommandArguments = (
  arguments_: readonly string[],
): { arguments: string[]; json: boolean } => {
  const json = arguments_.includes("--json");
  const positionalArguments = arguments_.filter((argument) => argument !== "--json");
  return { arguments: positionalArguments, json };
};

// Present and mutate the global config through a small dotted-path command surface.
export const runConfig: CommandHandler = ({
  arguments_: rawArguments,
  environment,
  stderr,
  stdout,
}) => {
  try {
    const { arguments: arguments_, json } = parseCommandArguments(rawArguments);
    const loaded = loadConfig({ environment });
    const action = arguments_[0];

    if (action === undefined) {
      stdout(
        json
          ? formatJson(loaded.config)
          : `Configuration: ${loaded.path}\n${formatJson(loaded.config)}`,
      );
      return 0;
    }

    if (action === "get") {
      if (arguments_.length !== 2) {
        throw new ConfigError("Usage: szal config get <path> [--json]");
      }
      const path = arguments_[1] ?? "";
      const value = getConfigValue(loaded.config, path);
      stdout(json || typeof value !== "string" ? formatJson(value) : value);
      return 0;
    }

    if (action === "set") {
      if (arguments_.length < 3) {
        throw new ConfigError("Usage: szal config set <path> <value> [--json]");
      }
      const path = arguments_[1] ?? "";
      const value = parseValue(arguments_.slice(2).join(" "));
      const updated = setConfigValue(loaded.config, path, value);
      writeConfig(updated, { environment });
      stdout(
        json
          ? formatJson({ path, value: getConfigValue(updated, path) })
          : `Set ${path} to ${formatJson(getConfigValue(updated, path))}.`,
      );
      return 0;
    }

    throw new ConfigError(`Unknown config command: ${action}. Use 'get' or 'set'.`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
