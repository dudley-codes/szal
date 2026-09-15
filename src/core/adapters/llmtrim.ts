import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import {
  REQUIRED_PRESERVATION_FIELDS,
  type CompressionCapability,
  type CompressionEngineState,
} from "../compression/index.js";
import type { ContentCategory } from "../config/index.js";
import type { CompressionEngineAdapter } from "./compression-engine.js";
import {
  availableCapability,
  degradedCapability,
  unavailableCapability,
  type AdapterContext,
  type AdapterDetection,
  type AdapterHealth,
  type AdapterIssue,
  type AdapterOperationResult,
  type AdapterVersion,
  type CapabilityResult,
} from "./shared.js";

const LLMTRIM_COMMAND = "llmtrim";
export const LLMTRIM_NPM_PACKAGE = "@llmtrim/cli";
const CLAUDE_API_HOST = "api.anthropic.com";
const SZAL_LLMTRIM_DAEMON_CONFIGURATION = "SZAL_LLMTRIM_DAEMON_CONFIGURATION";
const SZAL_LLMTRIM_ENVIRONMENT_STATE = "SZAL_LLMTRIM_ENVIRONMENT_STATE";
const MINIMUM_RECOVERY_VERSION = [0, 12, 0] as const;
const COMMAND_TIMEOUT_MS = 10_000;
const DAEMON_COMMAND_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const PROXY_ENVIRONMENT_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;
const MANAGED_ENVIRONMENT_KEYS = [
  ...PROXY_ENVIRONMENT_KEYS,
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "LLMTRIM_UPSTREAM_PROXY",
  "LLMTRIM_PRESET",
  "LLMTRIM_FIRST_ARRIVAL_RECALL",
] as const;
export const LLMTRIM_PERSISTED_ENVIRONMENT_KEYS = [
  ...MANAGED_ENVIRONMENT_KEYS,
  SZAL_LLMTRIM_DAEMON_CONFIGURATION,
  SZAL_LLMTRIM_ENVIRONMENT_STATE,
] as const;
const LOOPBACK_BYPASS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fd00::/8",
  "*.local",
] as const;

const NOT_INSTALLED_ISSUE: AdapterIssue = {
  code: "llmtrim-not-installed",
  message: "The llmtrim executable is not available.",
  remediation: "Install @llmtrim/cli or run the llmtrim adapter install operation.",
  retryable: false,
};

const DAEMON_STOPPED_ISSUE: AdapterIssue = {
  code: "llmtrim-daemon-stopped",
  message: "The llmtrim interceptor is installed but not running.",
  remediation: "Run llmtrim start or configure the llmtrim adapter for an enabled transport.",
  retryable: true,
};

const CLAUDE_NO_PROXY_ISSUE: AdapterIssue = {
  code: "llmtrim-no-proxy-conflict",
  message: "The Claude API is excluded from proxy routing by NO_PROXY.",
  remediation: "Remove the Claude API or wildcard entry from NO_PROXY and retry configuration.",
  retryable: false,
};

const UPSTREAM_PROXY_CONFLICT_ISSUE: AdapterIssue = {
  code: "llmtrim-upstream-proxy-conflict",
  message: "The HTTP and HTTPS proxy variables select different upstream proxies.",
  remediation: "Configure the same upstream proxy for HTTP and HTTPS, or use pass-through mode.",
  retryable: false,
};

const recoveryUnsupportedIssue = (version: string): AdapterIssue => ({
  code: "llmtrim-recovery-unsupported",
  message: `llmtrim ${version} does not support recoverable first-arrival shaping.`,
  remediation: "Upgrade llmtrim to version 0.12.0 or newer.",
  retryable: false,
});

export type LlmtrimCapabilityName =
  "pass-through-measurement" | "request-compression" | "request-recovery";

export type LlmtrimPreset = "aggressive" | "auto" | "safe";

const LLMTRIM_OWNED_CATEGORIES = [
  "conversation",
  "code",
  "bash",
  "tests",
  "json",
  "markdown",
  "memory",
  "responses",
] as const satisfies readonly ContentCategory[];

export const LLMTRIM_COMPRESSION_CAPABILITIES: readonly CompressionCapability[] =
  LLMTRIM_OWNED_CATEGORIES.map((category) => ({
    category,
    preserves: REQUIRED_PRESERVATION_FIELDS,
    safety: "lossy-recoverable",
  }));

export interface LlmtrimCommandInvocation {
  arguments: readonly string[];
  command: string;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
}

