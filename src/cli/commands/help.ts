import type { CommandHandler } from "./types.js";

export const runHelp: CommandHandler = ({ stdout, version }) => {
  stdout(`Szal ${version}

Agent-agnostic context virtualization for terminal-based coding agents.

Usage:
  szal [command]

Commands:
  help       Show command help
  version    Show the installed version

Options:
  -h, --help       Show command help
  -v, --version    Show the installed version`);
  return 0;
};
