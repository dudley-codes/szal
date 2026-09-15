import assert from "node:assert/strict";

import {
  HOST_INTEGRATION_STATES,
  HOST_PARITY_CAPABILITIES,
  inspectHostIntegrations,
} from "szal/integration";

export const parityEvidence = (details = {}) =>
  HOST_PARITY_CAPABILITIES.map((name) => ({
    details,
    importance: "required",
    name,
    state: "active",
  }));

export const assertHostIntegrationConformance = async (provider, context) => {
  const [report] = await inspectHostIntegrations([provider], context);
  assert.ok(report);
  assert.ok(HOST_INTEGRATION_STATES.includes(report.state));
  assert.deepEqual(
    report.capabilities.slice(0, HOST_PARITY_CAPABILITIES.length).map(({ name }) => name),
    HOST_PARITY_CAPABILITIES,
  );
  for (const capability of report.capabilities) {
    assert.ok(HOST_INTEGRATION_STATES.includes(capability.state));
    if (capability.state !== "active") {
      assert.ok(capability.issue);
    }
  }
  assert.equal(
    new Set(report.capabilities.map(({ name }) => name)).size,
    report.capabilities.length,
  );
  return report;
};
