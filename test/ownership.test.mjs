import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_PRESERVATION_FIELDS,
  resolveCompressionOwnership,
} from "../dist/core/compression/index.js";
import { DEFAULT_CONFIG, setConfigValue } from "../dist/core/config/index.js";

const capability = (category, safety = "lossy-recoverable") => ({
  category,
  preserves: REQUIRED_PRESERVATION_FIELDS,
  safety,
});

const standardEngines = [
  {
    available: true,
    capabilities: [capability("conversation"), capability("responses")],
    id: "llmtrim",
  },
  {
    available: true,
    capabilities: ["code", "bash", "tests", "json", "markdown", "memory"].map((category) =>
      capability(category),
    ),
    id: "squeez",
  },
];

const owners = (profile, engines = standardEngines) => {
  const config = setConfigValue(DEFAULT_CONFIG, "profile", profile);
  const plan = resolveCompressionOwnership(config, engines);
  return Object.fromEntries(
    plan.assignments.map((assignment) => [assignment.category, assignment]),
  );
};

test("ownership profiles activate only their intended non-overlapping categories", () => {
  const safe = owners("safe");
  assert.equal(safe.conversation.owner, "llmtrim");
  assert.equal(safe.bash.owner, "squeez");
  assert.equal(safe.tests.owner, "squeez");
  assert.equal(safe.json.owner, "squeez");
  assert.equal(safe.code.owner, null);
  assert.equal(safe.markdown.owner, null);
  assert.equal(safe.memory.owner, null);

  const balanced = owners("balanced");
  assert.equal(balanced.conversation.owner, "llmtrim");
  assert.equal(balanced.responses.owner, "llmtrim");
  for (const category of ["code", "bash", "tests", "json", "markdown"]) {
    assert.equal(balanced[category].owner, "squeez");
  }
  assert.equal(balanced.memory.owner, null);

  const aggressive = owners("aggressive");
  assert.equal(aggressive.memory.owner, "squeez");

  const off = owners("off");
  assert.ok(Object.values(off).every((assignment) => assignment.owner === null));
  assert.ok(Object.values(off).every((assignment) => assignment.state === "raw"));
});

test("missing squeez falls back only to an engine that declares the category safe", () => {
  const fallbackEngines = [
    {
      available: true,
      capabilities: [capability("conversation"), capability("code"), capability("responses")],
      id: "llmtrim",
    },
    { available: false, capabilities: [], id: "squeez" },
  ];
  const balanced = owners("balanced", fallbackEngines);

  assert.equal(balanced.code.owner, "llmtrim");
  assert.match(balanced.code.reason, /fallback llmtrim/);
  assert.equal(balanced.bash.owner, null);
  assert.equal(balanced.bash.state, "degraded");
});

test("overlapping active lossy compressors are rejected instead of selecting either", () => {
  const overlappingEngines = standardEngines.map((engine) => ({
    ...engine,
    activeCategories: ["bash"],
    capabilities: [...engine.capabilities, capability("bash")],
  }));
  const config = setConfigValue(DEFAULT_CONFIG, "profile", "balanced");
  const plan = resolveCompressionOwnership(config, overlappingEngines);
  const bash = plan.assignments.find((assignment) => assignment.category === "bash");

  assert.equal(bash.state, "conflict");
  assert.equal(bash.owner, null);
  assert.deepEqual(bash.competingOwners, ["llmtrim", "squeez"]);
  assert.ok(plan.issues.some((issue) => issue.code === "active-owner-conflict"));
  assert.ok(
    plan.assignments.every(
      (assignment) => assignment.owner === null || !Array.isArray(assignment.owner),
    ),
  );
});

test("an active lossy compressor that violates the off profile fails closed", () => {
  const config = setConfigValue(DEFAULT_CONFIG, "profile", "off");
  const plan = resolveCompressionOwnership(config, [
    {
      activeCategories: ["bash"],
      available: true,
      capabilities: [capability("bash")],
      id: "squeez",
    },
  ]);
  const bash = plan.assignments.find((assignment) => assignment.category === "bash");

  assert.equal(bash.owner, null);
  assert.equal(bash.state, "conflict");
  assert.equal(plan.issues.find((issue) => issue.category === "bash").severity, "error");
});

test("lossy owners must declare every required preservation field", () => {
  const config = setConfigValue(DEFAULT_CONFIG, "ownership.code", "squeez");
  const plan = resolveCompressionOwnership(config, [
    { available: false, capabilities: [], id: "llmtrim" },
    {
      available: true,
      capabilities: [{ category: "code", preserves: ["paths"], safety: "lossy-recoverable" }],
      id: "squeez",
    },
  ]);
  const code = plan.assignments.find((assignment) => assignment.category === "code");

  assert.equal(code.owner, null);
  assert.equal(code.state, "degraded");
  assert.ok(plan.issues.some((issue) => issue.code === "unsafe-capability"));
});

test("cold storage stays raw unless an explicitly selected owner is lossless", () => {
  const losslessSqueez = {
    available: true,
    capabilities: [capability("cold-storage", "lossless")],
    id: "squeez",
  };
  const defaults = resolveCompressionOwnership(DEFAULT_CONFIG, [losslessSqueez]);
  assert.equal(
    defaults.assignments.find((assignment) => assignment.category === "cold-storage").owner,
    null,
  );

  const explicit = setConfigValue(DEFAULT_CONFIG, "ownership.cold-storage", "squeez");
  const enabled = resolveCompressionOwnership(explicit, [losslessSqueez]);
  const coldStorage = enabled.assignments.find(
    (assignment) => assignment.category === "cold-storage",
  );
  assert.equal(coldStorage.owner, "squeez");
  assert.equal(coldStorage.safety, "lossless");
});
