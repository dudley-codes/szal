import { execFile, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, normalize } from "node:path";

import {
  PROFILE_OWNERSHIP_MATRIX,
  resolveCompressionOwnership,
  type CompressionEngineState,
  type CompressionOwnershipPlan,
} from "../compression/index.js";
import type { ContentCategory, SzalConfig } from "../config/index.js";
import {
  FileTransactionError,
  commitFileTransaction,
  type FileCommit,
  type ManagedFile,
} from "../file-transaction.js";
import type { AgentAdapter, AgentCapabilityName } from "./agent.js";
import {
  ClaudeSettingsError,
  claudeHookRegistrationEquals,
  listClaudeCommandHooks,
  loadClaudeSettings,
  patchClaudeSettings,
  readClaudeSettingsEnvironment,
  resolveClaudeConfigDirectory,
  resolveClaudeSettingsPath,
  serializeClaudeSettings,
  type ClaudeHookRegistration,
} from "./claude-settings.js";
import {
  LLMTRIM_NPM_PACKAGE,
  LLMTRIM_PERSISTED_ENVIRONMENT_KEYS,
  createLlmtrimAdapter,
  llmtrimEngineState,
  readLlmtrimConfigureRequest,
  selectLlmtrimManagedEnvironment,
  type LlmtrimAdapter,
  type LlmtrimConfigureRequest,
} from "./llmtrim.js";
import {
  SQUEEZ_TOOL_OUTPUT_CATEGORIES,
  inspectSqueez,
  squeezEngineState,
  type SqueezCommandRunner,
  type SqueezDetectionDetails,
} from "./squeez.js";
import {
  availableCapability,
  degradedCapability,
  unavailableCapability,
  type AdapterContext,
  type AdapterDetection,
  type AdapterIssue,
  type AdapterOperationResult,
  type CapabilityResult,
} from "./shared.js";

const COMMAND_TIMEOUT_MS = 10_000;
const SQUEEZ_SETUP_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 120_000;
const MINIMUM_INPUT_REWRITE_VERSION = "2.1.139";
const MINIMUM_OUTPUT_REWRITE_VERSION = "2.1.139";
const SQUEEZ_SCRIPT_MARKER = "# Managed by Szal: selective squeez Claude hook v1";
const SQUEEZ_SCRIPT_PREFIX = Buffer.from(`#!/usr/bin/env bash\n${SQUEEZ_SCRIPT_MARKER}\n`);
const SQUEEZ_TOOL_OUTPUT_CATEGORY_SET: ReadonlySet<ContentCategory> = new Set(
  SQUEEZ_TOOL_OUTPUT_CATEGORIES,
);

const CLAUDE_NOT_FOUND: AdapterIssue = {
  code: "claude-not-found",
  message: "The Claude Code executable is not installed or is not executable.",
  remediation: "Install Claude Code and make the claude executable available on PATH.",
  retryable: false,
};

const HOOK_ACTIVATION_UNVERIFIED: AdapterIssue = {
  code: "claude-hook-activation-unverified",
  message: "The hook was configured, but external policy may prevent activation in Claude Code.",
  remediation: "Restart Claude Code, then verify the hook with /status and /hooks.",
  retryable: false,
};

export interface ClaudeCommandInvocation {
  arguments: readonly string[];
  command: string;
  cwd?: string;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
}