export interface LlmtrimCommandResult {
  errorCode?: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export type LlmtrimCommandRunner = (
  invocation: LlmtrimCommandInvocation,
) => Promise<LlmtrimCommandResult>;

export interface LlmtrimInstallRequest {
  packageManager: "npm";
}

export interface LlmtrimConfigureRequest {
  enableRecovery: boolean;
  host: "claude";
  mode: "off" | "on";
  preset: LlmtrimPreset;
}

export interface LlmtrimDetectionDetails {
  command: "llmtrim";
  version: string;
}

export interface LlmtrimHealthDetails {
  autostart: boolean;
  binaryVersion?: string;
  caPresent?: boolean;
  daemonVersion?: string;
  environmentPort?: number;
  lastRequestAt?: string;
  pid?: number;
  port?: number;
  portAccepting: boolean;
  requests: number;
  restarts: number;
  running: boolean;
}

export interface LlmtrimHealth extends AdapterHealth {
  details: LlmtrimHealthDetails;
}

export interface LlmtrimTransportConfiguration {
  compression: "enabled" | "pass-through";
  environment: Readonly<Record<string, string>>;
  health: LlmtrimHealth["status"];
  measurementSource: "llmtrim-status" | "szal-pass-through";
  proxyUrl?: string;
  recovery: "disabled" | "enabled" | "unverified";
}

export interface LlmtrimTelemetrySnapshot {
  approximate: boolean;
  capturedAt: string;
  inputTokensAfter: number;
  inputTokensBefore: number;
  lastRequestAt?: string;
  requests: number;
}

export type LlmtrimTelemetryResult =
  | { snapshot: LlmtrimTelemetrySnapshot; status: "available" }
  | { issue: AdapterIssue; status: "unavailable" };

export interface LlmtrimCompressionMeasurement {
  approximate: boolean;
  compressed: boolean;
  inputBytesAfter?: number;
  inputBytesBefore?: number;
  inputTokensAfter?: number;
  inputTokensBefore?: number;
  mode: "off" | "on";
  model?: string;
  provider?: string;
  requestCount: number;
  source: "llmtrim-status" | "szal-pass-through";
}

export interface LlmtrimPassThroughInput {
  model?: string;
  provider?: string;
  rawBytes: number;
  rawInputTokens?: number;
}

export interface LlmtrimRecallReference {
  handle: string;
}

export interface LlmtrimAdapter extends CompressionEngineAdapter<
  LlmtrimInstallRequest,
  LlmtrimConfigureRequest,
  LlmtrimDetectionDetails,
  LlmtrimCapabilityName
> {
  capabilities: (
    context: AdapterContext,
  ) => Promise<readonly CapabilityResult<LlmtrimCapabilityName>[]>;
  configure: (
    context: AdapterContext,
    request: LlmtrimConfigureRequest,
  ) => Promise<AdapterOperationResult<LlmtrimTransportConfiguration>>;
  health: (context: AdapterContext) => Promise<LlmtrimHealth>;
  install: (
    context: AdapterContext,
    request: LlmtrimInstallRequest,
  ) => Promise<AdapterOperationResult<{ version: string }>>;
  readTelemetry: (context: AdapterContext) => Promise<LlmtrimTelemetryResult>;
}

export interface CreateLlmtrimAdapterOptions {
  fileExists?: (path: string) => Promise<boolean>;
  now?: () => Date;
  runCommand?: LlmtrimCommandRunner;
}

type ManagedEnvironmentKey = (typeof MANAGED_ENVIRONMENT_KEYS)[number];

interface LlmtrimEnvironmentState {
  applied: Partial<Record<ManagedEnvironmentKey, string>>;
  values: Partial<Record<ManagedEnvironmentKey, string>>;
  version: 2;
}

interface LlmtrimDaemonConfiguration {
  enableRecovery: boolean;
  pid: number;
  preset: LlmtrimPreset;
  upstreamProxy?: string;
  version: 1;
}

interface ParsedLlmtrimStatus {
  approximate: boolean;
  daemon: {
    autostart: boolean;
    binaryVersion?: string;
    environmentPort?: number;
    health: "degraded" | "healthy" | "stopped";
    pid?: number;
    port?: number;
    portAccepting: boolean;
    restarts: number;
    running: boolean;
    version?: string;
  };
  inputTokensAfter: number;
  inputTokensBefore: number;
  lastRequestAt?: string;
  requests: number;
}

type StatusProbe =
  | { issue: AdapterIssue; status: "unavailable" }
  | { status: "available"; value: ParsedLlmtrimStatus };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegativeNumber = (value: unknown): number | undefined => {
  const number = optionalNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
};

const commandFailureIssue = (operation: string, result: LlmtrimCommandResult): AdapterIssue => ({
  code: `llmtrim-${operation}-failed`,
  message:
    result.exitCode === null
      ? `llmtrim ${operation} could not be executed.`
      : `llmtrim ${operation} exited with code ${String(result.exitCode)}.`,
  remediation: `Run llmtrim doctor, then retry the ${operation} operation.`,
  retryable: true,
});

// Execute without a shell so adapter arguments and inherited credentials are never interpolated.
const defaultRunCommand: LlmtrimCommandRunner = async (invocation) =>
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

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Parse only the stable status fields Szal consumes and ignore additive llmtrim fields.
const parseStatus = (stdout: string): ParsedLlmtrimStatus | undefined => {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || !isRecord(document.daemon) || !isRecord(document.input)) {
    return undefined;
  }

  const daemon = document.daemon;
  const health = daemon.health;
  const requests = nonNegativeNumber(document.requests);
  const inputTokensBefore = nonNegativeNumber(document.input.before);
  const inputTokensAfter = nonNegativeNumber(document.input.after);
  if (
    typeof daemon.running !== "boolean" ||
    typeof daemon.port_accepting !== "boolean" ||
    typeof daemon.autostart !== "boolean" ||
    !["degraded", "healthy", "stopped"].includes(String(health)) ||
    requests === undefined ||
    inputTokensBefore === undefined ||
    inputTokensAfter === undefined
  ) {
    return undefined;
  }

  const port = nonNegativeNumber(daemon.port);
  const pid = nonNegativeNumber(daemon.pid);
  const environmentPort = nonNegativeNumber(daemon.env_port);
  const restarts = nonNegativeNumber(daemon.restarts) ?? 0;
  const binaryVersion = optionalString(daemon.binary_version);
  const version = optionalString(daemon.version);
  const lastRequestAt = optionalString(document.last_request_ts);

  return {
    approximate: document.approximate === true,
    daemon: {
      autostart: daemon.autostart,
      ...(binaryVersion === undefined ? {} : { binaryVersion }),
      ...(environmentPort === undefined ? {} : { environmentPort }),
      health: health as ParsedLlmtrimStatus["daemon"]["health"],
      ...(pid === undefined ? {} : { pid }),
      ...(port === undefined ? {} : { port }),
      portAccepting: daemon.port_accepting,
      restarts,
      running: daemon.running,
      ...(version === undefined ? {} : { version }),
    },
    inputTokensAfter,
    inputTokensBefore,
    ...(lastRequestAt === undefined ? {} : { lastRequestAt }),
    requests,
  };
};

