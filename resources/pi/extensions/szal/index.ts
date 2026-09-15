// Managed by Szal: Pi global extension v1

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SZAL_MEASUREMENT_ENTRY_TYPE = "szal-compression-measurement";
export const SZAL_CONTEXT_ENTRY_TYPE = "szal-context-measurement";
export const SZAL_PROVIDER_CONTEXT_ENTRY_TYPE = "szal-provider-context-measurement";
export const SZAL_COMPACTION_OBSERVATION_ENTRY_TYPE = "szal-compaction-observation";
export const SZAL_RUNTIME_STATUS_ENTRY_TYPE = "szal-runtime-status";
export const SZAL_OWNER = "szal-pi";

const ELIGIBLE_CATEGORIES = new Set(["bash", "code", "json", "markdown", "memory", "tests"]);
const MIN_BYTES = 4_096;
const MIN_ESTIMATED_TOKENS = 1_024;
const HEAD_BYTES = 1_800;
const TAIL_BYTES = 1_800;
const COLD_OBJECT_ID_PATTERN = /^szal:\/\/cold\/sha256\/[a-f0-9]{64}$/u;
const COLD_STORE_TIMEOUT_MS = 10_000;
const MEMORY_HELPER_TIMEOUT_MS = 10_000;
const MAX_MEMORY_BLOCK_BYTES = 8_000;
const MAX_CAPTURE_PREVIEW_BYTES = 600;
const DEFAULT_MEMORY_LIMIT = 8;
const MAX_MEMORY_LIMIT = 20;

const byteLength = (content: string): number => Buffer.byteLength(content, "utf8");
const estimateTokens = (content: string): number =>
  content.length === 0 ? 0 : Math.ceil(byteLength(content) / 4);

const textFromContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (
      item === null ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return undefined;
    }
    textParts.push((item as { text: string }).text);
  }
  return textParts.join("\n");
};

const appendCustomMeasurement = (
  pi: ExtensionAPI,
  customType: string,
  measurement: Record<string, unknown>,
): void => {
  try {
    pi.appendEntry(customType, measurement);
  } catch {
    // Fail open: measurement must never affect Pi behavior.
  }
};

const appendMeasurement = (pi: ExtensionAPI, measurement: Record<string, unknown>): void => {
  appendCustomMeasurement(pi, SZAL_MEASUREMENT_ENTRY_TYPE, measurement);
};

type RuntimeStatusLabel = "ON" | "degraded" | "OFF";

const runtimeStatus = (): { reasonCode: string; status: RuntimeStatusLabel } => {
  const value = process.env.SZAL_ENABLED;
  if (value === "1") {
    return { reasonCode: "terminal-on", status: "ON" };
  }
  if (value === "0") {
    return { reasonCode: "terminal-off", status: "OFF" };
  }
  if (value !== undefined && value.length > 0) {
    return { reasonCode: "invalid-szal-enabled", status: "degraded" };
  }
  return { reasonCode: "terminal-unset", status: "OFF" };
};

const updateRuntimeStatus = (
  pi: ExtensionAPI,
  ctx: { ui?: { setStatus?: (key: string, text: string) => void } },
  source: string,
): RuntimeStatusLabel => {
  const status = runtimeStatus();
  try {
    ctx.ui?.setStatus?.("szal", status.status);
  } catch {
    // Fail open: status rendering must never affect Pi behavior.
  }
  appendCustomMeasurement(pi, SZAL_RUNTIME_STATUS_ENTRY_TYPE, {
    owner: SZAL_OWNER,
    reasonCode: status.reasonCode,
    source,
    status: status.status,
    timestamp: new Date().toISOString(),
    ...(process.env.SZAL_ENABLED === undefined ? {} : { enabledValue: process.env.SZAL_ENABLED }),
    ...(process.env.SZAL_TERMINAL_ID === undefined
      ? {}
      : { terminalId: process.env.SZAL_TERMINAL_ID }),
  });
  return status.status;
};

