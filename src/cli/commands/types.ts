import type { CapabilityState } from "../../core/terminal/index.js";
import type { CompressionEngineState } from "../../core/compression/index.js";

export interface CliComponentStatus {
  detail?: string;
  name: string;
  state: CapabilityState;
}

export interface CommandContext {
  agent?: CliComponentStatus;
  arguments_: readonly string[];
  compressionEngines?: readonly CompressionEngineState[];
  engine?: CliComponentStatus;
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  projectDirectory: string;
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  version: string;
}

export type CommandHandler = (context: CommandContext) => number;
