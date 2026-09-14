import {
  CONTENT_CATEGORIES,
  type CompressionOwnerPreference,
  type CompressionProfile,
  type ContentCategory,
  type SzalConfig,
} from "../config/index.js";

export const COMPRESSION_ENGINE_IDS = ["llmtrim", "squeez"] as const;

export const REQUIRED_PRESERVATION_FIELDS = [
  "failures",
  "exact-identifiers",
  "paths",
  "errors",
  "commands",
  "urls",
  "types",
  "schema-fields",
  "negations",
  "rejected-approaches",
  "user-constraints",
] as const;

export type CompressionEngineId = (typeof COMPRESSION_ENGINE_IDS)[number];
export type CompressionSafety = "lossless" | "lossy-recoverable";
export type PreservationField = (typeof REQUIRED_PRESERVATION_FIELDS)[number];

export interface CompressionCapability {
  category: ContentCategory;
  preserves: readonly PreservationField[];
  safety: CompressionSafety;
}

export interface CompressionEngineState {
  activeCategories?: readonly ContentCategory[];
  available: boolean;
  capabilities: readonly CompressionCapability[];
  id: CompressionEngineId;
}

export interface OwnershipIssue {
  category: ContentCategory;
  code: "active-owner-conflict" | "owner-unavailable" | "unsafe-capability";
  message: string;
  severity: "error" | "warning";
}

export interface OwnershipAssignment {
  category: ContentCategory;
  competingOwners?: readonly CompressionEngineId[];
  owner: CompressionEngineId | null;
  reason: string;
  safety: CompressionSafety | "raw";
  state: "active" | "conflict" | "degraded" | "raw";
}

export interface CompressionOwnershipPlan {
  assignments: readonly OwnershipAssignment[];
  issues: readonly OwnershipIssue[];
  profile: CompressionProfile;
}

type ProfileOwnershipMatrix = Readonly<
  Record<CompressionProfile, Readonly<Record<ContentCategory, readonly CompressionEngineId[]>>>
>;

const RAW_CATEGORIES: Readonly<Record<ContentCategory, readonly CompressionEngineId[]>> = {
  bash: [],
  code: [],
  "cold-storage": [],
  conversation: [],
  json: [],
  markdown: [],
  memory: [],
  responses: [],
  tests: [],
};

export const PROFILE_OWNERSHIP_MATRIX: ProfileOwnershipMatrix = {
  safe: {
    ...RAW_CATEGORIES,
    bash: ["squeez", "llmtrim"],
    conversation: ["llmtrim"],
    json: ["squeez", "llmtrim"],
    responses: ["llmtrim"],
    tests: ["squeez", "llmtrim"],
  },
  balanced: {
    ...RAW_CATEGORIES,
    bash: ["squeez", "llmtrim"],
    code: ["squeez", "llmtrim"],
    conversation: ["llmtrim"],
    json: ["squeez", "llmtrim"],
    markdown: ["squeez", "llmtrim"],
    responses: ["llmtrim"],
    tests: ["squeez", "llmtrim"],
  },
  aggressive: {
    ...RAW_CATEGORIES,
    bash: ["squeez", "llmtrim"],
    code: ["squeez", "llmtrim"],
    conversation: ["llmtrim"],
    json: ["squeez", "llmtrim"],
    markdown: ["squeez", "llmtrim"],
    memory: ["squeez", "llmtrim"],
    responses: ["llmtrim"],
    tests: ["squeez", "llmtrim"],
  },
  off: RAW_CATEGORIES,
};

const capabilityFor = (
  engine: CompressionEngineState,
  category: ContentCategory,
): CompressionCapability | undefined =>
  engine.capabilities.find((capability) => capability.category === category);

const preservesRequiredFields = (capability: CompressionCapability): boolean =>
  capability.safety === "lossless" ||
  REQUIRED_PRESERVATION_FIELDS.every((field) => capability.preserves.includes(field));

const candidateOwners = (
  profile: CompressionProfile,
  category: ContentCategory,
  preference: CompressionOwnerPreference,
): readonly CompressionEngineId[] => {
  if (profile === "off" || preference === "raw") {
    return [];
  }
  return preference === "auto" ? PROFILE_OWNERSHIP_MATRIX[profile][category] : [preference];
};