const parseVersion = (stdout: string): string | undefined =>
  /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(stdout.trim())?.[1];

const supportsRecovery = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/u.exec(version);
  if (match === null) {
    return false;
  }
  const current = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const isNewer =
    current[0] > MINIMUM_RECOVERY_VERSION[0] ||
    (current[0] === MINIMUM_RECOVERY_VERSION[0] &&
      (current[1] > MINIMUM_RECOVERY_VERSION[1] ||
        (current[1] === MINIMUM_RECOVERY_VERSION[1] && current[2] > MINIMUM_RECOVERY_VERSION[2])));
  if (isNewer) {
    return true;
  }
  return (
    current[0] === MINIMUM_RECOVERY_VERSION[0] &&
    current[1] === MINIMUM_RECOVERY_VERSION[1] &&
    current[2] === MINIMUM_RECOVERY_VERSION[2] &&
    match[4] === undefined
  );
};

export const llmtrimEngineState = (
  detection: AdapterDetection<LlmtrimDetectionDetails>,
): CompressionEngineState => ({
  available:
    detection.status === "available" && supportsRecovery(detection.details?.version ?? "0.0.0"),
  capabilities: LLMTRIM_COMPRESSION_CAPABILITIES,
  id: "llmtrim",
});

const definedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const environmentEquals = (
  left: Readonly<Record<string, string | undefined>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const normalizedLeft = definedEnvironment(left);
  const leftKeys = Object.keys(normalizedLeft).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && normalizedLeft[key] === right[key])
  );
};

const parseManagedEnvironment = (
  value: unknown,
): Partial<Record<ManagedEnvironmentKey, string>> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const environment: Partial<Record<ManagedEnvironmentKey, string>> = {};
  for (const key of MANAGED_ENVIRONMENT_KEYS) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== "string") {
      return undefined;
    }
    if (typeof entry === "string") {
      environment[key] = entry;
    }
  }
  return environment;
};

const parseEnvironmentState = (value: string | undefined): LlmtrimEnvironmentState | undefined => {
  if (value === undefined) {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.version !== 2) {
    return undefined;
  }
  const applied = parseManagedEnvironment(document.applied);
  const values = parseManagedEnvironment(document.values);
  if (applied === undefined || values === undefined) {
    return undefined;
  }
  return { applied, values, version: 2 };
};

const parseDaemonConfiguration = (
  value: string | undefined,
): LlmtrimDaemonConfiguration | undefined => {
  if (value === undefined) {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(document) ||
    document.version !== 1 ||
    typeof document.enableRecovery !== "boolean" ||
    !Number.isSafeInteger(document.pid) ||
    Number(document.pid) <= 0 ||
    !["aggressive", "auto", "safe"].includes(String(document.preset)) ||
    (document.upstreamProxy !== undefined && typeof document.upstreamProxy !== "string")
  ) {
    return undefined;
  }
  return {
    enableRecovery: document.enableRecovery,
    pid: Number(document.pid),
    preset: document.preset as LlmtrimPreset,
    ...(document.upstreamProxy === undefined ? {} : { upstreamProxy: document.upstreamProxy }),
    version: 1,
  };
};

// Select only values owned by llmtrim/Szal before persisting a launch environment.
export const selectLlmtrimManagedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {};
  for (const key of LLMTRIM_PERSISTED_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
};

// Recover the prior Szal-managed daemon request for transactional compensation.
export const readLlmtrimConfigureRequest = (
  environment: Readonly<Record<string, string | undefined>>,
): LlmtrimConfigureRequest | undefined => {
  const configured = parseDaemonConfiguration(environment[SZAL_LLMTRIM_DAEMON_CONFIGURATION]);
  return configured === undefined
    ? undefined
    : {
        enableRecovery: configured.enableRecovery,
        host: "claude",
        mode: "on",
        preset: configured.preset,
      };
};

const mergeNoProxy = (...values: readonly (string | undefined)[]): string => {
  const entries = new Set(
    values
      .filter((value): value is string => value !== undefined)
      .join(",")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const entry of LOOPBACK_BYPASS) {
    entries.add(entry);
  }
  return [...entries].join(",");
};

const noProxyBypassesClaude = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean =>
  [environment.no_proxy, environment.NO_PROXY]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => value.split(/[,\s]+/u))
    .some((entry) => {
      const normalized = entry.trim().toLowerCase();
      if (normalized === "*") {
        return true;
      }
      const portSeparator = normalized.lastIndexOf(":");
      const hasPort = portSeparator > -1 && /^\d+$/u.test(normalized.slice(portSeparator + 1));
      if (hasPort && normalized.slice(portSeparator + 1) !== "443") {
        return false;
      }
      const rawPattern = hasPort ? normalized.slice(0, portSeparator) : normalized;
      const pattern = rawPattern.endsWith(".") ? rawPattern.slice(0, -1) : rawPattern;
      if (pattern.startsWith("*")) {
        return CLAUDE_API_HOST.endsWith(pattern.slice(1));
      }
      if (pattern.startsWith(".")) {
        return CLAUDE_API_HOST.endsWith(pattern);
      }
      return CLAUDE_API_HOST === pattern || CLAUDE_API_HOST.endsWith(`.${pattern}`);
    });

const caPath = (context: AdapterContext): string =>
  join(context.environment.LLMTRIM_HOME ?? join(context.homeDirectory, ".llmtrim"), "ca.pem");

