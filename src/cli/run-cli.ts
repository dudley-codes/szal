import { runHelp } from "./commands/help.js";
import type { CommandHandler } from "./commands/types.js";
import { runVersion } from "./commands/version.js";
import { parseArguments, type CliCommandName } from "./parse-arguments.js";

export interface CliIo {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
}

export interface CliOptions {
  version: string;
}

const COMMAND_HANDLERS: Readonly<Record<CliCommandName, CommandHandler>> = {
  help: runHelp,
  version: runVersion,
};

const DEFAULT_IO: CliIo = {
  stderr: (message) => console.error(message),
  stdout: (message) => console.log(message),
};

// Dispatch parsed commands through injected I/O so behavior stays testable and embeddable.
export const runCli = (
  arguments_: readonly string[],
  options: CliOptions,
  io: CliIo = DEFAULT_IO,
): number => {
  const parsedArguments = parseArguments(arguments_);

  if (parsedArguments.kind === "invalid") {
    io.stderr(`Unknown command: ${parsedArguments.input || "(empty)"}`);
    io.stderr("Run 'szal help' to see available commands.");
    return 1;
  }

  return COMMAND_HANDLERS[parsedArguments.command]({
    stdout: io.stdout,
    version: options.version,
  });
};
