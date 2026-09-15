import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHostIntegrationConformance,
  parityEvidence,
} from "./fixtures/host-integration-contract.mjs";
import {
  HOST_INTEGRATION_STATES,
  HOST_PARITY_CAPABILITIES,
  inspectHostIntegrations,
  mapAdapterCapabilityState,
  resolveHostIntegration,
} from "szal/integration";

const HOST = {
  id: "representative-host",
  kind: "agent",
  name: "Representative host",
};

const activeEvidence = () =>
  HOST_PARITY_CAPABILITIES.map((name) => ({
    importance: "required",
    name,
    state: "active",
  }));

test("the shared parity contract reports a fully active host", () => {
  assert.deepEqual(HOST_INTEGRATION_STATES, [
    "active",
    "inactive",
    "degraded",
    "unsupported",
    "failed",
  ]);
  assert.deepEqual(HOST_PARITY_CAPABILITIES, [
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
  ]);

  const report = resolveHostIntegration({ capabilities: activeEvidence(), host: HOST });

  assert.equal(report.state, "active");
  assert.deepEqual(
    report.capabilities.map(({ name, state }) => ({ name, state })),
    HOST_PARITY_CAPABILITIES.map((name) => ({ name, state: "active" })),
  );
  assert.deepEqual(report.host, HOST);
  assert.deepEqual(report.issues, []);
});

test("a uniformly inactive or unsupported host keeps that canonical state", () => {
  for (const state of ["inactive", "unsupported"]) {
    const capabilities = activeEvidence().map((capability) => ({
      ...capability,
      issue: {
        code: `host-${state}`,
        message: `The host is ${state}.`,
        retryable: state === "inactive",
      },
      state,
    }));

    const report = resolveHostIntegration({ capabilities, host: HOST });
    assert.equal(report.state, state);
    assert.equal(report.issues.length, 1);
  }
});

test("one degraded required capability preserves unrelated active checks", () => {
  const capabilities = activeEvidence();
  capabilities[2] = {
    ...capabilities[2],
    issue: {
      code: "fail-open-unverified",
      message: "Fail-open behavior could not be verified.",
      remediation: "Run the host verification command.",
      retryable: true,
    },
    state: "degraded",
  };

  const report = resolveHostIntegration({ capabilities, host: HOST });

  assert.equal(report.state, "degraded");
  assert.equal(report.capabilities[1].state, "active");
  assert.equal(report.capabilities[2].state, "degraded");
  assert.equal(report.capabilities[3].state, "active");
  assert.equal(report.issues[0].code, "fail-open-unverified");
});

test("missing and duplicate required evidence becomes a failed contract report", () => {
  const capabilities = activeEvidence();
  capabilities.pop();
  capabilities.push({ ...capabilities[0] });

  const report = resolveHostIntegration({ capabilities, host: HOST });

  assert.equal(report.state, "failed");
  assert.equal(report.capabilities.length, HOST_PARITY_CAPABILITIES.length);
  assert.equal(report.capabilities[0].state, "failed");
  assert.equal(report.capabilities.at(-1).state, "failed");
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ["host-capability-duplicate", "host-capability-missing"],
  );
});

test("malformed evidence fails its capability without leaking an unknown state", () => {
  const capabilities = activeEvidence();
  capabilities[0] = { ...capabilities[0], state: "mystery" };
  capabilities[1] = { ...capabilities[1], state: "degraded" };

  const report = resolveHostIntegration({ capabilities, host: HOST });

  assert.equal(report.state, "failed");
  assert.deepEqual(
    report.capabilities.slice(0, 2).map(({ state }) => state),
    ["failed", "failed"],
  );
  assert.deepEqual(
    report.issues.slice(0, 2).map(({ code }) => code),
    ["host-capability-invalid", "host-capability-invalid"],
  );
});

