// Managed by Szal: Pi global extension v1

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SZAL_MEASUREMENT_ENTRY_TYPE = "szal-compression-measurement";
export const SZAL_OWNER = "szal-pi";

const ELIGIBLE_CATEGORIES = new Set(["bash", "code", "json", "markdown", "memory", "tests"]);
const MIN_BYTES = 4_096;
const MIN_ESTIMATED_TOKENS = 1_024;
const HEAD_BYTES = 1_800;
const TAIL_BYTES = 1_800;

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

const appendMeasurement = (pi: ExtensionAPI, measurement: Record<string, unknown>): void => {
  try {
    pi.appendEntry(SZAL_MEASUREMENT_ENTRY_TYPE, measurement);
  } catch {
    // Fail open: measurement must never affect the tool result sent back to Pi.
  }
};

const makeMeasurement = (
  event: { toolCallId?: string; toolName?: string },
  category: string,
  rawContent: string,
  compressedContent: string,
  reasonCode: string,
  failedOpen: boolean,
  owner: string = SZAL_OWNER,
): Record<string, unknown> => ({
  category,
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

export const compressTextSlice = (content: string): string => {
  const rawBytes = byteLength(content);
  const head = sliceByBytes(content, HEAD_BYTES);
  const tail = sliceByBytes(content, TAIL_BYTES, true);
  const omittedBytes = Math.max(0, rawBytes - byteLength(head) - byteLength(tail));
  return `${head}\n\n[szal compressed ${omittedBytes} bytes from the middle of this Pi tool result; original content was ${rawBytes} bytes.]\n\n${tail}`;
};

const measurementSummary = (entries: readonly unknown[]): string => {
  const measurements = entries
    .filter(
      (entry): entry is { data?: Record<string, unknown>; customType: string; type: string } =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "custom" &&
        (entry as { customType?: unknown }).customType === SZAL_MEASUREMENT_ENTRY_TYPE &&
        typeof (entry as { data?: unknown }).data === "object" &&
        (entry as { data?: unknown }).data !== null,
    )
    .map((entry) => entry.data ?? {});
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
  const recent = measurements
    .slice(-5)
    .map(
      (item) =>
        `- ${String(item.category ?? "unknown")}: ${String(item.reasonCode ?? "unknown")} ${String(item.rawBytes ?? 0)}→${String(item.compressedBytes ?? 0)} bytes`,
    );
  return [
    `Szal Pi extension is active (${process.env.SZAL_ENABLED === "1" ? "compression enabled" : "pass-through"}).`,
    `Measurements: ${measurements.length}; saved ${totalSavedBytes} bytes / ${totalSavedTokens} estimated tokens.`,
    ...(recent.length === 0 ? ["No compression measurements recorded in this branch."] : recent),
  ].join("\n");
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("szal", {
    description: "Show Szal Pi extension status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(measurementSummary(ctx.sessionManager.getBranch()), "info");
    },
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
      const compressed = compressTextSlice(content);
      if (compressed.length === 0 || byteLength(compressed) >= byteLength(content)) {
        appendMeasurement(
          pi,
          makeMeasurement(event, category, content, content, "not-smaller", true),
        );
        return;
      }
      appendMeasurement(
        pi,
        makeMeasurement(event, category, content, compressed, "compressed", false),
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
