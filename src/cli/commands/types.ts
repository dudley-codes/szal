export interface CommandContext {
  stdout: (message: string) => void;
  version: string;
}

export type CommandHandler = (context: CommandContext) => number;