const contextRoutesToPort = (context: AdapterContext, port: number): boolean => {
  const proxyUrl = `http://127.0.0.1:${String(port)}`;
  const routesProtocol = (keys: readonly ManagedEnvironmentKey[]): boolean => {
    const values = keys
      .map((key) => context.environment[key])
      .filter((value): value is string => value !== undefined);
    return values.length > 0 && values.every((value) => value === proxyUrl);
  };
  return (
    routesProtocol(["HTTPS_PROXY", "https_proxy"]) &&
    routesProtocol(["HTTP_PROXY", "http_proxy"]) &&
    context.environment.NODE_EXTRA_CA_CERTS === caPath(context)
  );
};

const isLlmtrimProxy = (value: string | undefined, knownProxyUrl?: string): boolean =>
  value !== undefined && value === knownProxyUrl;

const looksLikeOfficialLlmtrimProxy = (value: string | undefined): boolean =>
  value !== undefined && /^http:\/\/127\.0\.0\.1:\d+$/u.test(value);

const hasSuspectedLlmtrimProxy = (context: AdapterContext): boolean =>
  PROXY_ENVIRONMENT_KEYS.some((key) => looksLikeOfficialLlmtrimProxy(context.environment[key]));

const externalProxyValues = (context: AdapterContext, knownProxyUrl?: string): Set<string> =>
  new Set(
    PROXY_ENVIRONMENT_KEYS.map((key) => context.environment[key]).filter(
      (value): value is string => value !== undefined && !isLlmtrimProxy(value, knownProxyUrl),
    ),
  );

const hasDistinctExternalProxies = (context: AdapterContext, knownProxyUrl?: string): boolean =>
  externalProxyValues(context, knownProxyUrl).size > 1;

const upstreamProxy = (context: AdapterContext, knownProxyUrl?: string): string | undefined =>
  externalProxyValues(context, knownProxyUrl).values().next().value ??
  context.environment.LLMTRIM_UPSTREAM_PROXY;

const managedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Partial<Record<ManagedEnvironmentKey, string>> => {
  const values: Partial<Record<ManagedEnvironmentKey, string>> = {};
  for (const key of MANAGED_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
};

const captureEnvironmentState = (
  context: AdapterContext,
  knownProxyUrl?: string,
): Partial<Record<ManagedEnvironmentKey, string>> => {
  const current = managedEnvironment(context.environment);
  const existing = parseEnvironmentState(context.environment[SZAL_LLMTRIM_ENVIRONMENT_STATE]);
  if (existing !== undefined) {
    const values = { ...existing.values };
    const upstreamChanged =
      current.LLMTRIM_UPSTREAM_PROXY !== existing.applied.LLMTRIM_UPSTREAM_PROXY;
    if (upstreamChanged) {
      for (const key of PROXY_ENVIRONMENT_KEYS) {
        if (current[key] !== existing.applied[key]) {
          continue;
        }
        const upstream = current.LLMTRIM_UPSTREAM_PROXY;
        if (upstream === undefined) {
          Reflect.deleteProperty(values, key);
        } else {
          values[key] = upstream;
        }
      }
    }
    for (const key of MANAGED_ENVIRONMENT_KEYS) {
      if (current[key] === existing.applied[key]) {
        continue;
      }
      const value = current[key];
      if (value === undefined) {
        Reflect.deleteProperty(values, key);
      } else {
        values[key] = value;
      }
    }
    return values;
  }
  const values = { ...current };
  let ownedProxy = false;
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    if (!isLlmtrimProxy(values[key], knownProxyUrl)) {
      continue;
    }
    ownedProxy = true;
    const upstream = context.environment.LLMTRIM_UPSTREAM_PROXY;
    if (upstream === undefined) {
      Reflect.deleteProperty(values, key);
    } else {
      values[key] = upstream;
    }
  }
  if (ownedProxy && values.NODE_EXTRA_CA_CERTS === caPath(context)) {
    delete values.NODE_EXTRA_CA_CERTS;
  }
  return values;
};

// Build the environment for a new Claude process while retaining a previous proxy as upstream.
const enabledEnvironment = (
  context: AdapterContext,
  request: LlmtrimConfigureRequest,
  proxyUrl: string,
  knownProxyUrl?: string,
  daemonPid?: number,
): Record<string, string> => {
  const environment = definedEnvironment(context.environment);
  const originalEnvironment = captureEnvironmentState(context, knownProxyUrl);
  const upstream = upstreamProxy(context, knownProxyUrl);
  if (upstream === undefined) {
    delete environment.LLMTRIM_UPSTREAM_PROXY;
  } else {
    environment.LLMTRIM_UPSTREAM_PROXY = upstream;
  }
  const noProxy = mergeNoProxy(context.environment.no_proxy, context.environment.NO_PROXY);
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    environment[key] = proxyUrl;
  }
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
  environment.NODE_EXTRA_CA_CERTS = caPath(context);
  environment.NODE_USE_ENV_PROXY = "1";
  environment.LLMTRIM_PRESET = request.preset;
  environment.LLMTRIM_FIRST_ARRIVAL_RECALL = String(request.enableRecovery);
  if (daemonPid === undefined) {
    delete environment.SZAL_LLMTRIM_DAEMON_CONFIGURATION;
  } else {
    environment[SZAL_LLMTRIM_DAEMON_CONFIGURATION] = JSON.stringify({
      enableRecovery: request.enableRecovery,
      pid: daemonPid,
      preset: request.preset,
      ...(upstream === undefined ? {} : { upstreamProxy: upstream }),
      version: 1,
    } satisfies LlmtrimDaemonConfiguration);
  }
  environment[SZAL_LLMTRIM_ENVIRONMENT_STATE] = JSON.stringify({
    applied: managedEnvironment(environment),
    values: originalEnvironment,
    version: 2,
  } satisfies LlmtrimEnvironmentState);
  return environment;
};

