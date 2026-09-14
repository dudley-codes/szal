export type AdapterKind = "agent" | "compression-engine";

export interface AdapterContext {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  projectDirectory?: string;
}

export interface AdapterDescriptor<Kind extends AdapterKind> {
  id: string;
  kind: Kind;
  name: string;
}

export interface AdapterIssue {
  code: string;
  message: string;
  remediation?: string;
  retryable: boolean;
}

export type AdapterDetection<Details = unknown> =
  { details?: Details; status: "available" } | { issue: AdapterIssue; status: "unavailable" };

export type AdapterVersion =
  { status: "available"; version: string } | { issue: AdapterIssue; status: "unavailable" };

export type CapabilityImportance = "optional" | "required";

export interface AvailableCapability<Name extends string = string, Details = unknown> {
  details?: Details;
  importance: CapabilityImportance;
  name: Name;
  status: "available";
}

export interface DegradedCapability<Name extends string = string, Details = unknown> {
  details?: Details;
  importance: CapabilityImportance;
  issue: AdapterIssue;
  name: Name;
  status: "degraded";
}

export interface UnavailableCapability<Name extends string = string> {
  importance: CapabilityImportance;
  issue: AdapterIssue;
  name: Name;
  status: "unavailable";
}

export type CapabilityResult<Name extends string = string, Details = unknown> =
  | AvailableCapability<Name, Details>
  | DegradedCapability<Name, Details>
  | UnavailableCapability<Name>;

export type AdapterHealthStatus = "degraded" | "failed" | "healthy" | "unavailable";

export interface AdapterHealth {
  issues: readonly AdapterIssue[];
  status: AdapterHealthStatus;
}

export type AdapterOperationResult<Details = unknown> =
  | {
      changed: boolean;
      details?: Details;
      requiresRestart?: boolean;
      status: "succeeded";
    }
  | {
      changed: false;
      issue: AdapterIssue;
      status: "skipped";
    }
  | {
      changed: boolean;
      issue: AdapterIssue;
      rolledBack: boolean;
      status: "failed";
    };

// Construct a capability without emitting an undefined details field in JSON output.
export const availableCapability = <Name extends string, Details = undefined>(
  name: Name,
  importance: CapabilityImportance,
  details?: Details,
): AvailableCapability<Name, Details> => ({
  ...(details === undefined ? {} : { details }),
  importance,
  name,
  status: "available",
});

// Preserve a machine-readable limitation while keeping partially supported behavior explicit.
export const degradedCapability = <Name extends string, Details = undefined>(
  name: Name,
  importance: CapabilityImportance,
  issue: AdapterIssue,
  details?: Details,
): DegradedCapability<Name, Details> => ({
  ...(details === undefined ? {} : { details }),
  importance,
  issue,
  name,
  status: "degraded",
});

export const unavailableCapability = <Name extends string>(
  name: Name,
  importance: CapabilityImportance,
  issue: AdapterIssue,
): UnavailableCapability<Name> => ({
  importance,
  issue,
  name,
  status: "unavailable",
});
