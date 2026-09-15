import type { CommandHandler } from "./types.js";

const UNINSTALL_USAGE = "Usage: szal uninstall pi";

export const runUninstall: CommandHandler = async (context) => {
  if (context.arguments_.length !== 1 || context.arguments_[0] !== "pi") {
    context.stderr(UNINSTALL_USAGE);
    context.stdout("Pi restart/reload required: no");
    return 1;
  }

  const disablePi =
    context.piAdapter?.disable ??
    (await import("../../core/adapters/pi.js")).createPiAdapter().disable;
  const result = await disablePi({
    environment: context.environment,
    homeDirectory: context.homeDirectory,
    projectDirectory: context.projectDirectory,
  });

  if (result.status !== "succeeded") {
    context.stderr(
      `Pi uninstallation ${result.status}: [${result.issue.code}] ${result.issue.message}`,
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
    context.stderr("Pi uninstallation failed: the adapter returned no uninstallation details.");
    context.stdout("Pi restart/reload required: no");
    return 1;
  }

  context.stdout(
    `Extension: ${details.extension.changed ? "removed" : "absent"} (${details.extension.path})`,
  );
  context.stdout(`Pi restart/reload required: ${result.requiresRestart === true ? "yes" : "no"}`);
  return 0;
};
