import { runConfig } from "./commands/config.js";
import { runHelp } from "./commands/help.js";
import { runOff, runOn } from "./commands/terminal-state.js";
import { runStatus } from "./commands/status.js";
import type { CliComponentStatus, CommandHandler } from "./commands/types.js";
import { runVersion } from "./commands/version.js";
import { parseArguments, type CliCommandName } from "./parse-arguments.js";

export interface CliIo {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
}

export interface CliOptions {
  agent?: CliComponentStatus;
  engine?: CliComponentStatus;
  environment?: Readonly<Record<string, string | undefined>>;
  projectDirectory?: string;
  version: string;
}

const COMMAND_HANDLERS: Readonly<Record<CliCommandName, CommandHandler>> = {
  config: runConfig,
  help: runHelp,
  off: runOff,
  on: runOn,
  status: runStatus,
  version: runVersion,
};

const DEFAULT_IO: CliIo = {
  stderr: (message) => {
    console.error(message);
  },
  stdout: (message) => {
    console.log(message);
  },
};

// Dispatch parsed commands through injected state and I/O so terminal isolation is testable.
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
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    arguments_: parsedArguments.arguments_ ?? [],
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    environment: options.environment ?? process.env,
    projectDirectory: options.projectDirectory ?? process.cwd(),
    stderr: io.stderr,
    stdout: io.stdout,
    version: options.version,
  });
};

export type { CliComponentStatus } from "./commands/types.js";
