import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  assertSafeJsonValue as assertSafeSharedJsonValue,
  cloneJson,
  isJsonRecord,
} from "../json.js";
import type { AdapterContext } from "./shared.js";

export type ClaudeHookEvent = "PostToolUse" | "PreToolUse";

export interface ClaudeCommandHook {
  args?: readonly string[];
  command: string;
  timeout?: number;
  type: "command";
}

export interface ClaudeHookRegistration {
  event: ClaudeHookEvent;
  handler: ClaudeCommandHook;
  matcher: string;
}

export interface LoadedClaudeSettings {
  document: Record<string, unknown>;
  exists: boolean;
  path: string;
  serialized: Buffer;
}

export interface ClaudeSettingsPatch {
  desiredHooks: readonly ClaudeHookRegistration[];
  environment: Readonly<Record<string, string | undefined>>;
  knownHooks: readonly ClaudeHookRegistration[];
  managedEnvironmentKeys: readonly string[];
}

export class ClaudeSettingsError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeSettingsError";
  }
}

// Wrap shared JSON safety failures in the Claude settings domain error.
const assertSafeJsonValue = (value: unknown, path: string): void => {
  assertSafeSharedJsonValue(
    value,
    path,
    (message) => new ClaudeSettingsError(message.replace("configuration field", "settings field")),
  );
};

// Honor Claude's absolute configuration override without allowing relative paths to escape context.
export const resolveClaudeConfigDirectory = (context: AdapterContext): string => {
  const configured = context.environment.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && isAbsolute(configured)) {
    return configured;
  }
  if (!isAbsolute(context.homeDirectory)) {
    throw new ClaudeSettingsError("The home directory must be an absolute path.");
  }
  return join(context.homeDirectory, ".claude");
};

export const resolveClaudeSettingsPath = (context: AdapterContext): string =>
  join(resolveClaudeConfigDirectory(context), "settings.json");

