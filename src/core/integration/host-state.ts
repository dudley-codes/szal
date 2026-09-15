import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterIssue,
  CapabilityImportance,
  CapabilityResult,
} from "../adapters/shared.js";

export const HOST_INTEGRATION_STATES = [
  "active",
  "inactive",
  "degraded",
  "unsupported",
  "failed",
] as const;

export type HostIntegrationState = (typeof HOST_INTEGRATION_STATES)[number];

export const HOST_PARITY_CAPABILITIES = [
  "reversible-install",
  "automatic-compression",
  "fail-open",
  "terminal-local-control",
  "local-telemetry",
  "exact-cold-storage",
  "explicit-recall",
  "structured-memory",
  "diagnostics",
  "runtime-indicator",
  "project-isolation",
] as const;

export type HostParityCapabilityName = (typeof HOST_PARITY_CAPABILITIES)[number];

interface HostCapabilityEvidenceBase<Name extends string> {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly importance: CapabilityImportance;
  readonly name: Name;
}

export type HostCapabilityEvidence<Name extends string = string> =
  | (HostCapabilityEvidenceBase<Name> & {
      readonly issue?: never;
      readonly state: "active";
    })
  | (HostCapabilityEvidenceBase<Name> & {
      readonly issue: AdapterIssue;
      readonly state: Exclude<HostIntegrationState, "active">;
    });

export interface HostIntegrationEvidence {
  readonly capabilities: readonly HostCapabilityEvidence[];
}

export interface HostIntegrationProvider {
  readonly descriptor: AdapterDescriptor<"agent">;
  integration: (context: AdapterContext) => Promise<HostIntegrationEvidence>;
}

export type UnavailableHostIntegrationState = "failed" | "inactive" | "unsupported";

const requireUnavailableHostIntegrationState = (
  state: unknown,
): UnavailableHostIntegrationState => {
  if (state !== "failed" && state !== "inactive" && state !== "unsupported") {
    throw new TypeError("An unavailable adapter capability requires an explicit host state.");
  }
  return state;
};

export const mapAdapterCapabilityState = (
  capability: CapabilityResult,
  unavailableState: UnavailableHostIntegrationState,
): HostIntegrationState => {
  if (capability.status === "available") {
    return "active";
  }
  if (capability.status === "degraded") {
    return "degraded";
  }
  return requireUnavailableHostIntegrationState(unavailableState);
};

export interface HostIntegrationReport {
  readonly capabilities: readonly HostCapabilityEvidence[];
  readonly host: AdapterDescriptor<"agent">;
  readonly issues: readonly AdapterIssue[];
  readonly state: HostIntegrationState;
}

export interface ResolveHostIntegrationInput extends HostIntegrationEvidence {
  readonly host: AdapterDescriptor<"agent">;
}

const contractFailure = (
  name: HostParityCapabilityName,
  kind: "duplicate" | "invalid" | "missing",
): HostCapabilityEvidence<HostParityCapabilityName> => {
  const messages = {
    duplicate: `The host adapter reported ${name} more than once.`,
    invalid: `The host adapter reported invalid evidence for ${name}.`,
    missing: `The host adapter did not report ${name}.`,
  } as const;
  return {
    importance: "required",
    issue: {
      code: `host-capability-${kind}`,
      message: messages[kind],
      remediation: "Upgrade or repair the host adapter, then run szal doctor again.",
      retryable: false,
    },
    name,
    state: "failed",
  };
};

const isRequiredParityCapability = (name: string): name is HostParityCapabilityName =>
  (HOST_PARITY_CAPABILITIES as readonly string[]).includes(name);

const isValidEvidence = (evidence: {
  readonly issue?: unknown;
  readonly state: unknown;
}): boolean =>
  typeof evidence.state === "string" &&
  (HOST_INTEGRATION_STATES as readonly string[]).includes(evidence.state) &&
  (evidence.state === "active" ? evidence.issue === undefined : evidence.issue !== undefined);