const makeMeasurement = (
  event: { toolCallId?: string; toolName?: string },
  category: string,
  rawContent: string,
  compressedContent: string,
  reasonCode: string,
  failedOpen: boolean,
  owner: string = SZAL_OWNER,
  coldObjectId?: string,
): Record<string, unknown> => ({
  category,
  ...(coldObjectId === undefined ? {} : { coldObjectId, recallUri: coldObjectId }),
  compressedBytes: byteLength(compressedContent),
  compressedTokens: estimateTokens(compressedContent),
  failedOpen,
  owner,
  rawBytes: byteLength(rawContent),
  rawTokens: estimateTokens(rawContent),
  reasonCode,
  source: `pi:${event.toolName ?? "unknown"}`,
  timestamp: new Date().toISOString(),
  ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
});

const summarizeBytes = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
};

const currentOwners = (): readonly string[] => {
  const testOwners = process.env.SZAL_PI_TEST_OWNERS;
  if (testOwners !== undefined) {
    return testOwners
      .split(",")
      .map((owner) => owner.trim())
      .filter((owner) => owner.length > 0);
  }
  return process.env.SZAL_ENABLED === "1" ? [SZAL_OWNER] : ["raw"];
};

const resolveExclusiveOwner = (
  owners: readonly string[],
): { failedOpen: boolean; owner: string; reasonCode: string } => {
  const activeOwners = owners.filter((owner) => owner !== "raw");
  if (activeOwners.length === 0) {
    return { failedOpen: false, owner: "raw", reasonCode: "no-owner" };
  }
  if (activeOwners.length > 1) {
    return { failedOpen: true, owner: "raw", reasonCode: "owner-conflict" };
  }
  return { failedOpen: false, owner: activeOwners[0] ?? "raw", reasonCode: "eligible" };
};

const branchSnapshot = (ctx: { sessionManager?: { getBranch?: () => unknown } }): string => {
  try {
    return JSON.stringify(ctx.sessionManager?.getBranch?.() ?? null) ?? "null";
  } catch {
    return "unavailable";
  }
};

const cloneWithTextContent = (
  message: Record<string, unknown>,
  text: string,
): Record<string, unknown> => ({
  ...message,
  content: [{ type: "text", text }],
});

const shapeMessage = (
  message: unknown,
): {
  category: string;
  compressed: boolean;
  message: unknown;
  rawBytes: number;
  shapedBytes: number;
} => {
  if (message === null || typeof message !== "object") {
    return { category: "conversation", compressed: false, message, rawBytes: 0, shapedBytes: 0 };
  }
  const record = message as Record<string, unknown>;
  const content = textFromContent(record.content);
  if (record.role !== "toolResult" || content === undefined) {
    const bytes = summarizeBytes(message);
    return {
      category: "conversation",
      compressed: false,
      message,
      rawBytes: bytes,
      shapedBytes: bytes,
    };
  }
  const category = categorizeToolResult({
    content: record.content,
    input: record.input,
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
  });
  const decision = shouldCompress(category, content);
  if (decision.action === "pass-through") {
    const bytes = summarizeBytes(message);
    return { category, compressed: false, message, rawBytes: bytes, shapedBytes: bytes };
  }
  const compressed = compressTextSlice(content);
  if (compressed.length === 0 || byteLength(compressed) >= byteLength(content)) {
    const bytes = summarizeBytes(message);
    return { category, compressed: false, message, rawBytes: bytes, shapedBytes: bytes };
  }
  const shapedMessage = cloneWithTextContent(record, compressed);
  return {
    category,
    compressed: true,
    message: shapedMessage,
    rawBytes: summarizeBytes(message),
    shapedBytes: summarizeBytes(shapedMessage),
  };
};

const shapeContextMessages = (
  messages: readonly unknown[],
): {
  category: string;
  compressedCount: number;
  messages: unknown[];
  rawBytes: number;
  reasonCode: string;
  shapedBytes: number;
} => {
  let rawBytes = 0;
  let shapedBytes = 0;
  let compressedCount = 0;
  let category = "conversation";
  const shapedMessages = messages.map((message) => {
    const result = shapeMessage(message);
    rawBytes += result.rawBytes;
    shapedBytes += result.shapedBytes;
    if (result.compressed) {
      compressedCount += 1;
      category = result.category;
    }
    return result.message;
  });
  return {
    category,
    compressedCount,
    messages: shapedMessages,
    rawBytes,
    reasonCode: compressedCount > 0 ? "compressed" : "below-threshold",
    shapedBytes,
  };
};

