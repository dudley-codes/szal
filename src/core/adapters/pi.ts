import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  commitFileTransaction,
  FileTransactionError,
  type ManagedFile,
} from "../file-transaction.js";
import type { AgentAdapter, AgentCapabilityName } from "./agent.js";
import {
  availableCapability,
  unavailableCapability,
  type AdapterContext,
  type AdapterDetection,
  type AdapterIssue,
  type AdapterOperationResult,
  type AdapterVersion,
  type CapabilityResult,
} from "./shared.js";

const COMMAND_TIMEOUT_MS = 10_000;
export const PI_EXTENSION_OWNERSHIP_MARKER = "// Managed by Szal: Pi global extension v1";
const PI_EXTENSION_OWNERSHIP_PREFIX = Buffer.from(`${PI_EXTENSION_OWNERSHIP_MARKER}\n`);

export interface PiCommandInvocation {
  arguments: readonly string[];
  command: string;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
}

export interface PiCommandResult {
  errorCode?: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export type PiCommandRunner = (invocation: PiCommandInvocation) => Promise<PiCommandResult>;

export interface PiDetectionDetails {
  configDirectory: string;
  executablePath: string;
  extensionDirectory: string;
  extensionPath: string;
  installed: boolean;
  version: string;
}

export interface PiInstallDetails {
  backupPaths: readonly string[];
  extension: {
    changed: boolean;
    path: string;
  };
  pi: {
    configDirectory: string;
    executablePath: string;
    version: string;
  };
}

export interface PiAdapterOptions {
  commitFiles?: typeof commitFileTransaction;
  now?: () => Date;
  readExtensionResource?: () => Buffer;
  runCommand?: PiCommandRunner;
}

export interface PiAdapter extends AgentAdapter<unknown, unknown, PiDetectionDetails> {
  disable: (context: AdapterContext) => Promise<AdapterOperationResult<PiInstallDetails>>;
  install: (
    context: AdapterContext,
    request: unknown,
  ) => Promise<AdapterOperationResult<PiInstallDetails>>;
}

const PI_NOT_FOUND: AdapterIssue = {
  code: "pi-not-found",
  message: "The Pi executable is not installed or is not executable.",
  remediation: "Install Pi and make the pi executable available on PATH.",
  retryable: false,
};

const defaultRunCommand: PiCommandRunner = async (invocation) =>
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
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: invocation.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const nodeError = error as NodeJS.ErrnoException | null;
        resolve({
          ...(nodeError?.code === undefined ? {} : { errorCode: nodeError.code }),
          exitCode:
            typeof nodeError?.code === "number" ? nodeError.code : nodeError === null ? 0 : null,
          stderr,
          stdout,
        });
      },
    );
  });

const failureIssue = (code: string, message: string, remediation?: string): AdapterIssue => ({
  code,
  message,
  ...(remediation === undefined ? {} : { remediation }),
  retryable: false,
});

const issueFromError = (error: unknown): AdapterIssue =>
  failureIssue(
    "pi-installation-error",
    error instanceof Error ? error.message : String(error),
    "Inspect the Pi global extension directory and retry.",
  );

const operationFailure = <Details>(
  issue: AdapterIssue,
  changed: boolean,
  rolledBack: boolean,
): AdapterOperationResult<Details> => ({ changed, issue, rolledBack, status: "failed" });

const pathCandidates = (context: AdapterContext): readonly string[] => {
  const path = context.environment.PATH ?? "";
  return path
    .split(process.platform === "win32" ? ";" : ":")
    .filter((entry) => entry.length > 0)
    .map((directory) => join(directory, process.platform === "win32" ? "pi.cmd" : "pi"));
};

const resolvePiConfigDirectory = (context: AdapterContext): string => {
  const override = context.environment.PI_CODING_AGENT_DIR;
  return override !== undefined && override.length > 0 && isAbsolute(override)
    ? override
    : join(context.homeDirectory, ".pi", "agent");
};

const readDefaultExtensionResource = (): Buffer =>
  readFileSync(new URL("../../../resources/pi/extensions/szal/index.ts", import.meta.url));

const isOwnedExtension = (path: string): boolean => {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return readFileSync(path)
      .subarray(0, PI_EXTENSION_OWNERSHIP_PREFIX.length)
      .equals(PI_EXTENSION_OWNERSHIP_PREFIX);
  } catch {
    return false;
  }
};

