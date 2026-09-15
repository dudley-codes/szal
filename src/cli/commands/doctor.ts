import { inspectSqueez, squeezEngineState } from "../../core/adapters/squeez.js";
import {
  REQUIRED_PRESERVATION_FIELDS,
  resolveCompressionOwnership,
  type CompressionEngineState,
  type CompressionOwnershipPlan,
} from "../../core/compression/index.js";
import { ConfigError, loadConfig } from "../../core/config/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

const DOCTOR_USAGE = "Usage: szal doctor [--json]";

const mergeEngineStates = (
  detectedSqueez: CompressionEngineState,
  provided: readonly CompressionEngineState[],
): readonly CompressionEngineState[] => {
  const engines = new Map<string, CompressionEngineState>([
    [
      "llmtrim",
      {
        available: false,
        capabilities: [],
        id: "llmtrim",
      },
    ],
    ["squeez", detectedSqueez],
  ]);
  for (const engine of provided) {
    engines.set(engine.id, engine);
  }
  return [...engines.values()];
};

const doctorStatus = (plan: CompressionOwnershipPlan): "degraded" | "failed" | "healthy" => {
  if (plan.issues.some((issue) => issue.severity === "error")) {
    return "failed";
  }
  return plan.issues.length > 0 ? "degraded" : "healthy";
};

const renderHumanReport = (
  context: CommandContext,
  plan: CompressionOwnershipPlan,
  squeezDetection: ReturnType<typeof inspectSqueez>,
): void => {
  context.stdout(`Szal ${context.version} doctor`);
  context.stdout(`Profile: ${plan.profile}`);
  context.stdout(
    squeezDetection.status === "available"
      ? `squeez: ${squeezDetection.details?.ownershipSafe === true ? "AVAILABLE" : "DEGRADED"} - ${squeezDetection.details?.version ?? "unknown"} (${squeezDetection.details?.executablePath ?? "unknown path"}); detected hosts: ${squeezDetection.details?.detectedHosts.join(", ") || "none"}`
      : `squeez: UNAVAILABLE - ${squeezDetection.issue.message}`,
  );
  context.stdout("Compression ownership:");
  for (const assignment of plan.assignments) {
    const owner = assignment.owner ?? "raw";
    context.stdout(
      `  ${assignment.category}: ${owner.toUpperCase()} [${assignment.state}] - ${assignment.reason}`,
    );
  }
  context.stdout(`Required preservation: ${REQUIRED_PRESERVATION_FIELDS.join(", ")}`);
  context.stdout(`Status: ${doctorStatus(plan).toUpperCase()}`);
};

// Report the effective compression policy without installing engines or changing host configuration.
export const runDoctor: CommandHandler = (context) => {
  const json = context.arguments_.length === 1 && context.arguments_[0] === "--json";
  if (context.arguments_.length > (json ? 1 : 0)) {
    context.stderr(DOCTOR_USAGE);
    return 1;
  }

  try {
    const loaded = loadConfig({
      environment: context.environment,
      homeDirectory: context.homeDirectory,
    });
    const adapterContext = {
      environment: context.environment,
      homeDirectory: context.homeDirectory,
      projectDirectory: context.projectDirectory,
    };
    const squeezDetection = inspectSqueez(adapterContext);
    const engines = mergeEngineStates(
      squeezEngineState(squeezDetection),
      context.compressionEngines ?? [],
    );
    const plan = resolveCompressionOwnership(loaded.config, engines);
    const status = doctorStatus(plan);

    if (json) {
      context.stdout(
        JSON.stringify(
          {
            engines: {
              squeez:
                squeezDetection.status === "available"
                  ? {
                      detectedHosts: squeezDetection.details?.detectedHosts ?? [],
                      executablePath: squeezDetection.details?.executablePath,
                      ownershipSafe: squeezDetection.details?.ownershipSafe ?? false,
                      status:
                        squeezDetection.details?.ownershipSafe === true ? "available" : "degraded",
                      supportedHosts: squeezDetection.details?.supportedHosts ?? [],
                      version: squeezDetection.details?.version,
                    }
                  : {
                      issue: squeezDetection.issue,
                      status: "unavailable",
                    },
            },
            issues: plan.issues,
            ownership: plan.assignments,
            preservation: REQUIRED_PRESERVATION_FIELDS,
            profile: plan.profile,
            schemaVersion: 1,
            status,
          },
          null,
          2,
        ),
      );
    } else {
      renderHumanReport(context, plan, squeezDetection);
    }
    return status === "failed" ? 1 : 0;
  } catch (error) {
    context.stderr(error instanceof ConfigError ? error.message : String(error));
    return 1;
  }
};
