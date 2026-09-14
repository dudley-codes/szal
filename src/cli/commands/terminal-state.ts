import { renderTerminalStateExport, type TerminalMode } from "../../core/terminal/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

const STATE_USAGE = `Usage:
  szal on [--shell-export]
  szal -on [--shell-export]
  szal off [--shell-export]
  szal -off [--shell-export]`;

// Keep both public spellings on one handler while providing a shell-safe integration output.
const runStateCommand = (mode: TerminalMode, context: CommandContext): number => {
  if (
    context.arguments_.length > 1 ||
    (context.arguments_.length === 1 && context.arguments_[0] !== "--shell-export")
  ) {
    context.stderr(STATE_USAGE);
    return 1;
  }

  const shellExport = renderTerminalStateExport(mode);
  if (context.arguments_[0] === "--shell-export") {
    context.stdout(shellExport);
    return 0;
  }

  context.stdout(`Requested Szal terminal state: ${mode.toUpperCase()}`);
  context.stdout(`Apply in the current shell: ${shellExport}`);
  context.stdout(
    mode === "on"
      ? "ON policy enables compression and keeps telemetry active."
      : "OFF policy uses pass-through compression and keeps baseline telemetry active.",
  );
  return 0;
};

export const runOn: CommandHandler = (context) => runStateCommand("on", context);
export const runOff: CommandHandler = (context) => runStateCommand("off", context);
