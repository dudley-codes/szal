import type { CommandHandler } from "./types.js";

export const runHelp: CommandHandler = ({ stdout, version }) => {
  stdout(`Szal ${version}

Agent-agnostic context virtualization for terminal-based coding agents.

Usage:
  szal [command]

Commands:
  help       Show command help
  shell      Install, uninstall, or restore bash/zsh integration
  version    Show the installed version

Shell integration:
  szal shell install [bash|zsh] [--terminal-id]
  szal shell uninstall [bash|zsh]
  szal shell restore [bash|zsh]

Options:
  -h, --help       Show command help
  -v, --version    Show the installed version`);
  return 0;
};