// Restore captured managed variables, or remove only proxy values verified as llmtrim-owned.
const passThroughEnvironment = (
  context: AdapterContext,
  knownProxyUrl?: string,
): Record<string, string> => {
  const environment = definedEnvironment(context.environment);
  const state = parseEnvironmentState(environment[SZAL_LLMTRIM_ENVIRONMENT_STATE]);
  if (state !== undefined) {
    const latestExternalValues = captureEnvironmentState(context, knownProxyUrl);
    for (const key of MANAGED_ENVIRONMENT_KEYS) {
      const external = latestExternalValues[key];
      if (external === undefined) {
        Reflect.deleteProperty(environment, key);
      } else {
        environment[key] = external;
      }
    }
    delete environment.SZAL_LLMTRIM_DAEMON_CONFIGURATION;
    delete environment.SZAL_LLMTRIM_ENVIRONMENT_STATE;
    return environment;
  }
  const upstream = environment.LLMTRIM_UPSTREAM_PROXY;
  let ownedProxy = false;
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    if (!isLlmtrimProxy(environment[key], knownProxyUrl)) {
      continue;
    }
    ownedProxy = true;
    if (upstream === undefined) {
      Reflect.deleteProperty(environment, key);
    } else {
      environment[key] = upstream;
    }
  }
  if (ownedProxy) {
    if (environment.NODE_EXTRA_CA_CERTS === caPath(context)) {
      delete environment.NODE_EXTRA_CA_CERTS;
    }
    delete environment.LLMTRIM_FIRST_ARRIVAL_RECALL;
    delete environment.LLMTRIM_PRESET;
  }
  delete environment.SZAL_LLMTRIM_DAEMON_CONFIGURATION;
  delete environment.SZAL_LLMTRIM_ENVIRONMENT_STATE;
  return environment;
};

const healthDetails = (status?: ParsedLlmtrimStatus): LlmtrimHealthDetails => ({
  autostart: status?.daemon.autostart ?? false,
  ...(status?.daemon.binaryVersion === undefined
    ? {}
    : { binaryVersion: status.daemon.binaryVersion }),
  ...(status?.daemon.version === undefined ? {} : { daemonVersion: status.daemon.version }),
  ...(status?.daemon.environmentPort === undefined
    ? {}
    : { environmentPort: status.daemon.environmentPort }),
  ...(status?.lastRequestAt === undefined ? {} : { lastRequestAt: status.lastRequestAt }),
  ...(status?.daemon.pid === undefined ? {} : { pid: status.daemon.pid }),
  ...(status?.daemon.port === undefined ? {} : { port: status.daemon.port }),
  portAccepting: status?.daemon.portAccepting ?? false,
  requests: status?.requests ?? 0,
  restarts: status?.daemon.restarts ?? 0,
  running: status?.daemon.running ?? false,
});

// Translate llmtrim's daemon-wide cumulative counters into an approximate ledger event.
export const diffLlmtrimTelemetry = (
  before: LlmtrimTelemetrySnapshot,
  after: LlmtrimTelemetrySnapshot,
): LlmtrimCompressionMeasurement | undefined => {
  const requestCount = after.requests - before.requests;
  const inputTokensBefore = after.inputTokensBefore - before.inputTokensBefore;
  const inputTokensAfter = after.inputTokensAfter - before.inputTokensAfter;
  if (requestCount <= 0 || inputTokensBefore < 0 || inputTokensAfter < 0) {
    return undefined;
  }
  return {
    approximate: true,
    compressed: inputTokensAfter < inputTokensBefore,
    inputTokensAfter,
    inputTokensBefore,
    mode: "on",
    requestCount,
    source: "llmtrim-status",
  };
};

// Record OFF-mode traffic as byte-identical so measurements never imply active compression.
export const createLlmtrimPassThroughMeasurement = (
  input: LlmtrimPassThroughInput,
): LlmtrimCompressionMeasurement => ({
  approximate: false,
  compressed: false,
  inputBytesAfter: input.rawBytes,
  inputBytesBefore: input.rawBytes,
  ...(input.rawInputTokens === undefined
    ? {}
    : { inputTokensAfter: input.rawInputTokens, inputTokensBefore: input.rawInputTokens }),
  mode: "off",
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.provider === undefined ? {} : { provider: input.provider }),
  requestCount: 1,
  source: "szal-pass-through",
});

// Extract only opaque handles, deduplicated in encounter order, without retaining raw output.
export const extractLlmtrimRecallReferences = (
  content: string,
): readonly LlmtrimRecallReference[] => {
  const handles = new Set<string>();
  for (const match of content.matchAll(
    /^\[llmtrim: full output: llmtrim recall (r_[A-Za-z0-9_-]{43}); if unavailable, re-run the tool\]\r?$/gmu,
  )) {
    const handle = match[1];
    if (handle !== undefined) {
      handles.add(handle);
    }
  }
  return [...handles].map((handle) => ({ handle }));
};

