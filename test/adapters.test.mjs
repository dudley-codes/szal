import assert from "node:assert/strict";
import test from "node:test";

import { availableCapability, degradedCapability, unavailableCapability } from "szal/adapters";

const MISSING_EXECUTABLE = {
  code: "executable-not-found",
  message: "The executable is not on PATH.",
  retryable: false,
};

// Exercise every agent operation so representative adapters remain substitutable at the boundary.
const runAgentContract = async (adapter) => {
  assert.equal(adapter.descriptor.kind, "agent");
  assert.ok(adapter.descriptor.id.length > 0);

  const context = { environment: {}, homeDirectory: "/home/tester" };
  const detection = await adapter.detect(context);
  const version = await adapter.version(context);
  const capabilities = await adapter.capabilities(context);
  const health = await adapter.health(context);
  const install = await adapter.install(context, { profile: "balanced" });
  const configure = await adapter.configure(context, { profile: "balanced" });
  const disable = await adapter.disable(context);

  assert.equal(detection.status, "available");
  assert.equal(version.status, "available");
  assert.equal(version.version, "1.2.3");
  assert.deepEqual(capabilities, [
    availableCapability("session-lifecycle", "required", { hooks: ["start", "stop"] }),
    degradedCapability("compaction-lifecycle", "optional", {
      code: "post-compact-hook-missing",
      message: "Only the pre-compaction hook is supported.",
      retryable: false,
    }),
  ]);
  assert.equal(health.status, "degraded");
  assert.equal(install.status, "succeeded");
  assert.equal(configure.status, "succeeded");
  assert.equal(disable.status, "succeeded");
};

test("an agent adapter implements the complete lifecycle contract", async () => {
  const agent = {
    descriptor: { id: "representative-agent", kind: "agent", name: "Representative agent" },
    detect: async () => ({ status: "available", details: { executablePath: "/bin/agent" } }),
    version: async () => ({ status: "available", version: "1.2.3" }),
    capabilities: async () => [
      availableCapability("session-lifecycle", "required", { hooks: ["start", "stop"] }),
      degradedCapability("compaction-lifecycle", "optional", {
        code: "post-compact-hook-missing",
        message: "Only the pre-compaction hook is supported.",
        retryable: false,
      }),
    ],
    health: async () => ({
      issues: [
        {
          code: "post-compact-hook-missing",
          message: "Only the pre-compaction hook is supported.",
          retryable: false,
        },
      ],
      status: "degraded",
    }),
    install: async () => ({ changed: true, requiresRestart: true, status: "succeeded" }),
    configure: async () => ({ changed: false, requiresRestart: false, status: "succeeded" }),
    disable: async () => ({ changed: true, requiresRestart: true, status: "succeeded" }),
  };

  await runAgentContract(agent);
});

test("an unavailable optional engine does not block an available engine", async () => {
  const unavailableEngine = {
    descriptor: { id: "optional-engine", kind: "compression-engine", name: "Optional engine" },
    detect: async () => ({ issue: MISSING_EXECUTABLE, status: "unavailable" }),
    version: async () => ({ issue: MISSING_EXECUTABLE, status: "unavailable" }),
    capabilities: async () => [
      unavailableCapability("code-compression", "optional", MISSING_EXECUTABLE),
    ],
    health: async () => ({ issues: [MISSING_EXECUTABLE], status: "unavailable" }),
    install: async () => ({ changed: false, issue: MISSING_EXECUTABLE, status: "skipped" }),
    configure: async () => ({ changed: false, issue: MISSING_EXECUTABLE, status: "skipped" }),
    disable: async () => ({ changed: false, status: "succeeded" }),
  };
  const availableEngine = {
    descriptor: { id: "primary-engine", kind: "compression-engine", name: "Primary engine" },
    detect: async () => ({ status: "available" }),
    version: async () => ({ status: "available", version: "4.5.6" }),
    capabilities: async () => [availableCapability("request-compression", "required")],
    health: async () => ({ issues: [], status: "healthy" }),
    install: async () => ({ changed: false, requiresRestart: false, status: "succeeded" }),
    configure: async () => ({ changed: false, requiresRestart: false, status: "succeeded" }),
    disable: async () => ({ changed: false, status: "succeeded" }),
  };

  const [missingDetection, availableDetection] = await Promise.all([
    unavailableEngine.detect({ environment: {}, homeDirectory: "/home/tester" }),
    availableEngine.detect({ environment: {}, homeDirectory: "/home/tester" }),
  ]);
  const [missingCapabilities, availableCapabilities] = await Promise.all([
    unavailableEngine.capabilities({ environment: {}, homeDirectory: "/home/tester" }),
    availableEngine.capabilities({ environment: {}, homeDirectory: "/home/tester" }),
  ]);

  assert.equal(missingDetection.status, "unavailable");
  assert.equal(missingDetection.issue.code, "executable-not-found");
  assert.equal(availableDetection.status, "available");
  assert.equal(missingCapabilities[0].status, "unavailable");
  assert.equal(missingCapabilities[0].importance, "optional");
  assert.equal(availableCapabilities[0].status, "available");
  assert.equal(availableCapabilities[0].name, "request-compression");
});
