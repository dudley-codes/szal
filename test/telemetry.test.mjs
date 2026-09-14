import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateTokenUsage,
  openSzalDatabase,
  recordRequestTelemetry,
  recordTelemetryProject,
  recordTelemetrySession,
  recordTelemetryTerminal,
  resolveTokenMeasurement,
} from "../dist/core/storage/index.js";

const openFixtureDatabase = () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-telemetry-"));
  const database = openSzalDatabase({ environment: {}, homeDirectory });

  recordTelemetryProject(database.connection, {
    gitRoot: "/workspace/project/.git",
    id: "project-1",
    rootPath: "/workspace/project",
  });
  recordTelemetryTerminal(database.connection, {
    enabled: true,
    id: "terminal-1",
    projectId: "project-1",
    shell: "zsh",
  });
  recordTelemetryTerminal(database.connection, {
    enabled: false,
    id: "terminal-2",
    projectId: "project-1",
    shell: "bash",
  });
  recordTelemetrySession(database.connection, {
    host: "claude",
    id: "session-1",
    mode: "on",
    projectId: "project-1",
    terminalId: "terminal-1",
  });
  recordTelemetrySession(database.connection, {
    host: "claude",
    id: "session-2",
    mode: "off",
    projectId: "project-1",
    terminalId: "terminal-2",
  });

  return { database, homeDirectory };
};

const closeFixtureDatabase = ({ database, homeDirectory }) => {
  database.connection.close();
  rmSync(homeDirectory, { force: true, recursive: true });
};

test("token resolution prefers provider, host, tokenizer, then derived observations", () => {
  assert.deepEqual(
    resolveTokenMeasurement({ derived: 70, host: 90, provider: 100, tokenizer: 80 }, "complete"),
    { accuracy: "actual", source: "provider", value: 100 },
  );
  assert.deepEqual(resolveTokenMeasurement({ host: 90, tokenizer: 80 }, "complete"), {
    accuracy: "actual",
    source: "host",
    value: 90,
  });
  assert.deepEqual(resolveTokenMeasurement({ derived: 70, tokenizer: 80 }, "complete"), {
    accuracy: "estimated",
    source: "tokenizer",
    value: 80,
  });
  assert.deepEqual(resolveTokenMeasurement({ derived: 70 }, "complete"), {
    accuracy: "derived",
    source: "derived",
    value: 70,
  });
});

test("partial and failed observations cannot retain exact labels", () => {
  assert.deepEqual(resolveTokenMeasurement({ provider: 100 }, "partial"), {
    accuracy: "estimated",
    source: "provider",
    value: 100,
  });
  assert.deepEqual(resolveTokenMeasurement({ host: 90 }, "failed"), {
    accuracy: "estimated",
    source: "host",
    value: 90,
  });
});

test("request telemetry labels counts and records cache discounts separately from saved tokens", () => {
  const fixture = openFixtureDatabase();

  try {
    const recorded = recordRequestTelemetry(fixture.database.connection, {
      compressionEvents: [
        {
          category: "prompt",
          compressedTokens: 70,
          compressionMode: "transport",
          compressionMs: 12.5,
          compressor: "llmtrim",
          id: "compression-1",
          rawTokens: 100,
        },
      ],
      id: "request-1",
      mode: "on",
      model: "claude-sonnet",
      outcome: "complete",
      provider: "anthropic",
      rawBytes: 800,
      recallEvents: [
        {
          durationMs: 4.5,
          id: "recall-1",
          queryKind: "uri",
          queryValue: "szal://cold/example",
          status: "completed",
        },
      ],
      sentBytes: 560,
      sequence: 0,
      sessionId: "session-1",
      tokens: {
        cachedInput: { provider: 10 },
        contextWindow: { host: 200_000 },
        output: { provider: 20 },
        rawInput: { provider: 100, tokenizer: 98 },
        sentInput: { provider: 70 },
      },
    });

    assert.deepEqual(recorded.savedInputTokens, {
      accuracy: "derived",
      source: "derived",
      value: 30,
    });
    assert.deepEqual(recorded.cacheDiscountTokens, {
      accuracy: "actual",
      source: "provider",
      value: 10,
    });
    assert.deepEqual(
      fixture.database.connection
        .prepare(
          `SELECT raw_input_accuracy, sent_input_accuracy, cached_input_accuracy,
                  output_accuracy, context_window_accuracy
           FROM token_usage`,
        )
        .get(),
      {
        cached_input_accuracy: "actual",
        context_window_accuracy: "actual",
        output_accuracy: "actual",
        raw_input_accuracy: "actual",
        sent_input_accuracy: "actual",
      },
    );
    assert.equal(
      fixture.database.connection
        .prepare("SELECT compressor FROM compression_events")
        .pluck()
        .get(),
      "llmtrim",
    );
    assert.equal(
      fixture.database.connection.prepare("SELECT status FROM recalls").pluck().get(),
      "completed",
    );
  } finally {
    closeFixtureDatabase(fixture);
  }
});