// Resolve one owner per category while refusing unsafe or already-overlapping lossy claims.
export const resolveCompressionOwnership = (
  config: SzalConfig,
  engineStates: readonly CompressionEngineState[],
): CompressionOwnershipPlan => {
  const engines = new Map(engineStates.map((engine) => [engine.id, engine]));
  const issues: OwnershipIssue[] = [];
  const assignments = CONTENT_CATEGORIES.map((category): OwnershipAssignment => {
    const preference = config.ownership[category];
    const candidates = candidateOwners(config.profile, category, preference);
    const activeLossyOwners = engineStates.filter((engine) => {
      const capability = capabilityFor(engine, category);
      return (
        engine.activeCategories?.includes(category) === true &&
        capability?.safety === "lossy-recoverable"
      );
    });

    if (activeLossyOwners.length > 1) {
      const competingOwners = activeLossyOwners.map((engine) => engine.id);
      const message = `${category} is already claimed by multiple lossy compressors: ${competingOwners.join(", ")}.`;
      issues.push({ category, code: "active-owner-conflict", message, severity: "error" });
      return {
        category,
        competingOwners,
        owner: null,
        reason: message,
        safety: "raw",
        state: "conflict",
      };
    }

    const activeOwner = activeLossyOwners[0];
    const activeCapability =
      activeOwner === undefined ? undefined : capabilityFor(activeOwner, category);
    const activeOwnerAllowed =
      activeOwner !== undefined &&
      candidates.includes(activeOwner.id) &&
      config.engines[activeOwner.id].mode !== "disabled" &&
      activeCapability !== undefined &&
      preservesRequiredFields(activeCapability) &&
      (category !== "cold-storage" || activeCapability.safety === "lossless");
    if (activeOwner !== undefined && !activeOwnerAllowed) {
      const message = `${activeOwner.id} is active for ${category}, but the configured safety policy does not allow it.`;
      issues.push({ category, code: "active-owner-conflict", message, severity: "error" });
      return {
        category,
        competingOwners: [activeOwner.id],
        owner: null,
        reason: message,
        safety: "raw",
        state: "conflict",
      };
    }

    const orderedCandidates =
      activeOwner === undefined
        ? candidates
        : [activeOwner.id, ...candidates.filter((candidate) => candidate !== activeOwner.id)];
    let unsafeCandidate: CompressionEngineId | undefined;
    for (const candidate of orderedCandidates) {
      const engine = engines.get(candidate);
      if (
        engine === undefined ||
        !engine.available ||
        config.engines[candidate].mode === "disabled"
      ) {
        continue;
      }
      const capability = capabilityFor(engine, category);
      if (
        capability === undefined ||
        (category === "cold-storage" && capability.safety !== "lossless") ||
        !preservesRequiredFields(capability)
      ) {
        unsafeCandidate = candidate;
        continue;
      }
      const usedFallback = orderedCandidates[0] !== candidate;
      return {
        category,
        owner: candidate,
        reason: usedFallback
          ? `${orderedCandidates[0] ?? "preferred owner"} unavailable; using safe fallback ${candidate}`
          : `${candidate} owns ${category}`,
        safety: capability.safety,
        state: "active",
      };
    }

    if (unsafeCandidate !== undefined) {
      const message = `${unsafeCandidate} does not provide a safe ${category} capability; using raw content.`;
      issues.push({ category, code: "unsafe-capability", message, severity: "warning" });
      return { category, owner: null, reason: message, safety: "raw", state: "degraded" };
    }

    if (candidates.length > 0) {
      const message = `No configured engine can safely own ${category}; using raw content.`;
      issues.push({ category, code: "owner-unavailable", message, severity: "warning" });
      return { category, owner: null, reason: message, safety: "raw", state: "degraded" };
    }

    return {
      category,
      owner: null,
      reason:
        config.profile === "off"
          ? "off profile requires raw content"
          : preference === "raw"
            ? "configured for raw content"
            : `${config.profile} profile leaves ${category} raw`,
      safety: "raw",
      state: "raw",
    };
  });

  return { assignments, issues, profile: config.profile };
};
