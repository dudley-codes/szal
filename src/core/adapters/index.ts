export { AGENT_CAPABILITIES, type AgentAdapter, type AgentCapabilityName } from "./agent.js";
export {
  COMPRESSION_ENGINE_CAPABILITIES,
  type CompressionEngineAdapter,
  type CompressionEngineCapabilityName,
} from "./compression-engine.js";
export {
  availableCapability,
  degradedCapability,
  unavailableCapability,
  type AdapterContext,
  type AdapterDescriptor,
  type AdapterDetection,
  type AdapterHealth,
  type AdapterHealthStatus,
  type AdapterIssue,
  type AdapterKind,
  type AdapterOperationResult,
  type AdapterVersion,
  type AvailableCapability,
  type CapabilityImportance,
  type CapabilityResult,
  type DegradedCapability,
  type UnavailableCapability,
} from "./shared.js";
