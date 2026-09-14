export const COMPRESSION_PROFILES = ["safe", "balanced", "aggressive", "off"] as const;

export const ENGINE_MODES = ["auto", "enabled", "disabled"] as const;

export const CONTENT_CATEGORIES = [
  "conversation",
  "code",
  "bash",
  "tests",
  "json",
  "markdown",
  "memory",
  "cold-storage",
  "responses",
] as const;

export const COMPRESSION_OWNERS = ["auto", "raw", "llmtrim", "squeez"] as const;

export type CompressionProfile = (typeof COMPRESSION_PROFILES)[number];
export type EngineMode = (typeof ENGINE_MODES)[number];
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];
export type CompressionOwnerPreference = (typeof COMPRESSION_OWNERS)[number];

export interface EngineConfig {
  [key: string]: unknown;
  mode: EngineMode;
}

export interface SzalConfig {
  [key: string]: unknown;
  coldStorage: {
    [key: string]: unknown;
    enabled: boolean;
    maxBytes: number;
  };
  engines: {
    [key: string]: unknown;
    llmtrim: EngineConfig;
    squeez: EngineConfig;
  };
  memory: {
    [key: string]: unknown;
    enabled: boolean;
    maxItems: number;
  };
  modelWindows: Record<string, number>;
  ownership: Record<ContentCategory, CompressionOwnerPreference>;
  profile: CompressionProfile;
  retention: {
    [key: string]: unknown;
    coldStorageDays: number;
    telemetryDays: number;
  };
  schemaVersion: 1;
  stats: {
    [key: string]: unknown;
    enabled: boolean;
  };
}

export interface LoadedConfig {
  config: SzalConfig;
  exists: boolean;
  path: string;
}

export const DEFAULT_CONFIG: SzalConfig = {
  coldStorage: {
    enabled: true,
    maxBytes: 1_073_741_824,
  },
  engines: {
    llmtrim: { mode: "auto" },
    squeez: { mode: "auto" },
  },
  memory: {
    enabled: true,
    maxItems: 10_000,
  },
  modelWindows: {},
  ownership: {
    bash: "auto",
    code: "auto",
    "cold-storage": "raw",
    conversation: "auto",
    json: "auto",
    markdown: "auto",
    memory: "auto",
    responses: "auto",
    tests: "auto",
  },
  profile: "balanced",
  retention: {
    coldStorageDays: 30,
    telemetryDays: 90,
  },
  schemaVersion: 1,
  stats: {
    enabled: true,
  },
};
