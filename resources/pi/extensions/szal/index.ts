// Managed by Szal: Pi global extension v1

import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SZAL_MEASUREMENT_ENTRY_TYPE = "szal-compression-measurement";
export const SZAL_CONTEXT_ENTRY_TYPE = "szal-context-measurement";
export const SZAL_PROVIDER_CONTEXT_ENTRY_TYPE = "szal-provider-context-measurement";
export const SZAL_COMPACTION_OBSERVATION_ENTRY_TYPE = "szal-compaction-observation";
export const SZAL_OWNER = "szal-pi";

const ELIGIBLE_CATEGORIES = new Set(["bash", "code", "json", "markdown", "memory", "tests"]);
const MIN_BYTES = 4_096;
const MIN_ESTIMATED_TOKENS = 1_024;
const HEAD_BYTES = 1_800;
const TAIL_BYTES = 1_800;
const COLD_OBJECT_ID_PATTERN = /^szal:\/\/cold\/sha256\/[a-f0-9]{64}$/u;
const COLD_STORE_TIMEOUT_MS = 10_000;

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
      ctx.ui.notify(measurementSummary(ctx.sessionManager.getBranch()), "info");
    },
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

  pi.on("session_before_compact", async (event) => {
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
  });

  pi.on("tool_result", async (event) => {
    const content = textFromContent(event.content);
    const category = categorizeToolResult(event);

    if (content === undefined) {
      appendMeasurement(
        pi,
        makeMeasurement(event, category, "", "", "non-text-content", false, "raw"),
      );
      return;
    }

    if (process.env.SZAL_ENABLED !== "1") {
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, content, "terminal-pass-through", false, "raw"),
      );
      return;
    }

    const owner = resolveOwner(category, [SZAL_OWNER]);
    if (owner.reasonCode === "owner-conflict" || owner.owner === "raw") {
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
        appendMeasurement(
          pi,
          makeMeasurement(event, category, content, content, "cold-store-error", true),
        );
        return;
      }

      const compressed = compressTextSlice(content, coldObjectId);
      if (compressed.length === 0 || byteLength(compressed) >= byteLength(content)) {
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
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, content, "compressor-error", true),
      );
      return;
    }
  });
}