const removeDirectoryIfEmpty = (directory: string): void => {
  try {
    if (readdirSync(directory).length === 0) {
      rmdirSync(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

export const createPiAdapter = (options: PiAdapterOptions = {}): PiAdapter => {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const commitFiles = options.commitFiles ?? commitFileTransaction;
  const now = options.now ?? (() => new Date());
  const readExtensionResource = options.readExtensionResource ?? readDefaultExtensionResource;

  const probeExecutable = async (
    context: AdapterContext,
  ): Promise<{ executablePath: string; version: string } | AdapterIssue> => {
    for (const executablePath of pathCandidates(context)) {
      const result = await runCommand({
        arguments: ["--version"],
        command: executablePath,
        environment: context.environment,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode === 0) {
        const version = result.stdout.trim();
        return version.length > 0
          ? { executablePath, version }
          : failureIssue(
              "pi-version-invalid",
              "Pi returned an empty version string.",
              "Verify 'pi --version' before installing the integration.",
            );
      }
      if (result.errorCode !== "ENOENT") {
        return failureIssue(
          "pi-version-failed",
          `Pi version detection failed: ${result.stderr.trim() || result.errorCode || "unknown error"}`,
          "Verify 'pi --version' before installing the integration.",
        );
      }
    }
    return PI_NOT_FOUND;
  };

  const detailsFor = (
    context: AdapterContext,
    executable: { executablePath: string; version: string },
  ): PiDetectionDetails => {
    const configDirectory = resolvePiConfigDirectory(context);
    const extensionDirectory = join(configDirectory, "extensions", "szal");
    const extensionPath = join(extensionDirectory, "index.ts");
    return {
      configDirectory,
      executablePath: executable.executablePath,
      extensionDirectory,
      extensionPath,
      installed: isOwnedExtension(extensionPath),
      version: executable.version,
    };
  };

  const detect = async (context: AdapterContext): Promise<AdapterDetection<PiDetectionDetails>> => {
    const executable = await probeExecutable(context);
    return "executablePath" in executable
      ? { details: detailsFor(context, executable), status: "available" }
      : { issue: executable, status: "unavailable" };
  };

  const install = async (
    context: AdapterContext,
  ): Promise<AdapterOperationResult<PiInstallDetails>> => {
    const detection = await detect(context);
    if (detection.status === "unavailable" || detection.details === undefined) {
      return operationFailure(
        detection.status === "unavailable" ? detection.issue : PI_NOT_FOUND,
        false,
        true,
      );
    }
    const details = detection.details;
    const contents = readExtensionResource();
    if (
      !contents
        .subarray(0, PI_EXTENSION_OWNERSHIP_PREFIX.length)
        .equals(PI_EXTENSION_OWNERSHIP_PREFIX)
    ) {
      return operationFailure(
        failureIssue(
          "pi-extension-resource-unowned",
          "The shipped Pi extension is missing its Szal ownership marker.",
        ),
        false,
        true,
      );
    }
    try {
      mkdirSync(details.extensionDirectory, { mode: 0o700, recursive: true });
      if (!existsSync(details.extensionPath)) {
        writeFileSync(details.extensionPath, contents, { flag: "wx", mode: 0o600 });
        return {
          changed: true,
          details: {
            backupPaths: [],
            extension: { changed: true, path: details.extensionPath },
            pi: {
              configDirectory: details.configDirectory,
              executablePath: details.executablePath,
              version: details.version,
            },
          },
          requiresRestart: true,
          status: "succeeded",
        };
      }
      const change: ManagedFile = {
        contents,
        mode: 0o600,
        ownedPrefix: PI_EXTENSION_OWNERSHIP_PREFIX,
        path: details.extensionPath,
      };
      const commit = commitFiles([change], { now });
      const changed = commit.changedPaths.length > 0;
      return {
        changed,
        details: {
          backupPaths: commit.backupPaths,
          extension: { changed, path: details.extensionPath },
          pi: {
            configDirectory: details.configDirectory,
            executablePath: details.executablePath,
            version: details.version,
          },
        },
        requiresRestart: changed,
        status: "succeeded",
      };
    } catch (error) {
      return operationFailure(
        error instanceof FileTransactionError ? issueFromError(error) : issueFromError(error),
        false,
        error instanceof FileTransactionError ? error.rolledBack : true,
      );
    }
  };

  const disable = async (
    context: AdapterContext,
  ): Promise<AdapterOperationResult<PiInstallDetails>> => {
    const detection = await detect(context);
    if (detection.status === "unavailable" || detection.details === undefined) {
      return operationFailure(
        detection.status === "unavailable" ? detection.issue : PI_NOT_FOUND,
        false,
        true,
      );
    }
    const details = detection.details;
    if (!existsSync(details.extensionPath)) {
      return {
        changed: false,
        details: {
          backupPaths: [],
          extension: { changed: false, path: details.extensionPath },
          pi: {
            configDirectory: details.configDirectory,
            executablePath: details.executablePath,
            version: details.version,
          },
        },
        requiresRestart: false,
        status: "succeeded",
      };
    }
    if (!isOwnedExtension(details.extensionPath)) {
      return operationFailure(
        failureIssue(
          "pi-extension-unowned",
          "Refusing to remove a Pi extension that is not owned by Szal.",
          "Move or remove the existing extension manually before retrying.",
        ),
        false,
        true,
      );
    }
    try {
      rmSync(details.extensionPath, { force: true });
      removeDirectoryIfEmpty(details.extensionDirectory);
      return {
        changed: true,
        details: {
          backupPaths: [],
          extension: { changed: true, path: details.extensionPath },
          pi: {
            configDirectory: details.configDirectory,
            executablePath: details.executablePath,
            version: details.version,
          },
        },
        requiresRestart: true,
        status: "succeeded",
      };
    } catch (error) {
      return operationFailure(issueFromError(error), true, false);
    }
  };

  return {
    capabilities: async (context): Promise<readonly CapabilityResult<AgentCapabilityName>[]> => {
      const detection = await detect(context);
      if (detection.status === "unavailable") {
        return [unavailableCapability("transport-configuration", "required", detection.issue)];
      }
      return [availableCapability("transport-configuration", "required")];
    },
    configure: install,
    descriptor: { id: "pi", kind: "agent", name: "Pi" },
    detect,
    disable,
    health: async (context) => {
      const detection = await detect(context);
      return detection.status === "available"
        ? { issues: [], status: "healthy" }
        : { issues: [detection.issue], status: "unavailable" };
    },
    install,
    version: async (context): Promise<AdapterVersion> => {
      const result = await probeExecutable(context);
      return "executablePath" in result
        ? { status: "available", version: result.version }
        : { issue: result, status: "unavailable" };
    },
  };
};