// Parse settings without creating files and preserve the exact original bytes for transactions.
export const loadClaudeSettings = (path: string): LoadedClaudeSettings => {
  const exists = existsSync(path);
  const serialized = exists ? readFileSync(path) : Buffer.alloc(0);
  if (!exists) {
    return { document: {}, exists, path, serialized };
  }

  let document: unknown;
  try {
    document = JSON.parse(serialized.toString("utf8")) as unknown;
  } catch (error) {
    throw new ClaudeSettingsError(
      `Could not parse Claude settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assertSafeJsonValue(document, "Claude settings");
  if (!isJsonRecord(document)) {
    throw new ClaudeSettingsError(`Claude settings at ${path} must contain a JSON object.`);
  }
  return { document, exists, path, serialized };
};

// Return only string-valued launch environment entries because Claude settings env is string-only.
export const readClaudeSettingsEnvironment = (
  document: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> => {
  const configured = document.env;
  if (configured === undefined) {
    return {};
  }
  if (!isJsonRecord(configured)) {
    throw new ClaudeSettingsError("Claude settings env must be an object.");
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value !== "string") {
      throw new ClaudeSettingsError(`Claude settings env.${key} must be a string.`);
    }
    environment[key] = value;
  }
  return environment;
};

const stringArrayEquals = (left: unknown, right: readonly string[] | undefined): boolean => {
  if (right === undefined) {
    return left === undefined;
  }
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((entry, index) => typeof entry === "string" && entry === right[index])
  );
};

export const claudeHookRegistrationEquals = (
  left: ClaudeHookRegistration,
  right: ClaudeHookRegistration,
): boolean =>
  left.event === right.event &&
  left.matcher === right.matcher &&
  left.handler.command === right.handler.command &&
  stringArrayEquals(left.handler.args, right.handler.args);

const isCommandHook = (
  value: unknown,
): value is Record<string, unknown> & { command: string; type: "command" } =>
  isJsonRecord(value) && value.type === "command" && typeof value.command === "string";

const matchesRegistration = (
  event: ClaudeHookEvent,
  matcher: string,
  handler: unknown,
  registration: ClaudeHookRegistration,
): boolean =>
  event === registration.event &&
  matcher === registration.matcher &&
  isCommandHook(handler) &&
  handler.command === registration.handler.command &&
  stringArrayEquals(handler.args, registration.handler.args);

interface ParsedHookGroup {
  group: Record<string, unknown>;
  handlers: readonly unknown[];
  matcher: string;
}

const parseHookGroup = (value: unknown, event: ClaudeHookEvent, index: number): ParsedHookGroup => {
  if (!isJsonRecord(value)) {
    throw new ClaudeSettingsError(
      `Claude settings hooks.${event}[${String(index)}] must be an object.`,
    );
  }
  if (value.matcher !== undefined && typeof value.matcher !== "string") {
    throw new ClaudeSettingsError(
      `Claude settings hooks.${event}[${String(index)}].matcher must be a string when present.`,
    );
  }
  if (!Array.isArray(value.hooks)) {
    throw new ClaudeSettingsError(
      `Claude settings hooks.${event}[${String(index)}].hooks must be an array.`,
    );
  }
  return { group: value, handlers: value.hooks, matcher: value.matcher ?? "" };
};

const eventGroups = (
  hooks: Readonly<Record<string, unknown>>,
  event: ClaudeHookEvent,
): readonly unknown[] => {
  const value = hooks[event];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ClaudeSettingsError(`Claude settings hooks.${event} must be an array.`);
  }
  return value;
};

// Enumerate command hooks structurally so callers can detect overlap without substring mutation.
export const listClaudeCommandHooks = (
  document: Readonly<Record<string, unknown>>,
): readonly ClaudeHookRegistration[] => {
  const configured = document.hooks;
  if (configured === undefined) {
    return [];
  }
  if (!isJsonRecord(configured)) {
    throw new ClaudeSettingsError("Claude settings hooks must be an object.");
  }

  const registrations: ClaudeHookRegistration[] = [];
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    for (const [index, value] of eventGroups(configured, event).entries()) {
      const parsed = parseHookGroup(value, event, index);
      for (const handler of parsed.handlers) {
        if (!isCommandHook(handler)) {
          continue;
        }
        if (
          handler.args !== undefined &&
          (!Array.isArray(handler.args) ||
            !handler.args.every((entry) => typeof entry === "string"))
        ) {
          throw new ClaudeSettingsError(
            `Claude settings hooks.${event}[${String(index)}] contains command args that are not strings.`,
          );
        }
        const args = handler.args === undefined ? undefined : (handler.args as readonly string[]);
        registrations.push({
          event,
          handler: {
            ...(args === undefined ? {} : { args }),
            command: handler.command,
            ...(typeof handler.timeout === "number" ? { timeout: handler.timeout } : {}),
            type: "command",
          },
          matcher: parsed.matcher,
        });
      }
    }
  }
  return registrations;
};

type MutableHookGroup = Record<string, unknown> & { hooks: readonly unknown[] };

// Replace only exact managed handlers while preserving foreign handlers and additive group fields.
const reconcileHookEvent = (
  hooks: Record<string, unknown>,
  event: ClaudeHookEvent,
  knownHooks: readonly ClaudeHookRegistration[],
  desiredHooks: readonly ClaudeHookRegistration[],
): void => {
  const existing = eventGroups(hooks, event);
  const groups: MutableHookGroup[] = [];

  for (const [index, value] of existing.entries()) {
    const parsed = parseHookGroup(value, event, index);
    const retained = parsed.handlers.filter(
      (handler) =>
        !knownHooks.some((registration) =>
          matchesRegistration(event, parsed.matcher, handler, registration),
        ),
    );
    const onlyStructuralFields = Object.keys(parsed.group).every(
      (key) => key === "hooks" || key === "matcher",
    );
    if (retained.length > 0 || !onlyStructuralFields) {
      groups.push({ ...parsed.group, hooks: retained });
    }
  }

  for (const registration of desiredHooks.filter((candidate) => candidate.event === event)) {
    const group = groups.find((candidate) => candidate.matcher === registration.matcher);
    const handler = cloneJson(registration.handler) as unknown as Record<string, unknown>;
    if (group === undefined) {
      groups.push({ hooks: [handler], matcher: registration.matcher });
      continue;
    }
    group.hooks = [...group.hooks, handler];
  }

  if (groups.length === 0) {
    Reflect.deleteProperty(hooks, event);
  } else {
    hooks[event] = groups;
  }
};

// Patch only managed environment keys and exact known hook tuples while retaining unrelated fields.
export const patchClaudeSettings = (
  original: Readonly<Record<string, unknown>>,
  patch: ClaudeSettingsPatch,
): Record<string, unknown> => {
  assertSafeJsonValue(original, "Claude settings");
  const document = cloneJson(original) as Record<string, unknown>;
  const hadEnvironment = document.env !== undefined;
  const environment = { ...readClaudeSettingsEnvironment(document) };
  for (const key of patch.managedEnvironmentKeys) {
    const value = patch.environment[key];
    if (value === undefined) {
      Reflect.deleteProperty(environment, key);
    } else {
      environment[key] = value;
    }
  }
  if (Object.keys(environment).length > 0 || hadEnvironment) {
    document.env = environment;
  }

  const configuredHooks = document.hooks;
  if (configuredHooks !== undefined && !isJsonRecord(configuredHooks)) {
    throw new ClaudeSettingsError("Claude settings hooks must be an object.");
  }
  const hooks = configuredHooks === undefined ? {} : { ...configuredHooks };
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    reconcileHookEvent(hooks, event, patch.knownHooks, patch.desiredHooks);
  }
  if (Object.keys(hooks).length > 0 || configuredHooks !== undefined) {
    document.hooks = hooks;
  }

  assertSafeJsonValue(document, "Claude settings");
  return document;
};

export const serializeClaudeSettings = (document: Readonly<Record<string, unknown>>): Buffer => {
  assertSafeJsonValue(document, "Claude settings");
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
};