const stringValues = (value: unknown, depth = 0): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || typeof value !== "object" || depth > 2) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringValues(item, depth + 1));
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    /path|file|name|command/u.test(key) ? stringValues(entry, depth + 1) : [],
  );
};

export const categorizeToolResult = (event: {
  content?: unknown;
  input?: unknown;
  toolName?: string;
}): string => {
  if (event.toolName === "bash" || event.toolName === "powershell") {
    return "bash";
  }

  const text = textFromContent(event.content) ?? "";
  const hints = [...stringValues(event.input), text.slice(0, 256)].join("\n").toLowerCase();
  if (/(^|[/\\])(__tests__|tests?|spec)([/\\])|\.(test|spec)\.[a-z0-9]+$/u.test(hints)) {
    return "tests";
  }
  if (/\.json(?:\b|$)/u.test(hints) || /^\s*(?:\[|\{)/u.test(text)) {
    return "json";
  }
  if (/\.md(?:\b|$)|\.markdown(?:\b|$)/u.test(hints) || /^\s*#/u.test(text)) {
    return "markdown";
  }
  return "code";
};

const resolveOwner = (
  category: string,
  owners: readonly string[],
): { owner: string; reasonCode: string } => {
  const activeOwners = owners.filter((owner) => owner !== "raw");
  if (activeOwners.length === 0) {
    return { owner: "raw", reasonCode: "no-owner" };
  }
  if (activeOwners.length > 1) {
    return { owner: "raw", reasonCode: "owner-conflict" };
  }
  return {
    owner: activeOwners[0] ?? "raw",
    reasonCode: ELIGIBLE_CATEGORIES.has(category) ? "eligible" : "category-ineligible",
  };
};

const shouldCompress = (
  category: string,
  content: string,
): { action: "compress" | "pass-through"; reasonCode: string } => {
  if (!ELIGIBLE_CATEGORIES.has(category)) {
    return { action: "pass-through", reasonCode: "category-ineligible" };
  }
  if (byteLength(content) < MIN_BYTES || estimateTokens(content) < MIN_ESTIMATED_TOKENS) {
    return { action: "pass-through", reasonCode: "below-threshold" };
  }
  return { action: "compress", reasonCode: "eligible" };
};

const sliceByBytes = (content: string, bytes: number, tail = false): string => {
  const characters = [...content];
  let used = 0;
  const selected: string[] = [];
  const iterable = tail ? characters.reverse() : characters;
  for (const character of iterable) {
    const size = byteLength(character);
    if (used + size > bytes) {
      break;
    }
    used += size;
    selected.push(character);
  }
  return tail ? selected.reverse().join("") : selected.join("");
};

export const compressTextSlice = (content: string, coldObjectId?: string): string => {
  const rawBytes = byteLength(content);
  const head = sliceByBytes(content, HEAD_BYTES);
  const tail = sliceByBytes(content, TAIL_BYTES, true);
  const omittedBytes = Math.max(0, rawBytes - byteLength(head) - byteLength(tail));
  const recallHint =
    coldObjectId === undefined ? "" : ` Recall exact original with: szal recall ${coldObjectId}.`;
  return `${head}\n\n[szal compressed ${omittedBytes} bytes from the middle of this Pi tool result; original content was ${rawBytes} bytes.${recallHint}]\n\n${tail}`;
};

const storeColdOriginal = async (request: {
  category: string;
  content: string;
  sourceTool?: string;
}): Promise<string | undefined> =>
  new Promise((resolve) => {
    const command = process.env.SZAL_CLI_PATH ?? "szal";
    const arguments_ = ["cold", "store", "--category", request.category];
    if (request.sourceTool !== undefined && request.sourceTool.length > 0) {
      arguments_.push("--source-tool", request.sourceTool);
    }

    let settled = false;
    let stdout = "";
    let stderrBytes = 0;
    const child = spawn(command, arguments_, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (id?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(id);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, COLD_STORE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 256) {
        child.kill();
        finish();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4_096) {
        child.kill();
        finish();
      }
    });
    child.on("error", () => {
      finish();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish();
        return;
      }
      const id = stdout.trim();
      finish(COLD_OBJECT_ID_PATTERN.test(id) ? id : undefined);
    });
    child.stdin.on("error", () => {
      finish();
    });
    child.stdin.end(request.content, "utf8");
  });

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
};

