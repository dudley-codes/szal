import {
  installShellIntegration,
  resolveSupportedShell,
  restoreShellIntegration,
  uninstallShellIntegration,
  type ShellIntegrationResult,
} from "../../core/shell/index.js";
import type { CommandHandler } from "./types.js";

const SHELL_USAGE = `Usage:
  szal shell install [bash|zsh] [--terminal-id]
  szal shell uninstall [bash|zsh]
  szal shell restore [bash|zsh]`;

// Parse the deliberately small shell lifecycle surface and report every changed file.
export const runShell: CommandHandler = ({
  arguments_,
  environment,
  homeDirectory,
  stderr,
  stdout,
}) => {
  const [action, ...options] = arguments_;

  if (action !== "install" && action !== "uninstall" && action !== "restore") {
    stderr(SHELL_USAGE);
    return 1;
  }

  const includeTerminalIdentifier = options.includes("--terminal-id");
  const shellArguments = options.filter((option) => option !== "--terminal-id");

  if (
    shellArguments.length > 1 ||
    (action !== "install" && includeTerminalIdentifier) ||
    shellArguments.some((shell) => shell !== "bash" && shell !== "zsh")
  ) {
    stderr(SHELL_USAGE);
    return 1;
  }

  try {
    const shell = resolveSupportedShell(shellArguments[0], environment);
    let result: ShellIntegrationResult;

    if (action === "install") {
      result = installShellIntegration(shell, homeDirectory, { includeTerminalIdentifier });
    } else if (action === "uninstall") {
      result = uninstallShellIntegration(shell, homeDirectory);
    } else {
      result = restoreShellIntegration(shell, homeDirectory);
    }

    reportResult(action, result, stdout);
    return 0;
  } catch (error) {
    stderr(`Shell integration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

const reportResult = (
  action: "install" | "restore" | "uninstall",
  result: ShellIntegrationResult,
  stdout: (message: string) => void,
): void => {
  if (!result.changed) {
    const state =
      action === "install"
        ? "already installed"
        : action === "uninstall"
          ? "not installed"
          : "already identical to the latest backup";
    stdout(`Shell integration is ${state}.`);
    return;
  }

  const verb = action === "install" ? "Installed" : action === "uninstall" ? "Removed" : "Restored";
  stdout(`${verb} ${result.shell} integration in ${result.configPath}.`);
  if (result.backupPath !== null) {
    stdout(`Backup: ${result.backupPath}`);
  }
  stdout(
    action === "install"
      ? `Start a new ${result.shell} session or source ${result.configPath}.`
      : `Start a new ${result.shell} session to apply this change.`,
  );
};
