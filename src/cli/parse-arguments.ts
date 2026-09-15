export type CliCommandName =
  | "config"
  | "doctor"
  | "help"
  | "install"
  | "memory"
  | "off"
  | "on"
  | "shell"
  | "status"
  | "version";

export type ParsedArguments =
  | { arguments_?: readonly string[]; command: CliCommandName; kind: "command" }
  | { input: string; kind: "invalid" };

const COMMAND_ALIASES: ReadonlyMap<string, CliCommandName> = new Map([
  ["config", "config"],
  ["doctor", "doctor"],
  ["help", "help"],
  ["--help", "help"],
  ["-h", "help"],
  ["install", "install"],
  ["--install", "install"],
  ["-install", "install"],
  ["memory", "memory"],
  ["shell", "shell"],
  ["off", "off"],
  ["--off", "off"],
  ["-off", "off"],
  ["on", "on"],
  ["--on", "on"],
  ["-on", "on"],
  ["status", "status"],
  ["version", "version"],
  ["--version", "version"],
  ["-v", "version"],
]);

// Normalize every public spelling before dispatch so aliases share one handler.
export const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  if (arguments_.length === 0) {
    return { command: "help", kind: "command" };
  }

  const command = COMMAND_ALIASES.get(arguments_[0] ?? "");
  if (command === undefined) {
    return { input: arguments_.join(" "), kind: "invalid" };
  }

  const commandArguments = arguments_.slice(1);
  if ((command === "help" || command === "version") && commandArguments.length > 0) {
    return { input: arguments_.join(" "), kind: "invalid" };
  }

  return commandArguments.length === 0
    ? { command, kind: "command" }
    : { arguments_: commandArguments, command, kind: "command" };
};