const stableHash = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const memoryCaptureEnabled = (): boolean =>
  process.env.SZAL_ENABLED === "1" && process.env.SZAL_PI_MEMORY !== "0";

const clampMemoryLimit = (limit: unknown): number => {
  const numeric = Number(limit ?? DEFAULT_MEMORY_LIMIT);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? Math.min(numeric, MAX_MEMORY_LIMIT)
    : DEFAULT_MEMORY_LIMIT;
};

const previewText = (content: string, maxBytes = MAX_CAPTURE_PREVIEW_BYTES): string => {
  const singleLine = content.replace(/\s+/gu, " ").trim();
  if (byteLength(singleLine) <= maxBytes) {
    return singleLine;
  }
  const characters = [...singleLine];
  let used = 0;
  const selected: string[] = [];
  for (const character of characters) {
    const size = byteLength(character);
    if (used + size > maxBytes - 3) {
      break;
    }
    selected.push(character);
    used += size;
  }
  return `${selected.join("")}...`;
};

const contextCwd = (ctx: { cwd?: unknown }): string =>
  typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();

const contextSessionId = (ctx: {
  sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown };
}): string => {
  const fromManager = ctx.sessionManager?.getSessionId?.();
  if (typeof fromManager === "string" && fromManager.length > 0) {
    return fromManager;
  }
  if (process.env.PI_SESSION_ID !== undefined && process.env.PI_SESSION_ID.length > 0) {
    return process.env.PI_SESSION_ID;
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return `pi-session-${stableHash({ cwd: contextCwd(ctx), sessionFile }).slice(0, 16)}`;
};

const contextSessionFile = (ctx: {
  sessionManager?: { getSessionFile?: () => unknown };
}): string => {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : "ephemeral";
};

const runSzalText = async (request: {
  arguments: readonly string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
}): Promise<string | undefined> =>
  new Promise((resolve) => {
    const command = process.env.SZAL_CLI_PATH ?? "szal";
    let settled = false;
    let stdout = "";
    let stderrBytes = 0;
    const child = spawn(command, [...request.arguments], {
      cwd: request.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (value?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, request.timeoutMs ?? MEMORY_HELPER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (byteLength(stdout) > MAX_MEMORY_BLOCK_BYTES) {
        child.kill();
        finish(stdout.slice(0, MAX_MEMORY_BLOCK_BYTES));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += byteLength(chunk);
      if (stderrBytes > 4_096) {
        child.kill();
        finish();
      }
    });
    child.on("error", () => {
      finish();
    });
    child.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : undefined);
    });
    child.stdin.on("error", () => {
      finish();
    });
    child.stdin.end(request.stdin ?? "", "utf8");
  });

const capturePiLifecycleMemory = async (
  ctx: {
    cwd?: unknown;
    sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown };
  },
  kind: string,
  eventId: string,
  candidates: readonly Record<string, unknown>[],
): Promise<void> => {
  if (!memoryCaptureEnabled() || candidates.length === 0) {
    return;
  }
  try {
    await runSzalText({
      arguments: [
        "memory",
        "capture-host-lifecycle",
        "--host",
        "pi",
        "--session-id",
        contextSessionId(ctx),
        "--kind",
        kind,
        "--event-id",
        eventId,
        "--project",
        contextCwd(ctx),
        "--mode",
        "on",
        "--json",
      ],
      cwd: contextCwd(ctx),
      stdin: JSON.stringify(candidates),
    });
  } catch {
    // Fail open: lifecycle memory must never affect Pi behavior.
  }
};

const loadPiMemoryBlock = async (
  ctx: { cwd?: unknown },
  options: { limit?: unknown; query?: string } = {},
): Promise<string | undefined> => {
  try {
    const query = options.query?.trim();
    return await runSzalText({
      arguments: [
        "memory",
        "recall",
        "--project",
        contextCwd(ctx),
        "--limit",
        String(clampMemoryLimit(options.limit)),
        ...(query === undefined || query.length === 0 ? [] : ["--query", query]),
      ],
      cwd: contextCwd(ctx),
    });
  } catch {
    return undefined;
  }
};