// Create the concrete engine boundary while keeping process execution injectable for contract tests.
export const createLlmtrimAdapter = (options: CreateLlmtrimAdapterOptions = {}): LlmtrimAdapter => {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const fileExists = options.fileExists ?? defaultFileExists;
  const now = options.now ?? (() => new Date());

  const invoke = (
    context: AdapterContext,
    command: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string | undefined>> = context.environment,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<LlmtrimCommandResult> =>
    runCommand({ arguments: arguments_, command, environment, timeoutMs });

  const probeVersion = async (context: AdapterContext): Promise<AdapterVersion> => {
    const result = await invoke(context, LLMTRIM_COMMAND, ["--version"]);
    if (result.errorCode === "ENOENT") {
      return { issue: NOT_INSTALLED_ISSUE, status: "unavailable" };
    }
    if (result.exitCode !== 0) {
      return { issue: commandFailureIssue("version", result), status: "unavailable" };
    }
    const version = parseVersion(result.stdout);
    if (version === undefined) {
      return {
        issue: {
          code: "llmtrim-version-invalid",
          message: "llmtrim returned an unrecognized version string.",
          remediation: "Upgrade llmtrim to a supported release and retry.",
          retryable: false,
        },
        status: "unavailable",
      };
    }
    return { status: "available", version };
  };

  const readStatus = async (context: AdapterContext): Promise<StatusProbe> => {
    const result = await invoke(context, LLMTRIM_COMMAND, ["status", "--json"]);
    if (result.errorCode === "ENOENT") {
      return { issue: NOT_INSTALLED_ISSUE, status: "unavailable" };
    }
    if (result.exitCode !== 0) {
      return { issue: commandFailureIssue("status", result), status: "unavailable" };
    }
    const value = parseStatus(result.stdout);
    if (value === undefined) {
      return {
        issue: {
          code: "llmtrim-status-invalid",
          message: "llmtrim status returned an invalid JSON document.",
          remediation: "Upgrade llmtrim to a supported release and run llmtrim doctor.",
          retryable: false,
        },
        status: "unavailable",
      };
    }
    return { status: "available", value };
  };

  const health = async (context: AdapterContext): Promise<LlmtrimHealth> => {
    const probe = await readStatus(context);
    if (probe.status === "unavailable") {
      return {
        details: healthDetails(),
        issues: [probe.issue],
        status: probe.issue.code === "llmtrim-not-installed" ? "unavailable" : "failed",
      };
    }

    const details = healthDetails(probe.value);
    if (!probe.value.daemon.running) {
      return { details, issues: [DAEMON_STOPPED_ISSUE], status: "unavailable" };
    }
    if (
      probe.value.daemon.version !== undefined &&
      probe.value.daemon.binaryVersion !== undefined &&
      probe.value.daemon.version !== probe.value.daemon.binaryVersion
    ) {
      return {
        details,
        issues: [
          {
            code: "llmtrim-version-skew",
            message: "The running llmtrim daemon does not match the installed binary version.",
            remediation: "Run llmtrim start --force to restart the daemon.",
            retryable: true,
          },
        ],
        status: "degraded",
      };
    }
    if (noProxyBypassesClaude(context.environment)) {
      return { details, issues: [CLAUDE_NO_PROXY_ISSUE], status: "degraded" };
    }
    const knownProxyUrl =
      details.port === undefined ? undefined : `http://127.0.0.1:${String(details.port)}`;
    if (hasDistinctExternalProxies(context, knownProxyUrl)) {
      return { details, issues: [UPSTREAM_PROXY_CONFLICT_ISSUE], status: "degraded" };
    }
    if (probe.value.daemon.health !== "healthy") {
      const caPresent = await fileExists(caPath(context));
      if (
        details.pid !== undefined &&
        details.pid > 0 &&
        details.portAccepting &&
        details.port !== undefined &&
        caPresent &&
        contextRoutesToPort(context, details.port)
      ) {
        return { details: { ...details, caPresent }, issues: [], status: "healthy" };
      }
      return {
        details: { ...details, caPresent },
        issues: [
          {
            code: "llmtrim-unhealthy",
            message: "The llmtrim interceptor health chain is degraded.",
            remediation: "Run llmtrim doctor, then retry configuration.",
            retryable: true,
          },
        ],
        status: "degraded",
      };
    }
    if (details.port === undefined || !contextRoutesToPort(context, details.port)) {
      return {
        details: { ...details, caPresent: true },
        issues: [
          {
            code: "llmtrim-transport-unconfigured",
            message:
              "The Claude environment does not route HTTP and HTTPS traffic through llmtrim.",
            remediation: "Configure the Claude transport through the llmtrim adapter.",
            retryable: true,
          },
        ],
        status: "degraded",
      };
    }
    return { details: { ...details, caPresent: true }, issues: [], status: "healthy" };
  };

  const detect = async (
    context: AdapterContext,
  ): Promise<AdapterDetection<LlmtrimDetectionDetails>> => {
    const result = await probeVersion(context);
    return result.status === "available"
      ? {
          details: { command: LLMTRIM_COMMAND, version: result.version },
          status: "available",
        }
      : result;
  };

  const capabilities = async (
    context: AdapterContext,
  ): Promise<readonly CapabilityResult<LlmtrimCapabilityName>[]> => {
    const detection = await detect(context);
    if (detection.status === "unavailable") {
      return [
        unavailableCapability("request-compression", "required", detection.issue),
        unavailableCapability("request-recovery", "optional", detection.issue),
        availableCapability("pass-through-measurement", "required"),
      ];
    }

    const currentHealth = await health(context);
    const compression =
      currentHealth.status === "healthy"
        ? availableCapability("request-compression" as const, "required")
        : currentHealth.status === "degraded"
          ? degradedCapability(
              "request-compression" as const,
              "required",
              currentHealth.issues[0] ?? {
                code: "llmtrim-unhealthy",
                message: "The llmtrim interceptor health chain is degraded.",
                retryable: true,
              },
            )
          : unavailableCapability(
              "request-compression" as const,
              "required",
              currentHealth.issues[0] ?? DAEMON_STOPPED_ISSUE,
            );
    const configured = parseDaemonConfiguration(
      context.environment[SZAL_LLMTRIM_DAEMON_CONFIGURATION],
    );
    const recoveryVerified =
      configured !== undefined && configured.pid === currentHealth.details.pid
        ? configured.enableRecovery
        : undefined;
    const recoveryVersion =
      currentHealth.details.daemonVersion ??
      currentHealth.details.binaryVersion ??
      detection.details?.version ??
      "unknown";
    const recovery = !supportsRecovery(recoveryVersion)
      ? unavailableCapability(
          "request-recovery" as const,
          "optional",
          recoveryUnsupportedIssue(recoveryVersion),
        )
      : currentHealth.status !== "healthy"
        ? unavailableCapability(
            "request-recovery" as const,
            "optional",
            currentHealth.issues[0] ?? DAEMON_STOPPED_ISSUE,
          )
        : recoveryVerified === true
          ? availableCapability("request-recovery" as const, "optional")
          : degradedCapability("request-recovery" as const, "optional", {
              code:
                recoveryVerified === false
                  ? "llmtrim-recovery-disabled"
                  : "llmtrim-recovery-unverified",
              message:
                recoveryVerified === false
                  ? "Recoverable first-arrival shaping is disabled."
                  : "The running daemon does not expose whether request recovery is enabled.",
              remediation:
                recoveryVerified === false
                  ? "Configure the Claude transport with enableRecovery set to true."
                  : "Restart the daemon through the adapter to verify request recovery.",
              retryable: false,
            });
    return [compression, recovery, availableCapability("pass-through-measurement", "required")];
  };

  const install = async (
    context: AdapterContext,
    request: LlmtrimInstallRequest,
  ): Promise<AdapterOperationResult<{ version: string }>> => {
    const existing = await probeVersion(context);
    if (existing.status === "available") {
      return {
        changed: false,
        details: { version: existing.version },
        requiresRestart: false,
        status: "succeeded",
      };
    }
    if (existing.issue.code !== "llmtrim-not-installed") {
      return { changed: false, issue: existing.issue, rolledBack: true, status: "failed" };
    }

    const command = request.packageManager;
    const result = await invoke(
      context,
      command,
      ["install", "--global", `${LLMTRIM_NPM_PACKAGE}@latest`],
      context.environment,
      INSTALL_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return {
        changed: true,
        issue: commandFailureIssue("install", result),
        rolledBack: false,
        status: "failed",
      };
    }
    const installed = await probeVersion(context);
    if (installed.status === "unavailable") {
      return { changed: true, issue: installed.issue, rolledBack: false, status: "failed" };
    }
    return {
      changed: true,
      details: { version: installed.version },
      requiresRestart: false,
      status: "succeeded",
    };
  };

  const configure = async (
    context: AdapterContext,
    request: LlmtrimConfigureRequest,
  ): Promise<AdapterOperationResult<LlmtrimTransportConfiguration>> => {
    const encodedState = context.environment[SZAL_LLMTRIM_ENVIRONMENT_STATE];
    if (encodedState !== undefined && parseEnvironmentState(encodedState) === undefined) {
      return {
        changed: false,
        issue: {
          code: "llmtrim-environment-state-invalid",
          message: "The saved pre-llmtrim environment cannot be restored safely.",
          remediation: "Remove the invalid Szal llmtrim environment state and configure again.",
          retryable: false,
        },
        rolledBack: true,
        status: "failed",
      };
    }
    if (request.mode === "off") {
      let knownProxyUrl: string | undefined;
      if (encodedState === undefined && hasSuspectedLlmtrimProxy(context)) {
        const probe = await readStatus(context);
        if (
          probe.status === "unavailable" ||
          !probe.value.daemon.running ||
          probe.value.daemon.pid === undefined ||
          probe.value.daemon.pid <= 0 ||
          probe.value.daemon.port === undefined
        ) {
          return {
            changed: false,
            issue: {
              code: "llmtrim-off-proxy-unverified",
              message: "The active local proxy cannot be verified as the llmtrim daemon.",
              remediation: "Run llmtrim doctor, then retry OFF mode.",
              retryable: true,
            },
            rolledBack: true,
            status: "failed",
          };
        }
        knownProxyUrl = `http://127.0.0.1:${String(probe.value.daemon.port)}`;
      }
      const environment = passThroughEnvironment(context, knownProxyUrl);
      const changed = !environmentEquals(context.environment, environment);
      return {
        changed,
        details: {
          compression: "pass-through",
          environment,
          health: "healthy",
          measurementSource: "szal-pass-through",
          recovery: "disabled",
        },
        requiresRestart: changed,
        status: "succeeded",
      };
    }
    if (noProxyBypassesClaude(context.environment)) {
      return {
        changed: false,
        issue: CLAUDE_NO_PROXY_ISSUE,
        rolledBack: true,
        status: "failed",
      };
    }

    const detection = await detect(context);
    if (detection.status === "unavailable") {
      return { changed: false, issue: detection.issue, status: "skipped" };
    }

    let currentHealth = await health(context);
    const knownProxyPort = currentHealth.details.port ?? currentHealth.details.environmentPort;
    const knownProxyUrl =
      knownProxyPort === undefined ? undefined : `http://127.0.0.1:${String(knownProxyPort)}`;
    if (hasDistinctExternalProxies(context, knownProxyUrl)) {
      return {
        changed: false,
        issue: UPSTREAM_PROXY_CONFLICT_ISSUE,
        rolledBack: true,
        status: "failed",
      };
    }
    const upstream = upstreamProxy(context, knownProxyUrl);
    const configured = parseDaemonConfiguration(
      context.environment[SZAL_LLMTRIM_DAEMON_CONFIGURATION],
    );
    const daemonConfigurationMatches =
      currentHealth.status === "healthy" &&
      currentHealth.details.pid !== undefined &&
      configured?.pid === currentHealth.details.pid &&
      configured.preset === request.preset &&
      configured.enableRecovery === request.enableRecovery &&
      configured.upstreamProxy === upstream;
    let started = false;
    if (!daemonConfigurationMatches) {
      const canStart =
        currentHealth.status === "unavailable" &&
        currentHealth.issues.some(({ code }) => code === "llmtrim-daemon-stopped");
      if (!canStart && !currentHealth.details.running) {
        return {
          changed: false,
          issue: currentHealth.issues[0] ?? {
            code: "llmtrim-unhealthy",
            message: "llmtrim could not verify a running interceptor before configuration.",
            remediation: "Run llmtrim doctor and retry configuration.",
            retryable: true,
          },
          rolledBack: true,
          status: "failed",
        };
      }
      const startEnvironment = enabledEnvironment(context, request, "", knownProxyUrl);
      for (const key of PROXY_ENVIRONMENT_KEYS) {
        Reflect.deleteProperty(startEnvironment, key);
      }
      delete startEnvironment.NODE_EXTRA_CA_CERTS;
      delete startEnvironment.SZAL_LLMTRIM_DAEMON_CONFIGURATION;
      delete startEnvironment.SZAL_LLMTRIM_ENVIRONMENT_STATE;
      const start = await invoke(
        context,
        LLMTRIM_COMMAND,
        ["start", "--force"],
        startEnvironment,
        DAEMON_COMMAND_TIMEOUT_MS,
      );
      if (start.exitCode !== 0) {
        return {
          changed: true,
          issue: commandFailureIssue("start", start),
          rolledBack: false,
          status: "failed",
        };
      }
      started = true;
      currentHealth = await health(context);
    }

    if (
      currentHealth.status !== "healthy" &&
      currentHealth.details.running &&
      currentHealth.details.portAccepting &&
      currentHealth.details.port !== undefined
    ) {
      const environment = enabledEnvironment(
        context,
        request,
        `http://127.0.0.1:${String(currentHealth.details.port)}`,
        knownProxyUrl,
        currentHealth.details.pid,
      );
      currentHealth = await health({ ...context, environment });
    }

    if (currentHealth.status !== "healthy" || currentHealth.details.port === undefined) {
      return {
        changed: started,
        issue: currentHealth.issues[0] ?? {
          code: "llmtrim-unhealthy",
          message: "llmtrim could not verify a healthy interceptor after configuration.",
          remediation: "Run llmtrim doctor and retry configuration.",
          retryable: true,
        },
        rolledBack: !started,
        status: "failed",
      };
    }

    const proxyUrl = `http://127.0.0.1:${String(currentHealth.details.port)}`;
    const environment = enabledEnvironment(
      context,
      request,
      proxyUrl,
      knownProxyUrl,
      currentHealth.details.pid,
    );
    const changed = started || !environmentEquals(context.environment, environment);
    const outputConfiguration = parseDaemonConfiguration(
      environment[SZAL_LLMTRIM_DAEMON_CONFIGURATION],
    );
    const recoveryVersion =
      currentHealth.details.daemonVersion ??
      currentHealth.details.binaryVersion ??
      detection.details?.version ??
      "unknown";
    const recoveryVerified =
      supportsRecovery(recoveryVersion) &&
      currentHealth.details.pid !== undefined &&
      outputConfiguration?.pid === currentHealth.details.pid &&
      outputConfiguration.enableRecovery === request.enableRecovery;
    return {
      changed,
      details: {
        compression: "enabled",
        environment,
        health: currentHealth.status,
        measurementSource: "llmtrim-status",
        proxyUrl,
        recovery: request.enableRecovery
          ? recoveryVerified
            ? "enabled"
            : "unverified"
          : "disabled",
      },
      requiresRestart: !environmentEquals(context.environment, environment),
      status: "succeeded",
    };
  };

  const disable = async (context: AdapterContext): Promise<AdapterOperationResult> => {
    const before = await health(context);
    const wasStopped =
      !before.details.running &&
      before.issues.some(({ code }) => code === DAEMON_STOPPED_ISSUE.code);
    if (wasStopped) {
      return { changed: false, requiresRestart: false, status: "succeeded" };
    }
    const result = await invoke(
      context,
      LLMTRIM_COMMAND,
      ["stop"],
      context.environment,
      DAEMON_COMMAND_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return {
        changed: false,
        issue: commandFailureIssue("stop", result),
        rolledBack: true,
        status: "failed",
      };
    }
    const after = await health(context);
    const stopped =
      !after.details.running && after.issues.some(({ code }) => code === DAEMON_STOPPED_ISSUE.code);
    if (!stopped) {
      return {
        changed: true,
        issue: {
          code: "llmtrim-stop-unverified",
          message: "llmtrim stop completed but daemon inactivity could not be verified.",
          remediation: "Run llmtrim status and stop the interceptor manually if it is active.",
          retryable: true,
        },
        rolledBack: false,
        status: "failed",
      };
    }
    return { changed: true, requiresRestart: true, status: "succeeded" };
  };

  const readTelemetry = async (context: AdapterContext): Promise<LlmtrimTelemetryResult> => {
    const probe = await readStatus(context);
    if (probe.status === "unavailable") {
      return probe;
    }
    return {
      snapshot: {
        approximate: probe.value.approximate,
        capturedAt: now().toISOString(),
        inputTokensAfter: probe.value.inputTokensAfter,
        inputTokensBefore: probe.value.inputTokensBefore,
        ...(probe.value.lastRequestAt === undefined
          ? {}
          : { lastRequestAt: probe.value.lastRequestAt }),
        requests: probe.value.requests,
      },
      status: "available",
    };
  };

  return {
    capabilities,
    configure,
    descriptor: { id: "llmtrim", kind: "compression-engine", name: "llmtrim" },
    detect,
    disable,
    health,
    install,
    readTelemetry,
    version: probeVersion,
  };
};
