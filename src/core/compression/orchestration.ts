import type { ContentCategory } from "../config/index.js";

export type CompressionRuntimeOwner = "raw" | "szal-pi";

export type CompressionDecisionAction = "compress" | "pass-through";

export type CompressionDecisionReasonCode =
  | "below-threshold"
  | "category-ineligible"
  | "cold-storage-raw"
  | "compressed"
  | "compressor-error"
  | "eligible"
  | "no-owner"
  | "not-smaller"
  | "owner-conflict";

export interface CompressionSliceInput {
  category: ContentCategory;
  content: string;
  contentId?: string;
  source: string;
}

export interface CompressionDecision {
  action: CompressionDecisionAction;
  category: ContentCategory;
  competingOwners?: readonly CompressionRuntimeOwner[];
  owner: CompressionRuntimeOwner;
  reason: string;
  reasonCode: CompressionDecisionReasonCode;
}

export interface CompressionMeasurement {
  category: ContentCategory;
  compressedBytes: number;
  compressedTokens: number;
  contentId?: string;
  failedOpen: boolean;
  owner: CompressionRuntimeOwner;
  rawBytes: number;
  rawTokens: number;
  reasonCode: CompressionDecisionReasonCode;
  source: string;
}

export interface CompressionExecutionResult {
  compressed: boolean;
  content: string;
  decision: CompressionDecision;
  measurement: CompressionMeasurement;
}

export interface CompressionPolicy {
  eligibleCategories: readonly ContentCategory[];
  minBytes: number;
  minEstimatedTokens: number;
}

export type CompressionFunction = (input: CompressionSliceInput) => Promise<string> | string;

export const DEFAULT_COMPRESSION_POLICY: CompressionPolicy = {
  eligibleCategories: ["bash", "code", "json", "markdown", "memory", "tests"],
  minBytes: 4_096,
  minEstimatedTokens: 1_024,
};

const byteLength = (content: string): number => Buffer.byteLength(content, "utf8");

export const estimateCompressionTokens = (content: string): number =>
  content.length === 0 ? 0 : Math.ceil(byteLength(content) / 4);

const passThroughDecision = (
  category: ContentCategory,
  owner: CompressionRuntimeOwner,
  reasonCode: CompressionDecisionReasonCode,
  reason: string,
  competingOwners?: readonly CompressionRuntimeOwner[],
): CompressionDecision => ({
  action: "pass-through",
  category,
  ...(competingOwners === undefined ? {} : { competingOwners }),
  owner,
  reason,
  reasonCode,
});

export const resolveRuntimeOwner = (
  category: ContentCategory,
  owners: readonly CompressionRuntimeOwner[],
): CompressionDecision => {
  const activeOwners = owners.filter((owner) => owner !== "raw");
  if (activeOwners.length === 0) {
    return passThroughDecision(
      category,
      "raw",
      "no-owner",
      `${category} has no compression owner.`,
    );
  }
  if (activeOwners.length > 1) {
    return passThroughDecision(
      category,
      "raw",
      "owner-conflict",
      `${category} has multiple compression owners: ${activeOwners.join(", ")}.`,
      activeOwners,
    );
  }
  return {
    action: "compress",
    category,
    owner: activeOwners[0] ?? "raw",
    reason: `${activeOwners[0] ?? "raw"} owns ${category}.`,
    reasonCode: "eligible",
  };
};

export const shouldCompress = (
  input: CompressionSliceInput,
  ownerDecision: CompressionDecision,
  policy: CompressionPolicy = DEFAULT_COMPRESSION_POLICY,
): CompressionDecision => {
  if (ownerDecision.action === "pass-through") {
    return ownerDecision;
  }
  if (input.category === "cold-storage") {
    return passThroughDecision(
      input.category,
      "raw",
      "cold-storage-raw",
      "Cold storage remains raw in the Pi compression slice.",
    );
  }
  if (!policy.eligibleCategories.includes(input.category)) {
    return passThroughDecision(
      input.category,
      "raw",
      "category-ineligible",
      `${input.category} is not eligible for Pi compression.`,
    );
  }

  const rawBytes = byteLength(input.content);
  const rawTokens = estimateCompressionTokens(input.content);
  if (rawBytes < policy.minBytes || rawTokens < policy.minEstimatedTokens) {
    return passThroughDecision(
      input.category,
      "raw",
      "below-threshold",
      `${input.category} is below the Pi compression threshold.`,
    );
  }

  return ownerDecision;
};

const measurement = (
  input: CompressionSliceInput,
  owner: CompressionRuntimeOwner,
  compressedContent: string,
  reasonCode: CompressionDecisionReasonCode,
  failedOpen: boolean,
): CompressionMeasurement => ({
  category: input.category,
  compressedBytes: byteLength(compressedContent),
  compressedTokens: estimateCompressionTokens(compressedContent),
  ...(input.contentId === undefined ? {} : { contentId: input.contentId }),
  failedOpen,
  owner,
  rawBytes: byteLength(input.content),
  rawTokens: estimateCompressionTokens(input.content),
  reasonCode,
  source: input.source,
});

export const executeCompression = async (
  input: CompressionSliceInput,
  decision: CompressionDecision,
  compressor: CompressionFunction,
): Promise<CompressionExecutionResult> => {
  if (decision.action === "pass-through") {
    return {
      compressed: false,
      content: input.content,
      decision,
      measurement: measurement(
        input,
        decision.owner,
        input.content,
        decision.reasonCode,
        decision.reasonCode === "owner-conflict",
      ),
    };
  }

  try {
    const compressedContent = await compressor(input);
    if (
      compressedContent.length === 0 ||
      byteLength(compressedContent) >= byteLength(input.content)
    ) {
      const failedDecision = passThroughDecision(
        input.category,
        "raw",
        "not-smaller",
        "Compressed content was empty or not smaller; using original content.",
      );
      return {
        compressed: false,
        content: input.content,
        decision: failedDecision,
        measurement: measurement(input, decision.owner, input.content, "not-smaller", true),
      };
    }

    const completedDecision: CompressionDecision = {
      action: "compress",
      category: input.category,
      owner: decision.owner,
      reason: `${decision.owner} compressed ${input.category}.`,
      reasonCode: "compressed",
    };
    return {
      compressed: true,
      content: compressedContent,
      decision: completedDecision,
      measurement: measurement(input, decision.owner, compressedContent, "compressed", false),
    };
  } catch {
    const failedDecision = passThroughDecision(
      input.category,
      "raw",
      "compressor-error",
      "Compression failed; using original content.",
    );
    return {
      compressed: false,
      content: input.content,
      decision: failedDecision,
      measurement: measurement(input, decision.owner, input.content, "compressor-error", true),
    };
  }
};
