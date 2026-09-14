import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterDetection,
  AdapterHealth,
  AdapterOperationResult,
  AdapterVersion,
  CapabilityResult,
} from "./shared.js";

export const COMPRESSION_ENGINE_CAPABILITIES = [
  "request-compression",
  "request-recovery",
  "pass-through-measurement",
  "conversation-compression",
  "code-compression",
  "bash-compression",
  "test-compression",
  "json-compression",
  "markdown-compression",
  "memory-compression",
  "cold-storage-compression",
  "response-compression",
] as const;

export type CompressionEngineCapabilityName = (typeof COMPRESSION_ENGINE_CAPABILITIES)[number];

export interface CompressionEngineAdapter<
  InstallRequest = unknown,
  ConfigureRequest = unknown,
  DetectionDetails = unknown,
  CapabilityName extends string = CompressionEngineCapabilityName,
  CapabilityDetails = unknown,
> {
  readonly descriptor: AdapterDescriptor<"compression-engine">;
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
