import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterDetection,
  AdapterHealth,
  AdapterOperationResult,
  AdapterVersion,
  CapabilityResult,
} from "./shared.js";

export const AGENT_CAPABILITIES = [
  "session-lifecycle",
  "prompt-lifecycle",
  "tool-lifecycle",
  "subagent-lifecycle",
  "compaction-lifecycle",
  "usage-metadata",
  "transport-configuration",
  "input-rewrite",
  "output-rewrite",
] as const;

export type AgentCapabilityName = (typeof AGENT_CAPABILITIES)[number];

export interface AgentAdapter<
  InstallRequest = unknown,
  ConfigureRequest = unknown,
  DetectionDetails = unknown,
  CapabilityName extends string = AgentCapabilityName,
  CapabilityDetails = unknown,
> {
  readonly descriptor: AdapterDescriptor<"agent">;
  capabilities: (
    context: AdapterContext,
  ) => Promise<readonly CapabilityResult<CapabilityName, CapabilityDetails>[]>;
  configure: (
    context: AdapterContext,
    request: ConfigureRequest,
  ) => Promise<AdapterOperationResult>;
  detect: (context: AdapterContext) => Promise<AdapterDetection<DetectionDetails>>;
  disable: (context: AdapterContext) => Promise<AdapterOperationResult>;
  health: (context: AdapterContext) => Promise<AdapterHealth>;
  install: (context: AdapterContext, request: InstallRequest) => Promise<AdapterOperationResult>;
  version: (context: AdapterContext) => Promise<AdapterVersion>;
}
