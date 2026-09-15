import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertHostIntegrationConformance,
  parityEvidence,
} from "./fixtures/host-integration-contract.mjs";
import {
  MINIMUM_SAFE_SQUEEZ_VERSION,
  availableCapability,
  createSqueezAdapter,
  degradedCapability,
  unavailableCapability,
} from "szal/adapters";

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
    integration: async () => ({ capabilities: parityEvidence({ mechanism: "representative" }) }),
    configure: async () => ({ changed: false, requiresRestart: false, status: "succeeded" }),
    disable: async () => ({ changed: true, requiresRestart: true, status: "succeeded" }),
  };

  await runAgentContract(agent);
  const report = await assertHostIntegrationConformance(agent, {
    environment: {},
    homeDirectory: "/home/tester",
  });
  assert.equal(report.state, "active");
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

const createSqueezFixture = (version) => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-squeez-"));
  const binDirectory = join(homeDirectory, "bin");
  const executablePath = join(binDirectory, "squeez");
  mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(executablePath, `#!/bin/sh\nprintf 'squeez ${version}\\n'\n`);
  chmodSync(executablePath, 0o700);
  return { binDirectory, executablePath, homeDirectory };
};

test("the squeez adapter detects its version, hosts, and safe capability ceiling", async () => {
  const fixture = createSqueezFixture(MINIMUM_SAFE_SQUEEZ_VERSION);
  const adapter = createSqueezAdapter();
  const context = {
    environment: { PATH: fixture.binDirectory },
    homeDirectory: fixture.homeDirectory,
  };

  try {
    const detection = await adapter.detect(context);
    const capabilities = await adapter.capabilities(context);
    const health = await adapter.health(context);

    assert.equal(detection.status, "available");
    assert.equal(detection.details.executablePath, fixture.executablePath);
    assert.equal(detection.details.version, MINIMUM_SAFE_SQUEEZ_VERSION);
    assert.equal(detection.details.ownershipSafe, true);
    assert.deepEqual(detection.details.detectedHosts, ["codex"]);
    assert.equal(health.status, "healthy");
    assert.equal(
      capabilities.find((capability) => capability.name === "bash-compression").status,
      "available",
    );
    assert.equal(
      capabilities.find((capability) => capability.name === "conversation-compression").status,
      "unavailable",
    );
    assert.equal(
      capabilities.find((capability) => capability.name === "response-compression").status,
      "unavailable",
    );
  } finally {
    rmSync(fixture.homeDirectory, { force: true, recursive: true });
  }
});

test("an old squeez version is detected but cannot receive lossy ownership", async () => {
  const fixture = createSqueezFixture("1.45.9");
  const adapter = createSqueezAdapter();
  const context = {
    environment: { PATH: fixture.binDirectory },
    homeDirectory: fixture.homeDirectory,
  };

  try {
    const detection = await adapter.detect(context);
    const capabilities = await adapter.capabilities(context);
    const health = await adapter.health(context);
    assert.equal(detection.status, "available");
    assert.equal(detection.details.ownershipSafe, false);
    assert.equal(health.status, "degraded");
    assert.equal(
      capabilities.find((capability) => capability.name === "bash-compression").status,
      "degraded",
    );
  } finally {
    rmSync(fixture.homeDirectory, { force: true, recursive: true });
  }
});