test("request, token, compression, and recall writes roll back together", () => {
  const fixture = openFixtureDatabase();

  try {
    assert.throws(
      () =>
        recordRequestTelemetry(fixture.database.connection, {
          compressionEvents: [
            {
              category: "prompt",
              compressionMode: "transport",
              compressor: "llmtrim",
              id: "compression-rollback",
            },
          ],
          id: "request-rollback",
          mode: "on",
          outcome: "complete",
          recallEvents: [
            {
              id: "duplicate-recall",
              queryKind: "uri",
              queryValue: "first",
              status: "completed",
            },
            {
              id: "duplicate-recall",
              queryKind: "uri",
              queryValue: "second",
              status: "completed",
            },
          ],
          sequence: 0,
          sessionId: "session-1",
          tokens: { rawInput: { provider: 100 }, sentInput: { provider: 70 } },
        }),
      /UNIQUE constraint failed/,
    );

    for (const table of ["requests", "token_usage", "compression_events", "recalls"]) {
      assert.equal(
        fixture.database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
        0,
      );
    }
  } finally {
    closeFixtureDatabase(fixture);
  }
});

test("aggregations preserve project, terminal, and session scopes across mixed sources", () => {
  const fixture = openFixtureDatabase();

  try {
    recordRequestTelemetry(fixture.database.connection, {
      id: "request-1",
      mode: "on",
      outcome: "complete",
      sequence: 0,
      sessionId: "session-1",
      tokens: {
        cachedInput: { provider: 10 },
        contextWindow: { provider: 200_000 },
        output: { provider: 20 },
        rawInput: { provider: 100 },
        sentInput: { provider: 70 },
      },
    });
    recordRequestTelemetry(fixture.database.connection, {
      id: "request-2",
      mode: "off",
      outcome: "complete",
      sequence: 0,
      sessionId: "session-2",
      tokens: {
        cachedInput: { tokenizer: 5 },
        contextWindow: { derived: 200_000 },
        output: { host: 10 },
        rawInput: { tokenizer: 90 },
        sentInput: { derived: 55 },
      },
    });

    assert.deepEqual(aggregateTokenUsage(fixture.database.connection, { projectId: "project-1" }), {
      cacheDiscountTokens: { accuracy: "estimated", value: 15 },
      contextWindow: { accuracy: "derived", value: 400_000 },
      outputTokens: { accuracy: "actual", value: 30 },
      rawInputTokens: { accuracy: "estimated", value: 190 },
      requestCount: 2,
      savedInputTokens: { accuracy: "derived", value: 65 },
      sentInputTokens: { accuracy: "derived", value: 125 },
    });
    assert.deepEqual(
      aggregateTokenUsage(fixture.database.connection, { terminalId: "terminal-1" }),
      {
        cacheDiscountTokens: { accuracy: "actual", value: 10 },
        contextWindow: { accuracy: "actual", value: 200_000 },
        outputTokens: { accuracy: "actual", value: 20 },
        rawInputTokens: { accuracy: "actual", value: 100 },
        requestCount: 1,
        savedInputTokens: { accuracy: "derived", value: 30 },
        sentInputTokens: { accuracy: "actual", value: 70 },
      },
    );
    assert.equal(
      aggregateTokenUsage(fixture.database.connection, { sessionId: "session-2" }).savedInputTokens
        .value,
      35,
    );
  } finally {
    closeFixtureDatabase(fixture);
  }
});
