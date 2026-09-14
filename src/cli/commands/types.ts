export interface CommandContext {
  arguments_: readonly string[];
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  version: string;
}

export type CommandHandler = (context: CommandContext) => number;
