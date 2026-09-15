import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  assertSafeJsonValue as assertSafeSharedJsonValue,
  cloneJson,
  isJsonRecord as isRecord,
  isUnsafeJsonKey,
} from "../json.js";

import { resolveConfigPaths, type ConfigPaths } from "./paths.js";
import {
  COMPRESSION_OWNERS,
  COMPRESSION_PROFILES,
  CONTENT_CATEGORIES,
  DEFAULT_CONFIG,
  ENGINE_MODES,
  type LoadedConfig,
  type SzalConfig,
} from "./types.js";

export class ConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export interface ConfigStoreOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  paths?: ConfigPaths;
}

// Wrap shared JSON safety failures in the configuration domain error consumed by the CLI.
const assertSafeJsonValue = (value: unknown, path: string): void => {
  assertSafeSharedJsonValue(value, path, (message) => new ConfigError(message));
};

// Merge object-shaped defaults recursively while retaining forward-compatible unknown fields.
const mergeConfigValues = (defaults: unknown, configured: unknown): unknown => {
  if (!isRecord(defaults) || !isRecord(configured)) {
    return cloneJson(configured);
  }

  const merged: Record<string, unknown> = cloneJson(defaults);
  for (const [key, value] of Object.entries(configured)) {
    merged[key] = key in defaults ? mergeConfigValues(defaults[key], value) : cloneJson(value);
  }
  return merged;
};

const assertRecord: (value: unknown, path: string) => asserts value is Record<string, unknown> = (
  value,
  path,
) => {
  if (!isRecord(value)) {
    throw new ConfigError(`${path} must be an object.`);
  }
};

const assertBoolean = (value: unknown, path: string): void => {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean.`);
  }
};

const assertInteger = (value: unknown, path: string, allowZero: boolean): void => {
  const minimumDescription = allowZero ? "a non-negative integer" : "a positive integer";
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ConfigError(`${path} must be ${minimumDescription}.`);
  }
};

const assertEnum = (value: unknown, path: string, allowed: readonly string[]): void => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigError(
      `${path} must be one of: ${allowed.join(", ")}. Received ${JSON.stringify(value)}.`,
    );
  }
};

// Validate every supported field while allowing unknown JSON fields for forward compatibility.
export const validateConfig: (value: unknown) => asserts value is SzalConfig = (value) => {
  assertSafeJsonValue(value, "configuration");
  assertRecord(value, "configuration");

  if (value.schemaVersion !== 1) {
    throw new ConfigError(
      `schemaVersion must be 1. Received ${JSON.stringify(value.schemaVersion)}.`,
    );
  }
  assertEnum(value.profile, "profile", COMPRESSION_PROFILES);

  assertRecord(value.engines, "engines");
  for (const engineName of ["llmtrim", "squeez"] as const) {
    const engine = value.engines[engineName];
    assertRecord(engine, `engines.${engineName}`);
    assertEnum(engine.mode, `engines.${engineName}.mode`, ENGINE_MODES);
  }

  assertRecord(value.ownership, "ownership");
  for (const category of CONTENT_CATEGORIES) {
    assertEnum(value.ownership[category], `ownership.${category}`, COMPRESSION_OWNERS);
  }

  assertRecord(value.retention, "retention");
  assertInteger(value.retention.telemetryDays, "retention.telemetryDays", true);
  assertInteger(value.retention.coldStorageDays, "retention.coldStorageDays", true);

  assertRecord(value.stats, "stats");
  assertBoolean(value.stats.enabled, "stats.enabled");

  assertRecord(value.memory, "memory");
  assertBoolean(value.memory.enabled, "memory.enabled");
  assertInteger(value.memory.maxItems, "memory.maxItems", false);

  assertRecord(value.coldStorage, "coldStorage");
  assertBoolean(value.coldStorage.enabled, "coldStorage.enabled");
  assertInteger(value.coldStorage.maxBytes, "coldStorage.maxBytes", false);

  assertRecord(value.modelWindows, "modelWindows");
  for (const [model, tokenCount] of Object.entries(value.modelWindows)) {
    assertInteger(tokenCount, `modelWindows.${model}`, false);
  }
};

const resolvePaths = (options: ConfigStoreOptions): ConfigPaths =>
  options.paths ??
  resolveConfigPaths(options.environment ?? process.env, options.homeDirectory ?? homedir());

// Load a partial user configuration over defaults without creating any files as a side effect.
export const loadConfig = (options: ConfigStoreOptions = {}): LoadedConfig => {
  const paths = resolvePaths(options);
  if (!existsSync(paths.configPath)) {
    return { config: cloneJson(DEFAULT_CONFIG), exists: false, path: paths.configPath };
  }

  let contents: string;
  try {
    contents = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Could not read configuration at ${paths.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let configured: unknown;
  try {
    configured = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new ConfigError(
      `Could not parse configuration at ${paths.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    assertSafeJsonValue(configured, "configuration");
    assertRecord(configured, "configuration");
    const merged = mergeConfigValues(DEFAULT_CONFIG, configured);
    validateConfig(merged);
    return { config: merged, exists: true, path: paths.configPath };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`Invalid configuration at ${paths.configPath}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
};

// Replace a file through a same-directory rename so readers never observe partial JSON.
const writeAtomicFile = (path: string, contents: string): void => {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

// Validate first, back up the prior bytes, then atomically replace the global config file.
export const writeConfig = (config: SzalConfig, options: ConfigStoreOptions = {}): void => {
  validateConfig(config);
  const paths = resolvePaths(options);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  mkdirSync(paths.configDirectory, { mode: 0o700, recursive: true });
  chmodSync(paths.configDirectory, 0o700);
  if (existsSync(paths.configPath)) {
    writeAtomicFile(paths.backupPath, readFileSync(paths.configPath, "utf8"));
  }
  writeAtomicFile(paths.configPath, serialized);
};

const splitConfigPath = (path: string): string[] => {
  if (path.startsWith("modelWindows.")) {
    return ["modelWindows", path.slice("modelWindows.".length)];
  }
  return path.split(".");
};

const assertSafePath = (path: string): string[] => {
  const segments = splitConfigPath(path);
  if (segments.some((segment) => segment.length === 0 || isUnsafeJsonKey(segment))) {
    throw new ConfigError(`Invalid configuration path: ${path}.`);
  }
  return segments;
};

// Read one dotted path, treating everything after modelWindows as a literal model identifier.
export const getConfigValue = (config: SzalConfig, path: string): unknown => {
  const segments = assertSafePath(path);
  let current: unknown = config;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new ConfigError(`Unknown configuration path: ${path}.`);
    }
    current = current[segment];
  }
  return cloneJson(current);
};

// Update one known path and validate the complete result before it can be persisted.
export const setConfigValue = (config: SzalConfig, path: string, value: unknown): SzalConfig => {
  const segments = assertSafePath(path);
  const updated = cloneJson(config);
  let parent: Record<string, unknown> = updated;

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (isLast) {
      const isModelOverride = segments[0] === "modelWindows" && segments.length === 2;
      if (!isModelOverride && !Object.hasOwn(parent, segment)) {
        throw new ConfigError(`Unknown configuration path: ${path}.`);
      }
      parent[segment] = cloneJson(value);
      break;
    }

    const child = parent[segment];
    if (!isRecord(child)) {
      throw new ConfigError(`Unknown configuration path: ${path}.`);
    }
    parent = child;
  }

  validateConfig(updated);
  return updated;
};
