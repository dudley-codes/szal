import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { runCold } from "./commands/cold.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runHelp } from "./commands/help.js";
import { runInstall } from "./commands/install.js";
import { runMemory } from "./commands/memory.js";
import { runShell } from "./commands/shell.js";
import { runOff, runOn } from "./commands/terminal-state.js";
import { runRecall } from "./commands/recall.js";
import { runStatus } from "./commands/status.js";
import type { CliComponentStatus, CommandHandler } from "./commands/types.js";
import { runUninstall } from "./commands/uninstall.js";
import { runVersion } from "./commands/version.js";
import { parseArguments, type CliCommandName } from "./parse-arguments.js";
import type { CompressionEngineState } from "../core/compression/index.js";
import type { ClaudeAdapter, PiAdapter } from "../core/adapters/index.js";

export interface CliIo {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  stdoutRaw?: (bytes: Uint8Array) => void;
}

export interface CliOptions {
  agent?: CliComponentStatus;
  claudeAdapter?: Pick<ClaudeAdapter, "install">;
  compressionEngines?: readonly CompressionEngineState[];
  engine?: CliComponentStatus;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  piAdapter?: Partial<Pick<PiAdapter, "disable" | "install">>;
  projectDirectory?: string;
  version: string;
}

const COMMAND_HANDLERS: Readonly<Record<CliCommandName, CommandHandler>> = {
  cold: runCold,
  config: runConfig,
  doctor: runDoctor,
  help: runHelp,
  install: runInstall,
  memory: runMemory,
  off: runOff,
  on: runOn,
  recall: runRecall,
  shell: runShell,
  status: runStatus,
  uninstall: runUninstall,
  version: runVersion,
};

const DEFAULT_IO: CliIo = {
  stderr: (message) => {
    console.error(message);
  },
  stdout: (message) => {
    console.log(message);
  },
  stdoutRaw: (bytes) => {
    process.stdout.write(bytes);
  },
};

// Dispatch parsed commands through injected state and I/O so terminal isolation is testable.
export const runCli = async (
  arguments_: readonly string[],
  options: CliOptions,
  io: CliIo = DEFAULT_IO,
): Promise<number> => {
  const parsedArguments = parseArguments(arguments_);
  const environment = options.environment ?? process.env;
  const environmentHome = environment.HOME;
  const homeDirectory =
    options.homeDirectory ??
    (environmentHome !== undefined && environmentHome.length > 0 && isAbsolute(environmentHome)
      ? environmentHome
      : homedir());

  if (parsedArguments.kind === "invalid") {
    io.stderr(`Unknown command: ${parsedArguments.input || "(empty)"}`);
    io.stderr("Run 'szal help' to see available commands.");
    return 1;
  }

  return COMMAND_HANDLERS[parsedArguments.command]({
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    arguments_: parsedArguments.arguments_ ?? [],
    ...(options.claudeAdapter === undefined ? {} : { claudeAdapter: options.claudeAdapter }),
    ...(options.compressionEngines === undefined
      ? {}
      : { compressionEngines: options.compressionEngines }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.piAdapter === undefined ? {} : { piAdapter: options.piAdapter }),
    environment,
    homeDirectory,
    projectDirectory: options.projectDirectory ?? process.cwd(),
    stderr: io.stderr,
    stdout: io.stdout,
    stdoutRaw:
      io.stdoutRaw ??
      ((bytes) => {
        process.stdout.write(bytes);
      }),
    version: options.version,
  });
};

export type { CliComponentStatus } from "./commands/types.js";