const hasRecallItems = (memoryBlock: string | undefined): memoryBlock is string =>
  memoryBlock !== undefined && /\n- \[/u.test(memoryBlock);

const toolMemoryClass = (event: { isError?: unknown; toolName?: string }): string => {
  if (event.isError === true) {
    return "error";
  }
  return /^(read|write|edit|grep|find|ls)$/u.test(event.toolName ?? "")
    ? "file-state"
    : "environment";
};

const captureToolLifecycleMemory = (
  ctx: {
    cwd?: unknown;
    sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown };
  },
  event: { isError?: unknown; toolCallId?: string; toolName?: string },
  details: {
    category: string;
    coldObjectId?: string;
    compressedContent: string;
    content: string;
    reasonCode: string;
  },
): void => {
  const toolCallId =
    event.toolCallId ?? stableHash({ content: details.content, tool: event.toolName });
  const compressedBytes = byteLength(details.compressedContent);
  const rawBytes = byteLength(details.content);
  void capturePiLifecycleMemory(ctx, "tool-lifecycle", `tool:${toolCallId}:${details.reasonCode}`, [
    {
      class: toolMemoryClass(event),
      confidence: 1,
      content: [
        `Pi tool_result ${event.toolName ?? "unknown"}/${toolCallId} ${
          event.isError === true ? "failed" : "completed"
        } with ${details.reasonCode}.`,
        `Category: ${details.category}; raw bytes: ${String(rawBytes)}; compressed bytes: ${String(compressedBytes)}.`,
        ...(details.coldObjectId === undefined ? [] : [`Cold object: ${details.coldObjectId}.`]),
        ...(details.content.length === 0 ? [] : [`Preview: ${previewText(details.content)}.`]),
      ].join(" "),
      key: `tool:${event.toolName ?? "unknown"}:${toolCallId}:${details.reasonCode}`,
      status: event.isError === true ? "considered" : "selected",
    },
  ]);
};

const customDataEntries = (
  entries: readonly unknown[],
  customType: string,
): Record<string, unknown>[] =>
  entries
    .filter(
      (entry): entry is { data?: Record<string, unknown>; customType: string; type: string } =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "custom" &&
        (entry as { customType?: unknown }).customType === customType &&
        typeof (entry as { data?: unknown }).data === "object" &&
        (entry as { data?: unknown }).data !== null,
    )
    .map((entry) => entry.data ?? {});

const measurementSummary = (entries: readonly unknown[]): string => {
  const measurements = customDataEntries(entries, SZAL_MEASUREMENT_ENTRY_TYPE);
  const contextMeasurements = customDataEntries(entries, SZAL_CONTEXT_ENTRY_TYPE);
  const compactionObservations = customDataEntries(entries, SZAL_COMPACTION_OBSERVATION_ENTRY_TYPE);
  const totalSavedBytes = measurements.reduce(
    (sum, item) =>
      sum + Math.max(0, Number(item.rawBytes ?? 0) - Number(item.compressedBytes ?? 0)),
    0,
  );
  const totalSavedTokens = measurements.reduce(
    (sum, item) =>
      sum + Math.max(0, Number(item.rawTokens ?? 0) - Number(item.compressedTokens ?? 0)),
    0,
  );
  const contextSavedBytes = contextMeasurements.reduce(
    (sum, item) =>
      sum + Math.max(0, Number(item.rawContextBytes ?? 0) - Number(item.shapedContextBytes ?? 0)),
    0,
  );
  const recent = measurements
    .slice(-5)
    .map(
      (item) =>
        `- ${String(item.category ?? "unknown")}: ${String(item.reasonCode ?? "unknown")} ${String(item.rawBytes ?? 0)}→${String(item.compressedBytes ?? 0)} bytes`,
    );
  const recentContext = contextMeasurements
    .slice(-3)
    .map(
      (item) =>
        `- context: ${String(item.reasonCode ?? "unknown")} ${String(item.rawContextBytes ?? 0)}→${String(item.shapedContextBytes ?? 0)} bytes`,
    );
  const recentCompaction = compactionObservations
    .slice(-3)
    .map(
      (item) =>
        `- compaction: ${String(item.reason ?? "unknown")} ${String(item.tokensBefore ?? 0)} tokens before`,
    );
  return [
    `Runtime indicator: ${runtimeStatus().status}`,
    `Szal Pi extension is active (${process.env.SZAL_ENABLED === "1" ? "compression enabled" : "pass-through"}).`,
    `Measurements: ${measurements.length}; saved ${totalSavedBytes} bytes / ${totalSavedTokens} estimated tokens.`,
    `Context measurements: ${contextMeasurements.length}; saved ${contextSavedBytes} bytes before provider requests.`,
    ...(recent.length === 0 ? ["No compression measurements recorded in this branch."] : recent),
    ...recentContext,
    ...recentCompaction,
  ].join("\n");
};

