export type CliCommandName = "help" | "version";

export type ParsedArguments =
  | { command: CliCommandName; kind: "command" }
  | { input: string; kind: "invalid" };

const COMMAND_ALIASES: ReadonlyMap<string, CliCommandName> = new Map([
  ["help", "help"],
  ["--help", "help"],
  ["-h", "help"],
  ["version", "version"],
  ["--version", "version"],
  ["-v", "version"],
]);

// Normalize every public spelling before dispatch so aliases share one handler.
export const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  if (arguments_.length === 0) {
    return { command: "help", kind: "command" };
  }

  if (arguments_.length !== 1) {
    return { input: arguments_.join(" "), kind: "invalid" };
  }

  const command = COMMAND_ALIASES.get(arguments_[0] ?? "");
  return command === undefined
    ? { input: arguments_[0] ?? "", kind: "invalid" }
    : { command, kind: "command" };
};