test("adapter capability availability maps explicitly into host states", () => {
  assert.equal(
    mapAdapterCapabilityState(
      { importance: "required", name: "surface", status: "available" },
      "failed",
    ),
    "active",
  );
  assert.equal(
    mapAdapterCapabilityState(
      {
        importance: "required",
        issue: { code: "partial", message: "Partial support.", retryable: false },
        name: "surface",
        status: "degraded",
      },
      "failed",
    ),
    "degraded",
  );
  const unavailable = {
    importance: "required",
    issue: { code: "missing", message: "Unavailable.", retryable: false },
    name: "surface",
    status: "unavailable",
  };
  assert.throws(() => mapAdapterCapabilityState(unavailable), /requires an explicit host state/);
  for (const unavailableState of ["inactive", "unsupported", "failed"]) {
    assert.equal(mapAdapterCapabilityState(unavailable, unavailableState), unavailableState);
  }
});

test("one failed host inspection does not hide unrelated host results", async () => {
  const context = { environment: {}, homeDirectory: "/home/tester" };
  const reports = await inspectHostIntegrations(
    [
      {
        descriptor: HOST,
        integration: async () => ({ capabilities: activeEvidence() }),
      },
      {
        descriptor: { id: "broken", kind: "agent", name: "Broken host" },
        integration: async () => {
          throw new Error("secret-token-value");
        },
      },
    ],
    context,
  );

  assert.deepEqual(
    reports.map(({ host, state }) => ({ host: host.id, state })),
    [
      { host: "representative-host", state: "active" },
      { host: "broken", state: "failed" },
    ],
  );
  assert.equal(reports[1].issues[0].code, "host-inspection-failed");
  assert.doesNotMatch(JSON.stringify(reports), /secret-token-value/);
});

test("different host mechanisms conform to the same parity contract", async () => {
  const context = { environment: {}, homeDirectory: "/home/tester" };
  const providers = [
    {
      descriptor: { id: "claude-style", kind: "agent", name: "Claude-style host" },
      integration: async () => ({ capabilities: parityEvidence({ mechanism: "hooks-proxy" }) }),
    },
    {
      descriptor: { id: "pi-style", kind: "agent", name: "Pi-style host" },
      integration: async () => ({
        capabilities: parityEvidence({ mechanism: "extension-events" }),
      }),
    },
  ];

  const reports = await Promise.all(
    providers.map((provider) => assertHostIntegrationConformance(provider, context)),
  );

  assert.deepEqual(
    reports.map((report) =>
      report.capabilities.map(({ importance, name, state }) => ({ importance, name, state })),
    ),
    [activeEvidence(), activeEvidence()],
  );
});

test("malformed unknown evidence is retained safely with a canonical state", () => {
  const report = resolveHostIntegration({
    capabilities: [
      ...activeEvidence(),
      { importance: "optional", name: "future-host-surface", state: "mystery" },
    ],
    host: HOST,
  });

  assert.equal(report.state, "degraded");
  assert.equal(report.capabilities.at(-1).state, "degraded");
  assert.deepEqual(
    report.issues.slice(-2).map(({ code }) => code),
    ["host-capability-invalid", "host-capability-unknown"],
  );
});

test("an unknown failed capability cannot fail the recognized contract", () => {
  const report = resolveHostIntegration({
    capabilities: [
      ...activeEvidence(),
      {
        importance: "required",
        issue: { code: "future-failed", message: "Future failure.", retryable: false },
        name: "future-host-surface",
        state: "failed",
      },
    ],
    host: HOST,
  });

  assert.equal(report.state, "degraded");
  assert.equal(report.capabilities.at(-1).state, "failed");
});

test("an unknown optional capability degrades only its host", () => {
  const capabilities = [
    ...activeEvidence(),
    {
      importance: "optional",
      name: "future-host-surface",
      state: "active",
    },
  ];

  const report = resolveHostIntegration({ capabilities, host: HOST });

  assert.equal(report.state, "degraded");
  assert.deepEqual(report.capabilities.at(-1), {
    importance: "optional",
    name: "future-host-surface",
    state: "active",
  });
  assert.equal(report.issues.at(-1).code, "host-capability-unknown");
});
