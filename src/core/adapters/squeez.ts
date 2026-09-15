import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, delimiter, join } from "node:path";

import {
  REQUIRED_PRESERVATION_FIELDS,
  type CompressionCapability,
  type CompressionEngineState,
} from "../compression/index.js";
import type { ContentCategory } from "../config/index.js";
import {
  COMPRESSION_ENGINE_CAPABILITIES,
  type CompressionEngineAdapter,
  type CompressionEngineCapabilityName,
} from "./compression-engine.js";
import {
  availableCapability,
  degradedCapability,
  unavailableCapability,
  type AdapterContext,
  type AdapterDetection,
  type AdapterIssue,
  type CapabilityResult,
} from "./shared.js";

export const MINIMUM_SAFE_SQUEEZ_VERSION = "1.46.0";

export const SQUEEZ_SUPPORTED_HOSTS = [
  {
    capabilities: ["bash-wrap", "session-memory", "hard-tool-budget", "tool-output-rewrite"],
    id: "claude-code",
  },
  {
    capabilities: ["bash-wrap", "session-memory", "hard-tool-budget"],
    id: "copilot",
  },
  {
    capabilities: ["bash-wrap", "session-memory", "hard-tool-budget"],
    id: "opencode",
  },
  {
    capabilities: ["bash-wrap", "session-memory", "soft-tool-budget"],
    id: "gemini",
  },
  {
    capabilities: ["bash-wrap", "session-memory", "soft-tool-budget"],
    id: "codex",
  },
  {
    capabilities: ["bash-wrap", "session-memory", "hard-tool-budget"],
    id: "pi",
  },
  {
    capabilities: ["bash-wrap", "session-memory"],
    id: "hermes",
  },
] as const;

export const SQUEEZ_TOOL_OUTPUT_CATEGORIES = [
  "code",
  "tests",
  "json",
  "markdown",
  "memory",
] as const satisfies readonly ContentCategory[];

const SQUEEZ_OWNED_CATEGORIES = [
  "bash",
  ...SQUEEZ_TOOL_OUTPUT_CATEGORIES,
] as const satisfies readonly ContentCategory[];

const SQUEEZ_OWNED_CATEGORY_SET: ReadonlySet<ContentCategory> = new Set(SQUEEZ_OWNED_CATEGORIES);

export const SQUEEZ_COMPRESSION_CAPABILITIES: readonly CompressionCapability[] =
  SQUEEZ_OWNED_CATEGORIES.map((category) => ({
    category,
    preserves: REQUIRED_PRESERVATION_FIELDS,
    safety: "lossy-recoverable",
  }));

export interface SqueezDetectionDetails {
  detectedHosts: readonly (typeof SQUEEZ_SUPPORTED_HOSTS)[number]["id"][];
  executablePath: string;
  ownershipSafe: boolean;
  supportedHosts: typeof SQUEEZ_SUPPORTED_HOSTS;
  version: string;
}