const normalizeCapabilities = (
  evidence: readonly HostCapabilityEvidence[],
): {
  capabilities: readonly HostCapabilityEvidence[];
  issues: readonly AdapterIssue[];
} => {
  const required = HOST_PARITY_CAPABILITIES.map((name) => {
    const matches = evidence.filter((capability) => capability.name === name);
    if (matches.length === 0) {
      return contractFailure(name, "missing");
    }
    if (matches.length > 1) {
      return contractFailure(name, "duplicate");
    }
    const match = matches[0];
    return match?.importance === "required" && isValidEvidence(match)
      ? { ...match }
      : contractFailure(name, "invalid");
  });
  const extensions = evidence
    .filter((capability) => !isRequiredParityCapability(capability.name))
    .map((capability): HostCapabilityEvidence =>
      isValidEvidence(capability)
        ? { ...capability }
        : {
            importance: capability.importance,
            issue: {
              code: "host-capability-invalid",
              message: `The host adapter reported invalid evidence for ${capability.name}.`,
              remediation: "Upgrade or repair the host adapter, then run szal doctor again.",
              retryable: false,
            },
            name: capability.name,
            state: "degraded",
          },
    );
  const issues = extensions.map((capability) => ({
    code: "host-capability-unknown",
    message: `The host adapter reported unknown capability ${capability.name}.`,
    remediation: "Upgrade Szal if this capability is expected, then run szal doctor again.",
    retryable: false,
  }));
  return { capabilities: [...required, ...extensions], issues };
};

const aggregateRequiredCapabilities = (
  capabilities: readonly HostCapabilityEvidence[],
): HostIntegrationState => {
  const required = capabilities.filter((capability) => isRequiredParityCapability(capability.name));
  if (required.some((capability) => capability.state === "failed")) {
    return "failed";
  }
  for (const state of ["active", "inactive", "unsupported"] as const) {
    if (required.every((capability) => capability.state === state)) {
      return state;
    }
  }
  return "degraded";
};

const uniqueIssues = (issues: readonly AdapterIssue[]): readonly AdapterIssue[] => {
  const unique = new Map<string, AdapterIssue>();
  for (const issue of issues) {
    const key = [issue.code, issue.message, issue.remediation ?? "", String(issue.retryable)].join(
      "\u0000",
    );
    if (!unique.has(key)) {
      unique.set(key, { ...issue });
    }
  }
  return [...unique.values()];
};

export const resolveHostIntegration = (
  input: ResolveHostIntegrationInput,
): HostIntegrationReport => {
  const normalized = normalizeCapabilities(input.capabilities);
  const state = aggregateRequiredCapabilities(normalized.capabilities);
  return {
    capabilities: normalized.capabilities,
    host: { ...input.host },
    issues: uniqueIssues([
      ...normalized.capabilities.flatMap((capability) =>
        capability.issue === undefined ? [] : [capability.issue],
      ),
      ...normalized.issues,
    ]),
    state: normalized.issues.length > 0 && state !== "failed" ? "degraded" : state,
  };
};

const failedInspectionEvidence = (): HostIntegrationEvidence => {
  const issue: AdapterIssue = {
    code: "host-inspection-failed",
    message: "The host integration could not be inspected safely.",
    remediation: "Check the host installation and permissions, then run szal doctor again.",
    retryable: true,
  };
  return {
    capabilities: HOST_PARITY_CAPABILITIES.map((name) => ({
      importance: "required",
      issue,
      name,
      state: "failed",
    })),
  };
};

export const inspectHostIntegrations = async (
  providers: readonly HostIntegrationProvider[],
  context: AdapterContext,
): Promise<readonly HostIntegrationReport[]> =>
  Promise.all(
    providers.map(async (provider) => {
      try {
        return resolveHostIntegration({
          ...(await provider.integration(context)),
          host: provider.descriptor,
        });
      } catch {
        return resolveHostIntegration({
          ...failedInspectionEvidence(),
          host: provider.descriptor,
        });
      }
    }),
  );
