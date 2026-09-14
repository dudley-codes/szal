import type { CommandHandler } from "./types.js";

export const runHelp: CommandHandler = ({ stdout, version }) => {
  stdout(`Szal ${version}

Agent-agnostic context virtualization for terminal-based coding agents.

Usage:
  szal [command]

Commands:
  on         Enable compression in this terminal
  off        Use pass-through compression in this terminal
  status     Show terminal, project, agent, engine, and telemetry state
  help       Show command help
  version    Show the installed version

Options:
  -on, --on         Alias for on
  -off, --off       Alias for off
  -h, --help        Show command help
  -v, --version     Show the installed version`);
  return 0;
};