export interface ClaudeCommandResult {
  errorCode?: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export type ClaudeCommandRunner = (
  invocation: ClaudeCommandInvocation,
) => Promise<ClaudeCommandResult>;

export interface ClaudeHookPolicy {
  allowManagedHooksOnly: boolean;
  disableAllHooks: boolean;
  source?: string;
  status: "disabled" | "managed-only" | "unverified";
}

export interface ClaudeHookSurface {
  postToolUse: boolean;
  preToolUse: boolean;
  toolOutputReplacement: boolean;
}

export interface ClaudeDetectionDetails {
  executablePath: string;
  hookPolicy: ClaudeHookPolicy;
  hookSurface: ClaudeHookSurface;
  settingsExists: boolean;
  settingsPath: string;
  version: string;
}

export type ClaudeSqueezFeature = "bash-wrap" | "hard-tool-budget" | "tool-output-rewrite";

export interface ClaudeInstallDetails {
  backupPaths: readonly string[];
  claude: {
    executablePath: string;
    version: string;
  };
  llmtrim: {
    compression: "disabled" | "enabled" | "pass-through" | "unavailable";
    installation: "existing" | "installed" | "skipped";
  };
  ownership: CompressionOwnershipPlan;
  settings: {
    changed: boolean;
    path: string;
  };
  squeez: {
    features: readonly ClaudeSqueezFeature[];
    state: "configured" | "skipped" | "unavailable";
    version?: string;
  };
}

export interface ClaudeInstallRequest {
  config: SzalConfig;
}

export type ClaudeConfigureRequest = ClaudeInstallRequest;

export interface SqueezHookSelection {
  postToolUse: boolean;
  preToolUse: boolean;
}

export interface StagedSqueezHooks {
  postToolUse: Buffer;
  preToolUse: Buffer;
}

export type SqueezHookStager = (
  context: AdapterContext,
  detection: SqueezDetectionDetails,
  selection: SqueezHookSelection,
) => Promise<StagedSqueezHooks>;

type ClaudeLlmtrim = Pick<
  LlmtrimAdapter,
  "configure" | "detect" | "disable" | "health" | "install"
>;

export interface ClaudeAdapterOptions {
  commitFiles?: typeof commitFileTransaction;
  llmtrim?: ClaudeLlmtrim;
  managedSettingsPaths?: readonly string[];
  now?: () => Date;
  runCommand?: ClaudeCommandRunner;
  squeezRunCommand?: SqueezCommandRunner;
  stageSqueezHooks?: SqueezHookStager;
  validateScript?: (path: string) => string | null;
}

export interface ClaudeAdapter extends AgentAdapter<
  ClaudeInstallRequest,
  ClaudeConfigureRequest,
  ClaudeDetectionDetails,
  AgentCapabilityName,
  ClaudeHookSurface
> {
  configure: (
    context: AdapterContext,
    request: ClaudeConfigureRequest,
  ) => Promise<AdapterOperationResult<ClaudeInstallDetails>>;
  install: (
    context: AdapterContext,
    request: ClaudeInstallRequest,
  ) => Promise<AdapterOperationResult<ClaudeInstallDetails>>;
}

interface ClaudeProbe {
  details: ClaudeDetectionDetails;
  settings: ReturnType<typeof loadClaudeSettings>;
}

interface ReconcileState {
  commit?: FileCommit;
  configuredEnvironment?: Readonly<Record<string, string>>;
  installedLlmtrim: boolean;
  llmtrimChanged: boolean;
  originalEnvironment: Readonly<Record<string, string | undefined>>;
  priorLlmtrimRequest?: LlmtrimConfigureRequest;
  priorLlmtrimRunning: boolean;
}

// Execute bounded commands without a shell so paths and arguments cannot be interpolated.
const defaultRunCommand: ClaudeCommandRunner = async (invocation) =>
  new Promise((resolve) => {
    const environment = Object.fromEntries(
      Object.entries(invocation.environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    execFile(
      invocation.command,
      [...invocation.arguments],
      {
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: invocation.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const errorCode = error !== null && typeof error.code === "string" ? error.code : undefined;
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({
          ...(errorCode === undefined ? {} : { errorCode }),
          exitCode,
          stderr,
          stdout,
        });
      },
    );
  });

const findExecutable = (context: AdapterContext): string | undefined => {
  const executableNames =
    process.platform === "win32"
      ? (context.environment.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter((extension) => extension.length > 0)
          .map((extension) => `claude${extension.toLowerCase()}`)
      : ["claude"];
  const directories = (context.environment.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0 && isAbsolute(directory));
  const candidates = directories.flatMap((directory) =>
    executableNames.map((name) => join(directory, name)),
  );
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

const parseClaudeVersion = (stdout: string): string | undefined =>
  /^(?:Claude Code\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s+\(Claude Code\))?$/iu.exec(
    stdout.trim(),
  )?.[1];

const versionCore = (version: string): readonly number[] =>
  version
    .split(/[+-]/u, 1)[0]
    ?.split(".")
    .map((part) => Number.parseInt(part, 10)) ?? [];

// Compare stable semantic versions and treat a prerelease as older than the matching stable release.
const isAtLeastVersion = (version: string, minimum: string): boolean => {
  const actual = versionCore(version);
  const expected = versionCore(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (expected[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return !version.includes("-") || minimum.includes("-");
};

// Fail closed when a future settings/hook schema has not been verified by this adapter.
const hasKnownClaudeSettingsSchema = (version: string): boolean =>
  /^2\.(?:0|1)\.\d+(?:\+[0-9A-Za-z.-]+)?$/u.test(version);

const managedSettingsPaths = (
  context: AdapterContext,
  configured: readonly string[] | undefined,
): readonly string[] => {
  if (configured !== undefined) {
    return configured;
  }
  if (process.platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  }
  if (process.platform === "win32") {
    const programFiles = context.environment.ProgramFiles ?? "C:\\Program Files";
    return [join(programFiles, "ClaudeCode", "managed-settings.json")];
  }
  return ["/etc/claude-code/managed-settings.json"];
};

const optionalBooleanSetting = (
  document: Readonly<Record<string, unknown>>,
  key: "allowManagedHooksOnly" | "disableAllHooks",
  path: string,
): boolean | undefined => {
  const value = document[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ClaudeSettingsError(`${path}.${key} must be a boolean.`);
  }
  return value;
};

// Report locally observed policy while leaving remote, MDM, registry, and helper activation unverified.
const inspectHookPolicy = (
  context: AdapterContext,
  userSettings: Readonly<Record<string, unknown>>,
  configuredManagedPaths: readonly string[] | undefined,
): ClaudeHookPolicy => {
  let disableAllHooks =
    optionalBooleanSetting(userSettings, "disableAllHooks", "Claude settings") ?? false;
  let allowManagedHooksOnly = false;
  let source: string | undefined;
  for (const path of managedSettingsPaths(context, configuredManagedPaths)) {
    if (!existsSync(path)) {
      continue;
    }
    const managed = loadClaudeSettings(path).document;
    const managedDisableAllHooks = optionalBooleanSetting(managed, "disableAllHooks", path);
    const managedOnly = optionalBooleanSetting(managed, "allowManagedHooksOnly", path);
    if (managedDisableAllHooks !== undefined) {
      disableAllHooks = managedDisableAllHooks;
    }
    if (managedOnly !== undefined) {
      allowManagedHooksOnly = managedOnly;
    }
    if (managedDisableAllHooks !== undefined || managedOnly !== undefined) {
      source = path;
    }
  }
  return {
    allowManagedHooksOnly,
    disableAllHooks,
    ...(source === undefined ? {} : { source }),
    status: disableAllHooks ? "disabled" : allowManagedHooksOnly ? "managed-only" : "unverified",
  };
};

const hookSurface = (version: string): ClaudeHookSurface => ({
  postToolUse: isAtLeastVersion(version, MINIMUM_OUTPUT_REWRITE_VERSION),
  preToolUse: isAtLeastVersion(version, MINIMUM_INPUT_REWRITE_VERSION),
  toolOutputReplacement: isAtLeastVersion(version, MINIMUM_OUTPUT_REWRITE_VERSION),
});

const commandFailureIssue = (operation: string, result: ClaudeCommandResult): AdapterIssue => ({
  code: `claude-${operation}-failed`,
  message:
    result.exitCode === null
      ? `The Claude ${operation} command could not be executed.`
      : `The Claude ${operation} command exited with code ${String(result.exitCode)}.`,
  remediation: "Repair the executable and retry the Claude installation.",
  retryable: true,
});

const failureIssue = (code: string, message: string, remediation?: string): AdapterIssue => ({
  code,
  message,
  ...(remediation === undefined ? {} : { remediation }),
  retryable: false,
});

const managedHooks = (configDirectory: string): readonly ClaudeHookRegistration[] => {
  const hookDirectory = join(configDirectory, "szal", "hooks");
  const preToolUse = join(hookDirectory, "squeez-pretooluse.sh");
  const postToolUse = join(hookDirectory, "squeez-posttooluse.sh");
  return [
    {
      event: "PreToolUse",
      handler: { args: [], command: preToolUse, timeout: 30, type: "command" },
      matcher: "^Bash$",
    },
    {
      event: "PreToolUse",
      handler: { args: [], command: preToolUse, timeout: 30, type: "command" },
      matcher: "^(Read|Grep|Glob)$",
    },
    {
      event: "PostToolUse",
      handler: { args: [], command: postToolUse, timeout: 30, type: "command" },
      matcher: "^(Read|Grep|Glob)$",
    },
  ];
};

const isKnownRegistration = (
  actual: ClaudeHookRegistration,
  known: readonly ClaudeHookRegistration[],
): boolean => known.some((candidate) => claudeHookRegistrationEquals(actual, candidate));

const looksLikeSqueezHook = (command: string): boolean => {
  const normalized = normalize(command).replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes("/squeez/hooks/pretooluse.sh") ||
    normalized.includes("/squeez/hooks/posttooluse.sh") ||
    normalized.endsWith("/szal/hooks/squeez-pretooluse.sh") ||
    normalized.endsWith("/szal/hooks/squeez-posttooluse.sh") ||
    /(?:^|\s|\/)squeez(?:\s|$)/u.test(normalized)
  );
};

// Existing broad upstream hooks can silently stack another lossy owner, so fail without mutating them.
const unmanagedSqueezHooks = (
  settings: Readonly<Record<string, unknown>>,
  known: readonly ClaudeHookRegistration[],
): readonly ClaudeHookRegistration[] =>
  listClaudeCommandHooks(settings).filter(
    (registration) =>
      (looksLikeSqueezHook(registration.handler.command) ||
        registration.handler.args?.some((argument) => looksLikeSqueezHook(argument)) === true) &&
      !isKnownRegistration(registration, known),
  );

const desiredSqueezFeatures = (
  plan: CompressionOwnershipPlan,
  surface: ClaudeHookSurface,
): readonly ClaudeSqueezFeature[] => {
  const owned = new Set(
    plan.assignments
      .filter((assignment) => assignment.owner === "squeez" && assignment.state === "active")
      .map((assignment) => assignment.category),
  );
  const features: ClaudeSqueezFeature[] = [];
  if (owned.has("bash")) {
    features.push("bash-wrap");
  }
  if (SQUEEZ_TOOL_OUTPUT_CATEGORIES.every((category) => owned.has(category))) {
    features.push("hard-tool-budget");
    if (surface.toolOutputReplacement) {
      features.push("tool-output-rewrite");
    }
  }
  return features;
};

const desiredHooksForFeatures = (
  known: readonly ClaudeHookRegistration[],
  features: readonly ClaudeSqueezFeature[],
): readonly ClaudeHookRegistration[] =>
  known.filter((registration) => {
    if (registration.event === "PostToolUse") {
      return features.includes("tool-output-rewrite");
    }
    if (registration.matcher === "^Bash$") {
      return features.includes("bash-wrap");
    }
    return features.includes("hard-tool-budget");
  });

const profileWantsSqueezCategory = (config: SzalConfig, category: ContentCategory): boolean => {
  const preference = config.ownership[category];
  return (
    preference === "squeez" ||
    (preference === "auto" && PROFILE_OWNERSHIP_MATRIX[config.profile][category][0] === "squeez")
  );
};

// Remove capabilities that upstream's broad tool scripts cannot isolate safely for this profile.
const deployableSqueezState = (
  config: SzalConfig,
  base: CompressionEngineState,
  policy: ClaudeHookPolicy,
  surface: ClaudeHookSurface,
): CompressionEngineState => {
  const hooksAvailable = policy.status === "unverified" && surface.preToolUse;
  const toolOutputSafe =
    hooksAvailable &&
    surface.toolOutputReplacement &&
    SQUEEZ_TOOL_OUTPUT_CATEGORIES.every((category) => profileWantsSqueezCategory(config, category));
  return {
    ...base,
    available: base.available && hooksAvailable,
    capabilities: base.capabilities.filter(
      (capability) =>
        capability.category === "bash" ||
        (toolOutputSafe && SQUEEZ_TOOL_OUTPUT_CATEGORY_SET.has(capability.category)),
    ),
  };
};

const assertExplicitOwnersAvailable = (
  config: SzalConfig,
  plan: CompressionOwnershipPlan,
): AdapterIssue | undefined => {
  for (const assignment of plan.assignments) {
    const preference = config.ownership[assignment.category];
    if ((preference === "llmtrim" || preference === "squeez") && assignment.owner !== preference) {
      return failureIssue(
        "claude-explicit-owner-unavailable",
        `${preference} cannot safely own ${assignment.category} with the detected Claude integration.`,
        `Change ownership.${assignment.category} or repair the ${preference} installation.`,
      );
    }
  }
  return undefined;
};

const findNamedFiles = (
  root: string,
  names: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const matches = new Map(names.map((name) => [name, [] as string[]]));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        matches.get(entry.name)?.push(path);
      }
    }
  };
  visit(root);
  return matches;
};

// Mark staged hooks as owned while removing automatic approval and quoting wrapped executables.
const markManagedScript = (contents: Buffer, removeAllowDecisions = false): Buffer => {
  let text = contents.toString("utf8");
  if (removeAllowDecisions) {
    const allowDecision = "'permissionDecision': 'allow', ";
    if (!text.includes(allowDecision)) {
      throw new ClaudeSettingsError(
        "The staged squeez PreToolUse hook has an unknown permission-decision shape.",
      );
    }
    text = text.replaceAll(allowDecision, "");
    if (/permissionDecision['"]?\s*:\s*['"]allow/iu.test(text)) {
      throw new ClaudeSettingsError(
        "The staged squeez PreToolUse hook still contains an automatic allow decision.",
      );
    }
    const unquotedWrapper = "d['tool_input']['command'] = squeez + ' wrap ' + shlex.quote(cmd)";
    if (!text.includes(unquotedWrapper)) {
      throw new ClaudeSettingsError(
        "The staged squeez PreToolUse hook has an unknown Bash wrapper shape.",
      );
    }
    text = text.replace(
      unquotedWrapper,
      "d['tool_input']['command'] = shlex.quote(squeez) + ' wrap ' + shlex.quote(cmd)",
    );
  }
  const body = text.startsWith("#!/usr/bin/env bash\n")
    ? text.slice("#!/usr/bin/env bash\n".length)
    : text;
  return Buffer.from(`#!/usr/bin/env bash\n${SQUEEZ_SCRIPT_MARKER}\n${body}`);
};

// Run broad upstream setup only inside an isolated HOME, then extract the two audited hook scripts.
const stageSqueezHooks = async (
  context: AdapterContext,
  detection: SqueezDetectionDetails,
  selection: SqueezHookSelection,
  runCommand: ClaudeCommandRunner,
): Promise<StagedSqueezHooks> => {
  const root = mkdtempSync(join(tmpdir(), "szal-squeez-stage-"));
  const home = join(root, "home");
  const claudeDirectory = join(home, ".claude");
  mkdirSync(claudeDirectory, { mode: 0o700, recursive: true });
  try {
    const result = await runCommand({
      arguments: ["setup", "--host=claude-code"],
      command: detection.executablePath,
      cwd: home,
      environment: {
        ...context.environment,
        CLAUDE_CONFIG_DIR: claudeDirectory,
        HOME: home,
        PWD: home,
        SQUEEZ_DIR: join(claudeDirectory, "squeez"),
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
      },
      timeoutMs: SQUEEZ_SETUP_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new ClaudeSettingsError(
        `squeez setup failed in the isolated staging directory: ${result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`}`,
      );
    }
    const names = [
      ...(selection.preToolUse ? ["pretooluse.sh"] : []),
      ...(selection.postToolUse ? ["posttooluse.sh"] : []),
    ];
    const matches = findNamedFiles(root, names);
    const requireStagedPath = (name: string, required: boolean): string | undefined => {
      if (!required) {
        return undefined;
      }
      const paths = matches.get(name) ?? [];
      const path = paths[0];
      if (paths.length !== 1 || path === undefined) {
        throw new ClaudeSettingsError(
          `squeez setup did not produce exactly one ${name} in staging.`,
        );
      }
      return path;
    };
    const prePath = requireStagedPath("pretooluse.sh", selection.preToolUse);
    const postPath = requireStagedPath("posttooluse.sh", selection.postToolUse);
    return {
      postToolUse:
        postPath === undefined ? Buffer.alloc(0) : markManagedScript(readFileSync(postPath)),
      preToolUse:
        prePath === undefined ? Buffer.alloc(0) : markManagedScript(readFileSync(prePath), true),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

// Validate generated hooks with a trusted absolute Bash rather than a PATH-selected executable.
const defaultValidateScript = (path: string): string | null => {
  const bashPath = ["/bin/bash", "/usr/bin/bash"].find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (bashPath === undefined) {
    return "No trusted Bash executable is available to validate the staged hook.";
  }
  const result = spawnSync(bashPath, ["-n", path], { encoding: "utf8" });
  if (result.error !== undefined) {
    return result.error.message;
  }
  return result.status === 0
    ? null
    : result.stderr || result.stdout || `bash exited ${String(result.status)}`;
};

const validateSettings = (path: string): string | null => {
  try {
    loadClaudeSettings(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const settingsEnvironment = (
  context: AdapterContext,
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | undefined>> => ({
  ...context.environment,
  ...readClaudeSettingsEnvironment(settings),
});

const issueFromError = (error: unknown): AdapterIssue =>
  failureIssue(
    error instanceof ClaudeSettingsError ? "claude-settings-invalid" : "claude-installation-failed",
    error instanceof Error ? error.message : String(error),
    "Restore the reported backup if needed, repair the configuration, and retry.",
  );

const operationFailure = (
  issue: AdapterIssue,
  changed: boolean,
  rolledBack: boolean,
): AdapterOperationResult<ClaudeInstallDetails> => ({
  changed,
  issue,
  rolledBack,
  status: "failed",
});

const issueWithBackups = (issue: AdapterIssue, backupPaths: readonly string[]): AdapterIssue =>
  backupPaths.length === 0
    ? issue
    : { ...issue, message: `${issue.message} Backups: ${backupPaths.join(", ")}.` };

// Verify all observable postconditions before allowing a transaction to remain committed.
const verifyInstallation = async (
  settingsPath: string,
  expectedSettings: Buffer,
  desiredHooks: readonly ClaudeHookRegistration[],
  knownHooks: readonly ClaudeHookRegistration[],
  llmtrim: ClaudeLlmtrim,
  llmtrimContext: AdapterContext,
  compression: ClaudeInstallDetails["llmtrim"]["compression"],
): Promise<AdapterIssue | undefined> => {
  const loaded = loadClaudeSettings(settingsPath);
  if (!loaded.serialized.equals(expectedSettings)) {
    return failureIssue(
      "claude-settings-verification-failed",
      "Claude settings changed before installation verification completed.",
      "Review the settings file and retry.",
    );
  }
  const actualHooks = listClaudeCommandHooks(loaded.document);
  const actualManagedHooks = actualHooks.filter((actual) =>
    isKnownRegistration(actual, knownHooks),
  );
  if (
    actualManagedHooks.length !== desiredHooks.length ||
    !desiredHooks.every((desired) => isKnownRegistration(desired, actualManagedHooks))
  ) {
    return failureIssue(
      "claude-hooks-verification-failed",
      "The installed Szal hook entries could not be verified.",
      "Review Claude settings and retry.",
    );
  }
  if (compression === "enabled") {
    const health = await llmtrim.health(llmtrimContext);
    if (health.status !== "healthy") {
      return (
        health.issues[0] ??
        failureIssue("llmtrim-health-verification-failed", "llmtrim is not healthy after setup.")
      );
    }
  }
  return undefined;
};

const uninstallNewLlmtrim = async (
  context: AdapterContext,
  runCommand: ClaudeCommandRunner,
  packageManager: "npm",
): Promise<boolean> => {
  const result = await runCommand({
    arguments: ["uninstall", "--global", LLMTRIM_NPM_PACKAGE],
    command: packageManager,
    environment: context.environment,
    timeoutMs: PACKAGE_TIMEOUT_MS,
  });
  return result.exitCode === 0;
};

// Compensate engine and file changes after any later installation failure.
const rollbackReconcile = async (
  context: AdapterContext,
  state: ReconcileState,
  llmtrim: ClaudeLlmtrim,
  runCommand: ClaudeCommandRunner,
  packageManager: "npm",
): Promise<boolean> => {
  let rolledBack = state.commit?.rollback() ?? true;
  if (state.llmtrimChanged) {
    if (state.priorLlmtrimRunning && state.priorLlmtrimRequest !== undefined) {
      const restored = await llmtrim.configure(
        { ...context, environment: state.originalEnvironment },
        state.priorLlmtrimRequest,
      );
      rolledBack = restored.status === "succeeded" && rolledBack;
    } else if (!state.priorLlmtrimRunning) {
      const stopped = await llmtrim.disable({
        ...context,
        environment: state.configuredEnvironment ?? state.originalEnvironment,
      });
      rolledBack = stopped.status === "succeeded" && rolledBack;
    }
  }
  if (state.installedLlmtrim) {
    rolledBack = (await uninstallNewLlmtrim(context, runCommand, packageManager)) && rolledBack;
  }
  return rolledBack;
};

// Create the concrete Claude boundary while keeping all external mutation points injectable.
export const createClaudeAdapter = (options: ClaudeAdapterOptions = {}): ClaudeAdapter => {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const llmtrim = options.llmtrim ?? createLlmtrimAdapter();
  const commitFiles = options.commitFiles ?? commitFileTransaction;
  const now = options.now ?? (() => new Date());
  const validateScript = options.validateScript ?? defaultValidateScript;

  // Probe only executable metadata so version checks never read or validate user configuration.
  const probeExecutable = async (
    context: AdapterContext,
  ): Promise<{ executablePath: string; version: string } | AdapterIssue> => {
    const executablePath = findExecutable(context);
    if (executablePath === undefined) {
      return CLAUDE_NOT_FOUND;
    }
    const result = await runCommand({
      arguments: ["--version"],
      command: executablePath,
      environment: context.environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return commandFailureIssue("version", result);
    }
    const version = parseClaudeVersion(result.stdout);
    return version === undefined
      ? failureIssue(
          "claude-version-invalid",
          "Claude Code returned an unrecognized version string.",
          "Upgrade Claude Code and verify 'claude --version'.",
        )
      : { executablePath, version };
  };

  const probe = async (context: AdapterContext): Promise<ClaudeProbe | AdapterIssue> => {
    const executable = await probeExecutable(context);
    if (!("executablePath" in executable)) {
      return executable;
    }
    const { executablePath, version } = executable;
    if (!hasKnownClaudeSettingsSchema(version)) {
      return failureIssue(
        "claude-version-unsupported",
        `Claude Code ${version} uses an unverified settings or hook schema.`,
        "Upgrade Szal to a release that verifies this Claude Code version.",
      );
    }
    try {
      const settingsPath = resolveClaudeSettingsPath(context);
      const settings = loadClaudeSettings(settingsPath);
      return {
        details: {
          executablePath,
          hookPolicy: inspectHookPolicy(context, settings.document, options.managedSettingsPaths),
          hookSurface: hookSurface(version),
          settingsExists: settings.exists,
          settingsPath,
          version,
        },
        settings,
      };
    } catch (error) {
      return issueFromError(error);
    }
  };

  const detect = async (
    context: AdapterContext,
  ): Promise<AdapterDetection<ClaudeDetectionDetails>> => {
    const result = await probe(context);
    return "details" in result
      ? { details: result.details, status: "available" }
      : { issue: result, status: "unavailable" };
  };

  const capabilities = async (
    context: AdapterContext,
  ): Promise<readonly CapabilityResult<AgentCapabilityName, ClaudeHookSurface>[]> => {
    const detection = await detect(context);
    if (detection.status === "unavailable" || detection.details === undefined) {
      const issue = detection.status === "unavailable" ? detection.issue : CLAUDE_NOT_FOUND;
      return [
        unavailableCapability("transport-configuration", "required", issue),
        unavailableCapability("input-rewrite", "optional", issue),
        unavailableCapability("output-rewrite", "optional", issue),
      ];
    }
    const details = detection.details;
    const transport = availableCapability(
      "transport-configuration" as const,
      "required",
      details.hookSurface,
    );
    if (details.hookPolicy.status === "disabled" || details.hookPolicy.status === "managed-only") {
      const issue = failureIssue(
        details.hookPolicy.status === "disabled"
          ? "claude-hooks-disabled"
          : "claude-managed-hooks-only",
        details.hookPolicy.status === "disabled"
          ? "Claude Code hooks are disabled by effective settings."
          : "Claude Code is restricted to organization-managed hooks.",
        details.hookPolicy.source === undefined
          ? "Review Claude settings before enabling squeez."
          : `Review the policy at ${details.hookPolicy.source}.`,
      );
      return [
        transport,
        unavailableCapability("input-rewrite", "optional", issue),
        unavailableCapability("output-rewrite", "optional", issue),
      ];
    }
    const input = details.hookSurface.preToolUse
      ? degradedCapability(
          "input-rewrite" as const,
          "optional",
          HOOK_ACTIVATION_UNVERIFIED,
          details.hookSurface,
        )
      : degradedCapability(
          "input-rewrite" as const,
          "optional",
          {
            code: "claude-input-rewrite-version-required",
            message: `Claude Code ${MINIMUM_INPUT_REWRITE_VERSION} or newer is required for safe tool-input replacement.`,
            remediation: "Upgrade Claude Code before enabling squeez hooks.",
            retryable: false,
          },
          details.hookSurface,
        );
    const output = details.hookSurface.toolOutputReplacement
      ? degradedCapability(
          "output-rewrite" as const,
          "optional",
          HOOK_ACTIVATION_UNVERIFIED,
          details.hookSurface,
        )
      : degradedCapability(
          "output-rewrite" as const,
          "optional",
          {
            code: "claude-output-rewrite-version-required",
            message: `Claude Code ${MINIMUM_OUTPUT_REWRITE_VERSION} or newer is required for safe tool-output replacement.`,
            remediation: "Upgrade Claude Code or use Bash-only squeez integration.",
            retryable: false,
          },
          details.hookSurface,
        );
    return [transport, input, output];
  };

  // Reconcile engines and user files as one compensated transaction after all safe preflight checks.
  const reconcile = async (
    context: AdapterContext,
    request: ClaudeInstallRequest,
    installMissing: boolean,
  ): Promise<AdapterOperationResult<ClaudeInstallDetails>> => {
    const packageManager = "npm";
    const probed = await probe(context);
    if (!("details" in probed)) {
      return operationFailure(probed, false, true);
    }
    const { details, settings } = probed;
    const configDirectory = resolveClaudeConfigDirectory(context);
    const knownHooks = managedHooks(configDirectory);
    let originalEnvironment: Readonly<Record<string, string | undefined>>;
    try {
      originalEnvironment = settingsEnvironment(context, settings.document);
      const overlaps = unmanagedSqueezHooks(settings.document, knownHooks);
      if (overlaps.length > 0) {
        return operationFailure(
          failureIssue(
            "claude-unmanaged-squeez-hooks",
            "Existing unmanaged squeez hooks could overlap Szal compression ownership.",
            "Run 'squeez uninstall --host=claude-code', then retry this installation.",
          ),
          false,
          true,
        );
      }
    } catch (error) {
      return operationFailure(issueFromError(error), false, true);
    }

    const engineContext: AdapterContext = { ...context, environment: originalEnvironment };
    const squeezed = inspectSqueez(context, options.squeezRunCommand);
    if (
      request.config.engines.squeez.mode === "enabled" &&
      (squeezed.status === "unavailable" || squeezed.details?.ownershipSafe !== true)
    ) {
      return operationFailure(
        squeezed.status === "unavailable"
          ? squeezed.issue
          : failureIssue("squeez-version-unsafe", "The detected squeez version is not safe."),
        false,
        true,
      );
    }

    let llmtrimDetection = await llmtrim.detect(engineContext);
    let installedLlmtrim = false;
    if (
      llmtrimDetection.status === "unavailable" &&
      request.config.engines.llmtrim.mode === "enabled" &&
      request.config.profile !== "off"
    ) {
      if (!installMissing) {
        return operationFailure(llmtrimDetection.issue, false, true);
      }
      const installation = await llmtrim.install(engineContext, { packageManager });
      if (installation.status !== "succeeded") {
        const partiallyInstalled = installation.status === "failed" && installation.changed;
        const rolledBack = partiallyInstalled
          ? await uninstallNewLlmtrim(context, runCommand, packageManager)
          : installation.status !== "failed" || installation.rolledBack;
        return operationFailure(installation.issue, partiallyInstalled, rolledBack);
      }
      installedLlmtrim = installation.changed;
      llmtrimDetection = await llmtrim.detect(engineContext);
    }

    const failAfterLlmtrimInstall = async (
      issue: AdapterIssue,
    ): Promise<AdapterOperationResult<ClaudeInstallDetails>> => {
      const rolledBack = installedLlmtrim
        ? await uninstallNewLlmtrim(context, runCommand, packageManager)
        : true;
      return operationFailure(issue, installedLlmtrim, rolledBack);
    };

    const baseSqueezState = squeezEngineState(squeezed);
    const squeezeState = deployableSqueezState(
      request.config,
      baseSqueezState,
      details.hookPolicy,
      details.hookSurface,
    );
    const llmtrimState = llmtrimEngineState(llmtrimDetection);
    if (
      request.config.profile !== "off" &&
      request.config.engines.llmtrim.mode === "enabled" &&
      !llmtrimState.available
    ) {
      return failAfterLlmtrimInstall(
        failureIssue(
          "llmtrim-required-unavailable",
          "llmtrim is explicitly enabled but cannot provide recoverable request compression.",
          "Install or upgrade llmtrim to version 0.12.0 or newer.",
        ),
      );
    }
    if (
      request.config.profile !== "off" &&
      request.config.engines.squeez.mode === "enabled" &&
      !squeezeState.available
    ) {
      return failAfterLlmtrimInstall(
        failureIssue(
          "squeez-required-unavailable",
          "squeez is explicitly enabled but Claude cannot run its hooks safely.",
          "Repair Claude hook policy or use automatic/disabled squeez mode.",
        ),
      );
    }
    const ownership = resolveCompressionOwnership(request.config, [llmtrimState, squeezeState]);
    const ownershipError =
      ownership.issues.find((issue) => issue.severity === "error") ??
      assertExplicitOwnersAvailable(request.config, ownership);
    if (ownershipError !== undefined) {
      const issue: AdapterIssue =
        "retryable" in ownershipError
          ? ownershipError
          : failureIssue(ownershipError.code, ownershipError.message);
      return failAfterLlmtrimInstall(issue);
    }

    const features = desiredSqueezFeatures(ownership, details.hookSurface);
    const desiredHooks = desiredHooksForFeatures(knownHooks, features);
    const hookSelection: SqueezHookSelection = {
      postToolUse: desiredHooks.some((registration) => registration.event === "PostToolUse"),
      preToolUse: desiredHooks.some((registration) => registration.event === "PreToolUse"),
    };
    const priorHealth =
      llmtrimDetection.status === "available" ? await llmtrim.health(engineContext) : undefined;
    const priorRequest = readLlmtrimConfigureRequest(originalEnvironment);
    const wantsLlmtrim = ownership.assignments.some(
      (assignment) => assignment.owner === "llmtrim" && assignment.state === "active",
    );
    if (wantsLlmtrim && priorHealth?.details.running === true && priorRequest === undefined) {
      return failAfterLlmtrimInstall(
        failureIssue(
          "llmtrim-unmanaged-daemon",
          "A running llmtrim daemon is not associated with restorable Szal state.",
          "Stop the unmanaged daemon before installing the Claude integration.",
        ),
      );
    }

    let staged: StagedSqueezHooks | undefined;
    if (desiredHooks.length > 0) {
      if (squeezed.status === "unavailable" || squeezed.details === undefined) {
        const issue =
          squeezed.status === "unavailable"
            ? squeezed.issue
            : failureIssue(
                "squeez-detection-incomplete",
                "squeez detection did not return executable details.",
              );
        return failAfterLlmtrimInstall(issue);
      }
      try {
        staged = await (
          options.stageSqueezHooks ??
          ((stageContext, stageDetection, stageSelection) =>
            stageSqueezHooks(stageContext, stageDetection, stageSelection, runCommand))
        )(context, squeezed.details, hookSelection);
      } catch (error) {
        return failAfterLlmtrimInstall(issueFromError(error));
      }
    }

    const state: ReconcileState = {
      installedLlmtrim,
      llmtrimChanged: false,
      originalEnvironment,
      ...(priorRequest === undefined ? {} : { priorLlmtrimRequest: priorRequest }),
      priorLlmtrimRunning: priorHealth?.details.running === true,
    };
    const transactionChanged = (): boolean =>
      installedLlmtrim || state.llmtrimChanged || (state.commit?.changedPaths.length ?? 0) > 0;
    const failAfterRollback = async (
      issue: AdapterIssue,
      changed = transactionChanged(),
    ): Promise<AdapterOperationResult<ClaudeInstallDetails>> => {
      const rolledBack = await rollbackReconcile(
        context,
        state,
        llmtrim,
        runCommand,
        packageManager,
      );
      return operationFailure(
        issueWithBackups(issue, state.commit?.backupPaths ?? []),
        changed,
        rolledBack,
      );
    };

    const configured = await llmtrim.configure(engineContext, {
      enableRecovery: true,
      host: "claude",
      mode: wantsLlmtrim ? "on" : "off",
      preset:
        request.config.profile === "safe"
          ? "safe"
          : request.config.profile === "aggressive"
            ? "aggressive"
            : "auto",
    });
    if (configured.status === "failed") {
      state.llmtrimChanged = configured.changed;
      return failAfterRollback(configured.issue);
    }
    if (configured.status === "skipped") {
      return failAfterRollback(configured.issue);
    }
    state.llmtrimChanged = configured.changed;
    if (configured.details === undefined) {
      return failAfterRollback(
        failureIssue(
          "llmtrim-configuration-incomplete",
          "llmtrim configuration did not return a launch environment.",
        ),
      );
    }
    const transport = configured.details;
    const llmtrimRequiresRestart = configured.requiresRestart === true;
    state.configuredEnvironment = transport.environment;

    const configuredEnvironment = transport.environment;
    const selectedEnvironment = selectLlmtrimManagedEnvironment(configuredEnvironment);
    let patchedSettings: Record<string, unknown>;
    try {
      patchedSettings = patchClaudeSettings(settings.document, {
        desiredHooks,
        environment: selectedEnvironment,
        knownHooks,
        managedEnvironmentKeys: LLMTRIM_PERSISTED_ENVIRONMENT_KEYS,
      });
    } catch (error) {
      return failAfterRollback(issueFromError(error));
    }

    const settingsBehaviorChanged =
      JSON.stringify(settings.document.env) !== JSON.stringify(patchedSettings.env) ||
      JSON.stringify(settings.document.hooks) !== JSON.stringify(patchedSettings.hooks);
    const settingsDocumentChanged =
      JSON.stringify(settings.document) !== JSON.stringify(patchedSettings);
    const serializedSettings = settingsDocumentChanged
      ? serializeClaudeSettings(patchedSettings)
      : settings.serialized;
    const changes: ManagedFile[] = [];
    if (staged !== undefined) {
      const hookDirectory = join(configDirectory, "szal", "hooks");
      if (hookSelection.preToolUse) {
        changes.push({
          contents: staged.preToolUse,
          mode: 0o700,
          ownedPrefix: SQUEEZ_SCRIPT_PREFIX,
          path: join(hookDirectory, "squeez-pretooluse.sh"),
          validate: validateScript,
        });
      }
      if (hookSelection.postToolUse) {
        changes.push({
          contents: staged.postToolUse,
          mode: 0o700,
          ownedPrefix: SQUEEZ_SCRIPT_PREFIX,
          path: join(hookDirectory, "squeez-posttooluse.sh"),
          validate: validateScript,
        });
      }
    }
    if (settings.exists || settingsDocumentChanged) {
      changes.push({
        contents: serializedSettings,
        mode: 0o600,
        path: settings.path,
        validate: validateSettings,
      });
    }

    try {
      state.commit = commitFiles(changes, { now });
      const finalContext = { ...engineContext, environment: configuredEnvironment };
      const verificationIssue = await verifyInstallation(
        settings.path,
        serializedSettings,
        desiredHooks,
        knownHooks,
        llmtrim,
        finalContext,
        transport.compression,
      );
      if (verificationIssue !== undefined) {
        return await failAfterRollback(verificationIssue);
      }

      const settingsChanged = state.commit.changedPaths.includes(settings.path);
      const hooksChanged = state.commit.changedPaths.some((path) => path !== settings.path);
      const changed =
        state.commit.changedPaths.length > 0 || state.llmtrimChanged || installedLlmtrim;
      return {
        changed,
        details: {
          backupPaths: state.commit.backupPaths,
          claude: {
            executablePath: details.executablePath,
            version: details.version,
          },
          llmtrim: {
            compression: transport.compression,
            installation: installedLlmtrim
              ? "installed"
              : llmtrimDetection.status === "available"
                ? "existing"
                : "skipped",
          },
          ownership,
          settings: { changed: settingsChanged, path: settings.path },
          squeez: {
            features,
            state:
              features.length > 0
                ? "configured"
                : squeezed.status === "available"
                  ? "skipped"
                  : "unavailable",
            ...(squeezed.status === "available" && squeezed.details?.version !== undefined
              ? { version: squeezed.details.version }
              : {}),
          },
        },
        requiresRestart: llmtrimRequiresRestart || hooksChanged || settingsBehaviorChanged,
        status: "succeeded",
      };
    } catch (error) {
      if (error instanceof FileTransactionError) {
        const engineRolledBack = await rollbackReconcile(
          context,
          state,
          llmtrim,
          runCommand,
          packageManager,
        );
        return operationFailure(
          issueWithBackups(issueFromError(error), error.backupPaths),
          error.backupPaths.length > 0 || state.llmtrimChanged || installedLlmtrim,
          error.rolledBack && engineRolledBack,
        );
      }
      return failAfterRollback(issueFromError(error));
    }
  };

  return {
    capabilities,
    configure: (context, request) => reconcile(context, request, false),
    descriptor: { id: "claude", kind: "agent", name: "Claude Code" },
    detect,
    disable: () =>
      Promise.resolve({
        changed: false,
        issue: failureIssue(
          "claude-uninstall-not-implemented",
          "Claude integration removal is handled by the uninstall workflow.",
          "Use the Claude uninstall command when issue #12 is available.",
        ),
        status: "skipped",
      }),
    health: async (context) => {
      const result = await probe(context);
      if (!("details" in result)) {
        return { issues: [result], status: "unavailable" };
      }
      const issues: AdapterIssue[] = [];
      if (result.details.hookPolicy.status === "unverified") {
        issues.push(HOOK_ACTIVATION_UNVERIFIED);
      } else {
        issues.push(
          failureIssue(
            result.details.hookPolicy.status === "disabled"
              ? "claude-hooks-disabled"
              : "claude-managed-hooks-only",
            result.details.hookPolicy.status === "disabled"
              ? "Claude Code hooks are disabled."
              : "Claude Code accepts only managed hooks.",
          ),
        );
      }
      return { issues, status: issues.length === 0 ? "healthy" : "degraded" };
    },
    install: (context, request) => reconcile(context, request, true),
    version: async (context) => {
      const result = await probeExecutable(context);
      return "executablePath" in result
        ? { status: "available", version: result.version }
        : { issue: result, status: "unavailable" };
    },
  };
};