export default function (pi: ExtensionAPI) {
  let lastContextMeasurement: Record<string, unknown> | undefined;

  pi.registerCommand("szal", {
    description: "Show Szal Pi extension status",
    handler: async (_args, ctx) => {
      updateRuntimeStatus(pi, ctx, "command");
      ctx.ui.notify(measurementSummary(ctx.sessionManager.getBranch()), "info");
    },
  });

  pi.registerCommand("szal-recall", {
    description: "Show bounded Szal structured memory for this project",
    handler: async (args, ctx) => {
      const memoryBlock = await loadPiMemoryBlock(ctx, {
        query: args,
        limit: DEFAULT_MEMORY_LIMIT,
      });
      ctx.ui.notify(memoryBlock ?? "Szal memory is unavailable.", "info");
    },
  });

  pi.registerTool({
    name: "szal_recall",
    label: "Szal Recall",
    description: "Recall bounded Szal structured memory for the current project.",
    promptSnippet: "Recall bounded Szal project memory when recovery context may help",
    promptGuidelines: [
      "Use szal_recall only when project memory, recovery context, or previous Pi lifecycle facts are relevant to the user's request.",
    ],
    parameters: {
      additionalProperties: false,
      properties: {
        limit: { maximum: MAX_MEMORY_LIMIT, minimum: 1, type: "integer" },
        query: { type: "string" },
      },
      type: "object",
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { limit?: unknown; query?: string };
      const memoryBlock = await loadPiMemoryBlock(ctx, {
        limit: input.limit,
        query: input.query,
      });
      return {
        content: [{ type: "text", text: memoryBlock ?? "Szal memory is unavailable." }],
        details: { limit: clampMemoryLimit(input.limit), query: input.query ?? null },
      };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    updateRuntimeStatus(pi, ctx, `session-${String(event.reason ?? "unknown")}`);
    await capturePiLifecycleMemory(
      ctx,
      "session-lifecycle",
      `session:${contextSessionId(ctx)}:${String(event.reason ?? "unknown")}`,
      [
        {
          class: "environment",
          confidence: 1,
          content: `Pi session ${contextSessionId(ctx)} started in ${contextCwd(ctx)} (reason: ${String(
            event.reason ?? "unknown",
          )}; file: ${contextSessionFile(ctx)}).`,
          key: `session:${contextSessionId(ctx)}`,
          status: "selected",
        },
      ],
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!memoryCaptureEnabled()) {
      return;
    }
    const memoryBlock = await loadPiMemoryBlock(ctx, { limit: DEFAULT_MEMORY_LIMIT });
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    await capturePiLifecycleMemory(
      ctx,
      "prompt-lifecycle",
      `prompt:${stableHash({ prompt, sessionId: contextSessionId(ctx) })}`,
      prompt.trim().length === 0
        ? []
        : [
            {
              class: "task",
              confidence: 1,
              content: `Pi prompt: ${previewText(prompt)}.`,
              key: `prompt:${stableHash(prompt)}`,
              status: "selected",
            },
          ],
    );
    if (hasRecallItems(memoryBlock)) {
      return { systemPrompt: `${String(event.systemPrompt ?? "")}\n\n${memoryBlock}` };
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const beforeBranch = branchSnapshot(ctx);
    const rawBytes = summarizeBytes(messages);

    if (process.env.SZAL_ENABLED !== "1" && process.env.SZAL_PI_TEST_OWNERS === undefined) {
      const measurement = {
        canonicalHistoryIntact: beforeBranch === branchSnapshot(ctx),
        compressedMessages: 0,
        failedOpen: false,
        owner: "raw",
        rawContextBytes: rawBytes,
        rawContextTokens: Math.ceil(rawBytes / 4),
        reasonCode: "terminal-pass-through",
        shapedContextBytes: rawBytes,
        shapedContextTokens: Math.ceil(rawBytes / 4),
        timestamp: new Date().toISOString(),
      };
      lastContextMeasurement = measurement;
      appendCustomMeasurement(pi, SZAL_CONTEXT_ENTRY_TYPE, measurement);
      return { messages };
    }

    const owner = resolveExclusiveOwner(currentOwners());
    if (owner.reasonCode !== "eligible") {
      const measurement = {
        canonicalHistoryIntact: beforeBranch === branchSnapshot(ctx),
        compressedMessages: 0,
        failedOpen: owner.failedOpen,
        owner: owner.owner,
        rawContextBytes: rawBytes,
        rawContextTokens: Math.ceil(rawBytes / 4),
        reasonCode: owner.reasonCode,
        shapedContextBytes: rawBytes,
        shapedContextTokens: Math.ceil(rawBytes / 4),
        timestamp: new Date().toISOString(),
      };
      lastContextMeasurement = measurement;
      appendCustomMeasurement(pi, SZAL_CONTEXT_ENTRY_TYPE, measurement);
      return { messages };
    }

    try {
      const shaped = shapeContextMessages(messages);
      const measurement = {
        canonicalHistoryIntact: beforeBranch === branchSnapshot(ctx),
        category: shaped.category,
        compressedMessages: shaped.compressedCount,
        failedOpen: false,
        owner: owner.owner,
        rawContextBytes: shaped.rawBytes,
        rawContextTokens: Math.ceil(shaped.rawBytes / 4),
        reasonCode: shaped.reasonCode,
        shapedContextBytes: shaped.shapedBytes,
        shapedContextTokens: Math.ceil(shaped.shapedBytes / 4),
        timestamp: new Date().toISOString(),
      };
      lastContextMeasurement = measurement;
      appendCustomMeasurement(pi, SZAL_CONTEXT_ENTRY_TYPE, measurement);
      return { messages: shaped.messages };
    } catch {
      const measurement = {
        canonicalHistoryIntact: beforeBranch === branchSnapshot(ctx),
        compressedMessages: 0,
        failedOpen: true,
        owner: owner.owner,
        rawContextBytes: rawBytes,
        rawContextTokens: Math.ceil(rawBytes / 4),
        reasonCode: "compressor-error",
        shapedContextBytes: rawBytes,
        shapedContextTokens: Math.ceil(rawBytes / 4),
        timestamp: new Date().toISOString(),
      };
      lastContextMeasurement = measurement;
      appendCustomMeasurement(pi, SZAL_CONTEXT_ENTRY_TYPE, measurement);
      return { messages };
    }
  });

  pi.on("before_provider_request", async (event) => {
    if (lastContextMeasurement === undefined) {
      return;
    }
    const providerPayloadBytes = summarizeBytes(event.payload);
    appendCustomMeasurement(pi, SZAL_PROVIDER_CONTEXT_ENTRY_TYPE, {
      failedOpen: false,
      owner: lastContextMeasurement.owner ?? "raw",
      providerPayloadBytes,
      providerPayloadTokens: Math.ceil(providerPayloadBytes / 4),
      rawContextBytes: lastContextMeasurement.rawContextBytes ?? providerPayloadBytes,
      rawContextTokens:
        lastContextMeasurement.rawContextTokens ?? Math.ceil(providerPayloadBytes / 4),
      reasonCode: "provider-payload-observed",
      shapedContextBytes: lastContextMeasurement.shapedContextBytes ?? providerPayloadBytes,
      shapedContextTokens:
        lastContextMeasurement.shapedContextTokens ?? Math.ceil(providerPayloadBytes / 4),
      timestamp: new Date().toISOString(),
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (process.env.SZAL_ENABLED !== "1") {
      return;
    }
    const owner = resolveExclusiveOwner(currentOwners());
    appendCustomMeasurement(pi, SZAL_COMPACTION_OBSERVATION_ENTRY_TYPE, {
      branchEntries: Array.isArray(event.branchEntries) ? event.branchEntries.length : 0,
      failedOpen: owner.failedOpen,
      firstKeptEntryId: event.preparation?.firstKeptEntryId,
      messagesToSummarize: Array.isArray(event.preparation?.messagesToSummarize)
        ? event.preparation.messagesToSummarize.length
        : 0,
      owner: owner.owner,
      reason: event.reason,
      reasonCode: owner.reasonCode,
      timestamp: new Date().toISOString(),
      tokensBefore: event.preparation?.tokensBefore,
      turnPrefixMessages: Array.isArray(event.preparation?.turnPrefixMessages)
        ? event.preparation.turnPrefixMessages.length
        : 0,
      willRetry: event.willRetry,
    });
    await capturePiLifecycleMemory(
      ctx,
      "compaction-lifecycle",
      `compaction:${stableHash({
        firstKeptEntryId: event.preparation?.firstKeptEntryId,
        reason: event.reason,
        tokensBefore: event.preparation?.tokensBefore,
        willRetry: event.willRetry,
      })}`,
      [
        {
          class: "environment",
          confidence: 1,
          content: `Pi compaction ${String(event.reason ?? "unknown")} prepared with ${String(
            event.preparation?.tokensBefore ?? "unknown",
          )} tokens before compaction and first kept entry ${String(
            event.preparation?.firstKeptEntryId ?? "unknown",
          )}.`,
          key: `compaction:${String(event.reason ?? "unknown")}:${String(
            event.preparation?.firstKeptEntryId ?? "unknown",
          )}`,
          status: "selected",
        },
      ],
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    const content = textFromContent(event.content);
    const category = categorizeToolResult(event);

    if (content === undefined) {
      captureToolLifecycleMemory(ctx, event, {
        category,
        compressedContent: "",
        content: "",
        reasonCode: "non-text-content",
      });
      appendMeasurement(
        pi,
        makeMeasurement(event, category, "", "", "non-text-content", false, "raw"),
      );
      return;
    }

    if (process.env.SZAL_ENABLED !== "1") {
      captureToolLifecycleMemory(ctx, event, {
        category,
        compressedContent: content,
        content,
        reasonCode: "terminal-pass-through",
      });
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, content, "terminal-pass-through", false, "raw"),
      );
      return;
    }

    const owner = resolveOwner(category, [SZAL_OWNER]);
    if (owner.reasonCode === "owner-conflict" || owner.owner === "raw") {
      captureToolLifecycleMemory(ctx, event, {
        category,
        compressedContent: content,
        content,
        reasonCode: owner.reasonCode,
      });
      appendMeasurement(
        pi,
        makeMeasurement(
          event,
          category,
          content,
          content,
          owner.reasonCode,
          owner.reasonCode === "owner-conflict",
          owner.owner,
        ),
      );
      return;
    }

    const decision = shouldCompress(category, content);
    if (decision.action === "pass-through") {
      captureToolLifecycleMemory(ctx, event, {
        category,
        compressedContent: content,
        content,
        reasonCode: decision.reasonCode,
      });
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, content, decision.reasonCode, false, "raw"),
      );
      return;
    }

    try {
      const coldObjectId = await storeColdOriginal({
        category,
        content,
        sourceTool: event.toolName,
      });
      if (coldObjectId === undefined) {
        captureToolLifecycleMemory(ctx, event, {
          category,
          compressedContent: content,
          content,
          reasonCode: "cold-store-error",
        });
        appendMeasurement(
          pi,
          makeMeasurement(event, category, content, content, "cold-store-error", true),
        );
        return;
      }

      const compressed = compressTextSlice(content, coldObjectId);
      if (compressed.length === 0 || byteLength(compressed) >= byteLength(content)) {
        captureToolLifecycleMemory(ctx, event, {
          category,
          coldObjectId,
          compressedContent: content,
          content,
          reasonCode: "not-smaller",
        });
        appendMeasurement(
          pi,
          makeMeasurement(
            event,
            category,
            content,
            content,
            "not-smaller",
            true,
            SZAL_OWNER,
            coldObjectId,
          ),
        );
        return;
      }
      captureToolLifecycleMemory(ctx, event, {
        category,
        coldObjectId,
        compressedContent: compressed,
        content,
        reasonCode: "compressed",
      });
      appendMeasurement(
        pi,
        makeMeasurement(
          event,
          category,
          content,
          compressed,
          "compressed",
          false,
          SZAL_OWNER,
          coldObjectId,
        ),
      );
      return { content: [{ type: "text", text: compressed }] };
    } catch {
      captureToolLifecycleMemory(ctx, event, {
        category,
        compressedContent: content,
        content,
        reasonCode: "compressor-error",
      });
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, content, "compressor-error", true),
      );
      return;
    }
  });
}
