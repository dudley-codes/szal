import type { AdapterContext, ClaudeAdapter } from "../../core/adapters/index.js";
import type { CompressionEngineState } from "../../core/compression/index.js";
import type { CapabilityState } from "../../core/terminal/index.js";

export interface CliComponentStatus {
  detail?: string;
  name: string;
  state: CapabilityState;
}

export interface CommandContext extends AdapterContext {
  agent?: CliComponentStatus;
  arguments_: readonly string[];
  claudeAdapter?: Pick<ClaudeAdapter, "install">;
  compressionEngines?: readonly CompressionEngineState[];
  engine?: CliComponentStatus;
  projectDirectory: string;
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  version: string;
}

export type CommandHandler = (context: CommandContext) => number | Promise<number>;
