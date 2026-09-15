import type { AdapterContext, ClaudeAdapter, PiAdapter } from "../../core/adapters/index.js";
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
  piAdapter?: Partial<Pick<PiAdapter, "disable" | "install">>;
  projectDirectory: string;
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  stdoutRaw: (bytes: Uint8Array) => void;
  version: string;
}

export type CommandHandler = (context: CommandContext) => number | Promise<number>;
