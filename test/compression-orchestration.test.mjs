import assert from "node:assert/strict";
import test from "node:test";

import {
  executeCompression,
  resolveRuntimeOwner,
  shouldCompress,
} from "../dist/core/compression/index.js";

const largeInput = {
  category: "bash",
  content: "0123456789abcdef".repeat(400),
  source: "test",
};

const policy = {
  eligibleCategories: ["bash", "code", "json", "markdown", "memory", "tests"],
  minBytes: 32,
  minEstimatedTokens: 8,
};

const decisionFor = (input = largeInput, owners = ["szal-pi"]) =>
  shouldCompress(input, resolveRuntimeOwner(input.category, owners), policy);

test("below-threshold content passes through with equal measurement", async () => {
  const input = { category: "bash", content: "short", source: "test" };
  const decision = decisionFor(input);
  let called = false;

  const result = await executeCompression(input, decision, () => {
    called = true;
    return "compressed";
  });

  assert.equal(called, false);
  assert.equal(result.content, input.content);
  assert.equal(result.compressed, false);
  assert.equal(result.decision.reasonCode, "below-threshold");
  assert.equal(result.measurement.rawBytes, result.measurement.compressedBytes);
  assert.equal(result.measurement.rawTokens, result.measurement.compressedTokens);
  assert.equal(result.measurement.failedOpen, false);
});

test("eligible content is compressed by exactly one owner", async () => {
  const decision = decisionFor();
  let calls = 0;

  const result = await executeCompression(largeInput, decision, () => {
    calls += 1;
    return "small";
  });

  assert.equal(calls, 1);
  assert.equal(result.content, "small");
  assert.equal(result.compressed, true);
  assert.equal(result.decision.reasonCode, "compressed");
  assert.equal(result.measurement.owner, "szal-pi");
  assert.equal(result.measurement.rawBytes, Buffer.byteLength(largeInput.content, "utf8"));
  assert.equal(result.measurement.compressedBytes, 5);
});

test("duplicate non-raw owners fail open before invoking compressor", async () => {
  const decision = decisionFor(largeInput, ["szal-pi", "szal-pi"]);
  let called = false;

  const result = await executeCompression(largeInput, decision, () => {
    called = true;
    return "small";
  });

  assert.equal(called, false);
  assert.equal(result.content, largeInput.content);
  assert.equal(result.compressed, false);
  assert.equal(result.decision.reasonCode, "owner-conflict");
  assert.deepEqual(result.decision.competingOwners, ["szal-pi", "szal-pi"]);
  assert.equal(result.measurement.failedOpen, true);
});

test("compressor errors fail open byte-for-byte", async () => {
  const result = await executeCompression(largeInput, decisionFor(), () => {
    throw new Error("boom");
  });

  assert.equal(result.content, largeInput.content);
  assert.equal(result.compressed, false);
  assert.equal(result.decision.reasonCode, "compressor-error");
  assert.equal(result.measurement.reasonCode, "compressor-error");
  assert.equal(result.measurement.failedOpen, true);
});

test("empty, equal, or larger compressor output fails open", async () => {
  for (const output of ["", largeInput.content, `${largeInput.content}!`]) {
    const result = await executeCompression(largeInput, decisionFor(), () => output);

    assert.equal(result.content, largeInput.content);
    assert.equal(result.compressed, false);
    assert.equal(result.decision.reasonCode, "not-smaller");
    assert.equal(result.measurement.failedOpen, true);
  }
});

test("cold storage remains raw even with an owner", () => {
  const input = { category: "cold-storage", content: largeInput.content, source: "test" };
  const decision = decisionFor(input);

  assert.equal(decision.action, "pass-through");
  assert.equal(decision.reasonCode, "cold-storage-raw");
});