export interface SqueezCommandResult {
  error?: string;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type SqueezCommandRunner = (
  executablePath: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => SqueezCommandResult;

export interface SqueezAdapterOptions {
  runCommand?: SqueezCommandRunner;
}

const MISSING_SQUEEZ: AdapterIssue = {
  code: "squeez-not-found",
  message: "squeez is not installed or is not executable.",
  remediation: "Install squeez 1.46.0 or newer, then run 'szal doctor' again.",
  retryable: false,
};

const UNSAFE_SQUEEZ_VERSION: AdapterIssue = {
  code: "squeez-preservation-version-required",
  message: `squeez ${MINIMUM_SAFE_SQUEEZ_VERSION} or newer is required for enforced preservation guards.`,
  remediation: "Update squeez before assigning it compression ownership.",
  retryable: false,
};

const UNSUPPORTED_CAPABILITY: AdapterIssue = {
  code: "squeez-capability-unsupported",
  message: "squeez cannot safely own this content category.",
  retryable: false,
};

const findExecutable = (context: AdapterContext): string | undefined => {
  const executableNames =
    process.platform === "win32"
      ? (context.environment.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter((extension) => extension.length > 0)
          .map((extension) => `squeez${extension.toLowerCase()}`)
      : ["squeez"];
  const pathDirectories = (context.environment.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0 && isAbsolute(directory));
  const candidates = [
    ...pathDirectories.flatMap((directory) => executableNames.map((name) => join(directory, name))),
    join(context.homeDirectory, ".claude", "squeez", "bin", executableNames[0] ?? "squeez"),
  ];

  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

const defaultRunCommand: SqueezCommandRunner = (executablePath, arguments_, environment) => {
  const result = spawnSync(executablePath, arguments_, {
    encoding: "utf8",
    env: { ...environment },
    timeout: 2_000,
    windowsHide: true,
  });
  return {
    ...(result.error === undefined ? {} : { error: result.error.message }),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const parseVersion = (output: string): string | undefined =>
  /^squeez\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/im.exec(output.trim())?.[1];

const versionParts = (version: string): readonly number[] =>
  version
    .split(/[+-]/u, 1)[0]
    ?.split(".")
    .map((part) => Number.parseInt(part, 10)) ?? [];

const isSafeVersion = (version: string): boolean => {
  const actual = versionParts(version);
  const minimum = versionParts(MINIMUM_SAFE_SQUEEZ_VERSION);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
};

const detectedHosts = (
  context: AdapterContext,
): readonly (typeof SQUEEZ_SUPPORTED_HOSTS)[number]["id"][] => {
  const xdgConfigHome = context.environment.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : join(context.homeDirectory, ".config");
  const hostDirectories = {
    "claude-code": join(context.homeDirectory, ".claude"),
    codex: join(context.homeDirectory, ".codex"),
    copilot: join(context.homeDirectory, ".copilot"),
    gemini: join(context.homeDirectory, ".gemini"),
    hermes: join(context.homeDirectory, ".hermes"),
    opencode: join(configHome, "opencode"),
    pi: join(context.homeDirectory, ".pi"),
  } as const;

  return SQUEEZ_SUPPORTED_HOSTS.filter((host) => existsSync(hostDirectories[host.id])).map(
    (host) => host.id,
  );
};

// Inspect only executable metadata and host directories, without changing squeez or host config.
export const inspectSqueez = (
  context: AdapterContext,
  runCommand: SqueezCommandRunner = defaultRunCommand,
): AdapterDetection<SqueezDetectionDetails> => {
  const executablePath = findExecutable(context);
  if (executablePath === undefined) {
    return { issue: MISSING_SQUEEZ, status: "unavailable" };
  }

  const result = runCommand(executablePath, ["--version"], context.environment);
  const version = result.status === 0 ? parseVersion(result.stdout) : undefined;
  if (version === undefined) {
    return {
      issue: {
        code: "squeez-version-unavailable",
        message: "squeez was found, but its version could not be verified.",
        remediation: "Run 'squeez --version' and repair or update the installation.",
        retryable: true,
      },
      status: "unavailable",
    };
  }

  return {
    details: {
      detectedHosts: detectedHosts(context),
      executablePath,
      ownershipSafe: isSafeVersion(version),
      supportedHosts: SQUEEZ_SUPPORTED_HOSTS,
      version,
    },
    status: "available",
  };
};

const compressionCategory = (
  capabilityName: CompressionEngineCapabilityName,
): ContentCategory | undefined => {
  const match = /^(code|bash|test|json|markdown|memory)-compression$/u.exec(capabilityName)?.[1];
  return match === "test" ? "tests" : (match as ContentCategory | undefined);
};

const inspectCapabilities = (
  detection: AdapterDetection<SqueezDetectionDetails>,
): readonly CapabilityResult<CompressionEngineCapabilityName, CompressionCapability>[] => {
  if (detection.status === "unavailable") {
    return COMPRESSION_ENGINE_CAPABILITIES.map((name) =>
      unavailableCapability(name, "optional", detection.issue),
    );
  }

  return COMPRESSION_ENGINE_CAPABILITIES.map((name) => {
    const category = compressionCategory(name);
    const supported =
      name === "request-recovery" ||
      name === "pass-through-measurement" ||
      (category !== undefined && SQUEEZ_OWNED_CATEGORY_SET.has(category));
    if (!supported) {
      return unavailableCapability(name, "optional", UNSUPPORTED_CAPABILITY);
    }
    if (!isSafeVersion(detection.details?.version ?? "0.0.0")) {
      return degradedCapability(name, "optional", UNSAFE_SQUEEZ_VERSION);
    }
    const details =
      category === undefined
        ? undefined
        : SQUEEZ_COMPRESSION_CAPABILITIES.find((capability) => capability.category === category);
    return availableCapability(name, "optional", details);
  });
};

export const squeezEngineState = (
  detection: AdapterDetection<SqueezDetectionDetails>,
): CompressionEngineState => ({
  available: detection.status === "available" && detection.details?.ownershipSafe === true,
  capabilities: SQUEEZ_COMPRESSION_CAPABILITIES,
  id: "squeez",
});

// Adapt squeez detection into the shared lifecycle without mutating host configuration.
export const createSqueezAdapter = (
  options: SqueezAdapterOptions = {},
): CompressionEngineAdapter<unknown, unknown, SqueezDetectionDetails> => {
  const inspect = (context: AdapterContext) =>
    inspectSqueez(context, options.runCommand ?? defaultRunCommand);

  return {
    capabilities: (context) => Promise.resolve(inspectCapabilities(inspect(context))),
    configure: () => Promise.resolve({ changed: false, status: "succeeded" }),
    descriptor: { id: "squeez", kind: "compression-engine", name: "squeez" },
    detect: (context) => Promise.resolve(inspect(context)),
    disable: () =>
      Promise.resolve({
        changed: false,
        issue: {
          code: "host-adapter-required",
          message: "squeez hooks must be disabled through the owning host adapter.",
          retryable: false,
        },
        status: "skipped",
      }),
    health: (context) => {
      const detection = inspect(context);
      if (detection.status === "unavailable") {
        return Promise.resolve({ issues: [detection.issue], status: "unavailable" });
      }
      if (!isSafeVersion(detection.details?.version ?? "0.0.0")) {
        return Promise.resolve({ issues: [UNSAFE_SQUEEZ_VERSION], status: "degraded" });
      }
      return Promise.resolve({ issues: [], status: "healthy" });
    },
    install: () =>
      Promise.resolve({
        changed: false,
        issue: {
          code: "host-adapter-required",
          message: "squeez setup must be coordinated by a host adapter before activation.",
          retryable: false,
        },
        status: "skipped",
      }),
    version: (context) => {
      const detection = inspect(context);
      return Promise.resolve(
        detection.status === "available"
          ? { status: "available", version: detection.details?.version ?? "unknown" }
          : { issue: detection.issue, status: "unavailable" },
      );
    },
  };
};
