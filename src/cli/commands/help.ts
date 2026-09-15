import type { CommandHandler } from "./types.js";

export const runHelp: CommandHandler = ({ stdout, version }) => {
  stdout(`Szal ${version}

Agent-agnostic context virtualization for terminal-based coding agents.

Usage:
  szal [command]

Commands:
  config                      Show the global configuration
  config get <path>           Read one configuration value
  config set <path> <value>   Update one configuration value
  doctor                      Report engine and compression ownership health
  memory export               Export external structured memory
  install claude              Install the Claude Code integration safely
  install pi                  Install the global Pi extension
  uninstall pi                Remove the global Pi extension
  on                          Enable compression in this terminal
  off                         Use pass-through compression in this terminal
  shell                       Manage bash/zsh shell integration
  status                      Show terminal, project, agent, engine, and telemetry state
  help                        Show command help
  version                     Show the installed version

Shell integration:
  szal shell install [bash|zsh] [--terminal-id]
  szal shell uninstall [bash|zsh]
  szal shell restore [bash|zsh]

Memory export:
  szal memory export [--project <directory>] [--current] [--json]

Options:
  -install, --install <agent>   Alias for install
  -on, --on                    Alias for on
  -off, --off                  Alias for off
  -h, --help                   Show command help
  -v, --version                Show the installed version
  --json                       Emit JSON for config, doctor, and memory export commands`);
  return 0;
};
