import { ConfigError, loadConfig } from "../../core/config/index.js";
import type { CommandHandler } from "./types.js";

const INSTALL_USAGE = "Usage: szal install claude|pi";

// Install a supported user-scoped agent integration and render safety-relevant outcomes explicitly.
export const runInstall: CommandHandler = async (context) => {
  if (context.arguments_.length !== 1) {
    context.stderr(INSTALL_USAGE);
    context.stdout("Claude Code restart required: no");
    return 1;
  }

  if (context.arguments_[0] === "pi") {
    const installPi =
      context.piAdapter?.install ??
      (await import("../../core/adapters/pi.js")).createPiAdapter().install;
    const result = await installPi(
      {
        environment: context.environment,
        homeDirectory: context.homeDirectory,
        projectDirectory: context.projectDirectory,
      },
      {},
    );

    if (result.status !== "succeeded") {
      context.stderr(
        `Pi installation ${result.status}: [${result.issue.code}] ${result.issue.message}`,
      );
      if (result.issue.remediation !== undefined) {
        context.stderr(`Remediation: ${result.issue.remediation}`);
      }
      if (result.status === "failed") {
        context.stderr(`Rollback complete: ${result.rolledBack ? "yes" : "no"}`);
      }
      context.stdout("Pi restart/reload required: no");
      return 1;
    }

    const details = result.details;
    if (details === undefined) {
      context.stderr("Pi installation failed: the adapter returned no installation details.");
      context.stdout("Pi restart/reload required: no");
      return 1;
    }

    context.stdout(`Pi: ${details.pi.version} (${details.pi.executablePath})`);
    context.stdout(`Config: ${details.pi.configDirectory}`);
    context.stdout(
      `Extension: ${details.extension.changed ? "installed" : "unchanged"} (${details.extension.path})`,
    );
    context.stdout(`Pi restart/reload required: ${result.requiresRestart === true ? "yes" : "no"}`);
    return 0;
  }

  if (context.arguments_[0] !== "claude") {
    context.stderr(INSTALL_USAGE);
    context.stdout("Claude Code restart required: no");
    return 1;
  }

  try {
    const config = loadConfig({
      environment: context.environment,
      homeDirectory: context.homeDirectory,
    }).config;
    const adapter =
      context.claudeAdapter ??
      (await import("../../core/adapters/claude.js")).createClaudeAdapter();
    const result = await adapter.install(
      {
        environment: context.environment,
        homeDirectory: context.homeDirectory,
        projectDirectory: context.projectDirectory,
      },
      { config },
    );

    if (result.status !== "succeeded") {
      context.stderr(
        `Claude installation ${result.status}: [${result.issue.code}] ${result.issue.message}`,
      );
      if (result.issue.remediation !== undefined) {
        context.stderr(`Remediation: ${result.issue.remediation}`);
      }
      if (result.status === "failed") {
        context.stderr(`Rollback complete: ${result.rolledBack ? "yes" : "no"}`);
      }
      context.stdout(
        `Claude Code restart required: ${result.status === "failed" && !result.rolledBack ? "yes" : "no"}`,
      );
      return 1;
    }

    const details = result.details;
    if (details === undefined) {
      context.stderr("Claude installation failed: the adapter returned no installation details.");
      context.stdout("Claude Code restart required: no");
      return 1;
    }

    context.stdout(`Claude Code: ${details.claude.version} (${details.claude.executablePath})`);
    context.stdout(
      `Settings: ${details.settings.changed ? "updated" : "unchanged"} (${details.settings.path})`,
    );
    context.stdout(
      `llmtrim: ${details.llmtrim.installation}; transport ${details.llmtrim.compression}`,
    );
    context.stdout(
      details.squeez.features.length > 0
        ? `squeez: ${details.squeez.state} ${details.squeez.features.join(", ")}${details.squeez.version === undefined ? "" : ` (${details.squeez.version})`}${details.squeez.state === "configured" ? "; verify activation with /status and /hooks" : ""}`
        : `squeez: ${details.squeez.state}; no non-overlapping features selected`,
    );
    const squeezeFallbacks = details.ownership.assignments.filter(
      (assignment) => assignment.owner !== "squeez" && assignment.reason.includes("squeez"),
    );
    for (const assignment of squeezeFallbacks) {
      context.stdout(`squeez ${assignment.category}: skipped - ${assignment.reason}`);
    }
    for (const backupPath of details.backupPaths) {
      context.stdout(`Backup: ${backupPath}`);
    }
    context.stdout(
      `Claude Code restart required: ${result.requiresRestart === true ? "yes" : "no"}`,
    );
    return 0;
  } catch (error) {
    context.stderr(error instanceof ConfigError ? error.message : String(error));
    context.stdout("Claude Code restart required: no");
    return 1;
  }
};
