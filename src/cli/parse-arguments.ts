export type CliCommandName = "help" | "shell" | "version";

export type ParsedArguments =
  | { arguments_: readonly string[]; command: CliCommandName; kind: "command" }
  | {
      input: string;
      kind: "invalid";
    };

const COMMAND_ALIASES: ReadonlyMap<string, CliCommandName> = new Map([
  ["help", "help"],
  ["--help", "help"],
  ["-h", "help"],
  ["shell", "shell"],
  ["version", "version"],
  ["--version", "version"],
  ["-v", "version"],
]);

// Normalize every public spelling before dispatch so aliases share one handler.
export const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  if (arguments_.length === 0) {
    return { arguments_: [], command: "help", kind: "command" };
  }

  const command = COMMAND_ALIASES.get(arguments_[0] ?? "");
  if (command === undefined || (command !== "shell" && arguments_.length !== 1)) {
    return { input: arguments_.join(" "), kind: "invalid" };
  }

  return { arguments_: arguments_.slice(1), command, kind: "command" };
};
