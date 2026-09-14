import type BetterSqlite3 from "better-sqlite3";

export type MeasurementAccuracy = "actual" | "estimated" | "derived";
export type MeasurementSource = "provider" | "host" | "tokenizer" | "derived";
export type RequestOutcome = "complete" | "partial" | "failed";
export type TelemetryMode = "on" | "off";

export interface TokenCandidates {
  provider?: number;
  host?: number;
  tokenizer?: number;
  derived?: number;
}

export interface ResolvedTokenMeasurement {
  accuracy: MeasurementAccuracy;
  source: MeasurementSource;
  value: number;
}

export interface RequestTokenCandidates {
  cachedInput?: TokenCandidates;
  contextWindow?: TokenCandidates;
  output?: TokenCandidates;
  rawInput?: TokenCandidates;
  sentInput?: TokenCandidates;
}

export interface ResolvedRequestTokens {
  cachedInput: ResolvedTokenMeasurement | null;
  contextWindow: ResolvedTokenMeasurement | null;
  output: ResolvedTokenMeasurement | null;
  rawInput: ResolvedTokenMeasurement | null;
  sentInput: ResolvedTokenMeasurement | null;
}

export interface ProjectTelemetryIdentity {
  gitRoot?: string;
  id: string;
  rootPath: string;
}

export interface TerminalTelemetryIdentity {
  enabled: boolean;
  id: string;
  projectId?: string;
  shell?: string;
}

export interface SessionTelemetryIdentity {
  agentVersion?: string;
  endedAt?: string;
  host: string;
  id: string;
  mode: TelemetryMode;
  projectId: string;
  startedAt?: string;
  status?: string;
  terminalId?: string;
}

export interface CompressionEventInput {
  category: string;
  compressedTokens?: number;
  compressionMode: string;
  compressionMs?: number;
  compressor: string;
  coldObjectReferenceId?: string;
  id: string;
  rawTokens?: number;
}

export interface RecallEventInput {
  coldObjectId?: string;
  completedAt?: string;
  durationMs?: number;
  errorCode?: string;
  id: string;
  queryKind: string;
  queryValue: string;
  requestedAt?: string;
  status: string;
}

export interface RequestTelemetryInput {
  completedAt?: string;
  compressionEvents?: readonly CompressionEventInput[];
  id: string;
  mode: TelemetryMode;
  model?: string;
  outcome: RequestOutcome;
  parentRequestId?: string;
  provider?: string;
  rawBytes?: number;
  recallEvents?: readonly RecallEventInput[];
  sentBytes?: number;
  sequence: number;
  sessionId: string;
  startedAt?: string;
  tokenUsageId?: string;
  tokens: RequestTokenCandidates;
}

export interface RecordedRequestTelemetry {
  cacheDiscountTokens: ResolvedTokenMeasurement | null;
  requestId: string;
  savedInputTokens: ResolvedTokenMeasurement | null;
  tokens: ResolvedRequestTokens;
}

export type TelemetryScope =
  | { projectId: string; sessionId?: never; terminalId?: never }
  | { projectId?: never; sessionId: string; terminalId?: never }
  | { projectId?: never; sessionId?: never; terminalId: string };

export interface AggregatedTokenMeasurement {
  accuracy: MeasurementAccuracy;
  value: number;
}

export interface TokenUsageAggregate {
  cacheDiscountTokens: AggregatedTokenMeasurement | null;
  contextWindow: AggregatedTokenMeasurement | null;
  outputTokens: AggregatedTokenMeasurement | null;
  rawInputTokens: AggregatedTokenMeasurement | null;
  requestCount: number;
  savedInputTokens: AggregatedTokenMeasurement | null;
  sentInputTokens: AggregatedTokenMeasurement | null;
}

interface TokenUsageRow {
  cached_input_accuracy: MeasurementAccuracy | null;
  cached_input_tokens: number | null;
  context_window: number | null;
  context_window_accuracy: MeasurementAccuracy | null;
  output_accuracy: MeasurementAccuracy | null;
  output_tokens: number | null;
  raw_input_accuracy: MeasurementAccuracy | null;
  raw_input_tokens: number | null;
  sent_input_accuracy: MeasurementAccuracy | null;
  sent_input_tokens: number | null;
}

const SOURCE_PRIORITY: readonly MeasurementSource[] = ["provider", "host", "tokenizer", "derived"];

const SOURCE_ACCURACY: Readonly<Record<MeasurementSource, MeasurementAccuracy>> = {
  derived: "derived",
  host: "actual",
  provider: "actual",
  tokenizer: "estimated",
};

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
};

const assertOptionalDuration = (value: number | undefined, name: string): void => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
};

const optionalValue = <T>(value: T | undefined): T | null => value ?? null;

// Select the most authoritative available count and make incomplete observations visibly inexact.
export const resolveTokenMeasurement = (
  candidates: TokenCandidates | undefined,
  outcome: RequestOutcome,
  name = "token measurement",
): ResolvedTokenMeasurement | null => {
  if (candidates === undefined) {
    return null;
  }

  for (const source of SOURCE_PRIORITY) {
    const value = candidates[source];
    if (value === undefined) {
      continue;
    }

    assertNonNegativeInteger(value, name);
    const sourceAccuracy = SOURCE_ACCURACY[source];
    return {
      accuracy:
        outcome === "complete" || sourceAccuracy !== "actual" ? sourceAccuracy : "estimated",
      source,
      value,
    };
  }

  return null;
};

// Resolve every request measurement through the same provenance and completeness rules.
export const resolveRequestTokens = (
  candidates: RequestTokenCandidates,
  outcome: RequestOutcome,
): ResolvedRequestTokens => ({
  cachedInput: resolveTokenMeasurement(candidates.cachedInput, outcome, "cached input tokens"),
  contextWindow: resolveTokenMeasurement(candidates.contextWindow, outcome, "context window"),
  output: resolveTokenMeasurement(candidates.output, outcome, "output tokens"),
  rawInput: resolveTokenMeasurement(candidates.rawInput, outcome, "raw input tokens"),
  sentInput: resolveTokenMeasurement(candidates.sentInput, outcome, "sent input tokens"),
});

const deriveSavedTokens = (tokens: ResolvedRequestTokens): ResolvedTokenMeasurement | null => {
  if (tokens.rawInput === null || tokens.sentInput === null) {
    return null;
  }

  return {
    accuracy: "derived",
    source: "derived",
    value: tokens.rawInput.value - tokens.sentInput.value,
  };
};

// Upsert project identity separately so projects can outlive terminals and sessions.
export const recordTelemetryProject = (
  database: BetterSqlite3.Database,
  project: ProjectTelemetryIdentity,
): void => {
  database
    .prepare(
      `INSERT INTO projects (id, root_path, git_root)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         root_path = excluded.root_path,
         git_root = excluded.git_root,
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(project.id, project.rootPath, optionalValue(project.gitRoot));
};

// Upsert terminal state independently while retaining its optional project association.
export const recordTelemetryTerminal = (
  database: BetterSqlite3.Database,
  terminal: TerminalTelemetryIdentity,
): void => {
  database
    .prepare(
      `INSERT INTO terminals (id, project_id, shell, enabled)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         shell = excluded.shell,
         enabled = excluded.enabled,
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(
      terminal.id,
      optionalValue(terminal.projectId),
      optionalValue(terminal.shell),
      terminal.enabled ? 1 : 0,
    );
};

// Upsert the durable lifecycle fields for one host-agent session.
export const recordTelemetrySession = (
  database: BetterSqlite3.Database,
  session: SessionTelemetryIdentity,
): void => {
  const startedAt = session.startedAt ?? new Date().toISOString();
  database
    .prepare(
      `INSERT INTO sessions
         (id, project_id, terminal_id, host, agent_version, mode, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         terminal_id = excluded.terminal_id,
         host = excluded.host,
         agent_version = excluded.agent_version,
         mode = excluded.mode,
         status = excluded.status,
         ended_at = excluded.ended_at`,
    )
    .run(
      session.id,
      session.projectId,
      optionalValue(session.terminalId),
      session.host,
      optionalValue(session.agentVersion),
      session.mode,
      session.status ?? "active",
      startedAt,
      optionalValue(session.endedAt),
    );
};

const insertCompressionEvent = (
  database: BetterSqlite3.Database,
  requestId: string,
  event: CompressionEventInput,
): void => {
  if (event.rawTokens !== undefined) {
    assertNonNegativeInteger(event.rawTokens, "compression raw tokens");
  }
  if (event.compressedTokens !== undefined) {
    assertNonNegativeInteger(event.compressedTokens, "compression compressed tokens");
  }
  assertOptionalDuration(event.compressionMs, "compression duration");

  database
    .prepare(
      `INSERT INTO compression_events
         (id, request_id, cold_object_reference_id, category, compressor, compression_mode,
          raw_tokens, compressed_tokens, compression_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      requestId,
      optionalValue(event.coldObjectReferenceId),
      event.category,
      event.compressor,
      event.compressionMode,
      optionalValue(event.rawTokens),
      optionalValue(event.compressedTokens),
      optionalValue(event.compressionMs),
    );
};

const insertRecallEvent = (
  database: BetterSqlite3.Database,
  sessionId: string,
  event: RecallEventInput,
): void => {
  assertOptionalDuration(event.durationMs, "recall duration");
  database
    .prepare(
      `INSERT INTO recalls
         (id, session_id, cold_object_id, query_kind, query_value, status, requested_at,
          completed_at, duration_ms, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      sessionId,
      optionalValue(event.coldObjectId),
      event.queryKind,
      event.queryValue,
      event.status,
      event.requestedAt ?? new Date().toISOString(),
      optionalValue(event.completedAt),
      optionalValue(event.durationMs),
      optionalValue(event.errorCode),
    );
};

const measurementValues = (
  measurement: ResolvedTokenMeasurement | null,
): readonly [number | null, MeasurementAccuracy | null] =>
  measurement === null ? [null, null] : [measurement.value, measurement.accuracy];

// Commit request usage, compression events, and recall activity as one indivisible ledger entry.
export const recordRequestTelemetry = (
  database: BetterSqlite3.Database,
  input: RequestTelemetryInput,
): RecordedRequestTelemetry => {
  assertNonNegativeInteger(input.sequence, "request sequence");
  if (input.rawBytes !== undefined) {
    assertNonNegativeInteger(input.rawBytes, "raw bytes");
  }
  if (input.sentBytes !== undefined) {
    assertNonNegativeInteger(input.sentBytes, "sent bytes");
  }

  const tokens = resolveRequestTokens(input.tokens, input.outcome);
  if (tokens.contextWindow !== null && tokens.contextWindow.value === 0) {
    throw new RangeError("context window must be greater than zero");
  }

  const rawInput = measurementValues(tokens.rawInput);
  const sentInput = measurementValues(tokens.sentInput);
  const cachedInput = measurementValues(tokens.cachedInput);
  const output = measurementValues(tokens.output);
  const contextWindow = measurementValues(tokens.contextWindow);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt =
    input.completedAt ?? (input.outcome === "complete" ? new Date().toISOString() : null);

  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO requests
           (id, session_id, sequence, parent_request_id, provider, model, mode, raw_bytes,
            sent_bytes, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.sequence,
        optionalValue(input.parentRequestId),
        optionalValue(input.provider),
        optionalValue(input.model),
        input.mode,
        optionalValue(input.rawBytes),
        optionalValue(input.sentBytes),
        startedAt,
        completedAt,
      );

    database
      .prepare(
        `INSERT INTO token_usage
           (id, request_id, raw_input_tokens, sent_input_tokens, cached_input_tokens,
            output_tokens, context_window, raw_input_accuracy, sent_input_accuracy,
            cached_input_accuracy, output_accuracy, context_window_accuracy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenUsageId ?? `${input.id}:tokens`,
        input.id,
        rawInput[0],
        sentInput[0],
        cachedInput[0],
        output[0],
        contextWindow[0],
        rawInput[1],
        sentInput[1],
        cachedInput[1],
        output[1],
        contextWindow[1],
      );

    for (const event of input.compressionEvents ?? []) {
      insertCompressionEvent(database, input.id, event);
    }
    for (const event of input.recallEvents ?? []) {
      insertRecallEvent(database, input.sessionId, event);
    }
  });

  transaction();
  return {
    cacheDiscountTokens: tokens.cachedInput,
    requestId: input.id,
    savedInputTokens: deriveSavedTokens(tokens),
    tokens,
  };
};

const combineAccuracy = (
  accuracies: readonly (MeasurementAccuracy | null)[],
): MeasurementAccuracy | null => {
  const present = accuracies.filter(
    (accuracy): accuracy is MeasurementAccuracy => accuracy !== null,
  );
  if (present.length === 0) {
    return null;
  }
  if (present.includes("derived")) {
    return "derived";
  }
  if (present.includes("estimated")) {
    return "estimated";
  }
  return "actual";
};

const aggregateColumn = (
  rows: readonly TokenUsageRow[],
  valueKey:
    | "cached_input_tokens"
    | "context_window"
    | "output_tokens"
    | "raw_input_tokens"
    | "sent_input_tokens",
  accuracyKey:
    | "cached_input_accuracy"
    | "context_window_accuracy"
    | "output_accuracy"
    | "raw_input_accuracy"
    | "sent_input_accuracy",
): AggregatedTokenMeasurement | null => {
  const measuredRows = rows.filter((row) => row[valueKey] !== null);
  if (measuredRows.length === 0) {
    return null;
  }

  const accuracy = combineAccuracy(measuredRows.map((row) => row[accuracyKey]));
  if (accuracy === null) {
    throw new Error(`Missing accuracy label for ${valueKey}`);
  }

  return {
    accuracy,
    value: measuredRows.reduce((total, row) => total + (row[valueKey] ?? 0), 0),
  };
};

// Aggregate one explicit project, terminal, or session scope without blending identity boundaries.
export const aggregateTokenUsage = (
  database: BetterSqlite3.Database,
  scope: TelemetryScope,
): TokenUsageAggregate => {
  const scopeColumn =
    "projectId" in scope
      ? "sessions.project_id"
      : "terminalId" in scope
        ? "sessions.terminal_id"
        : "sessions.id";
  const scopeValue =
    "projectId" in scope
      ? scope.projectId
      : "terminalId" in scope
        ? scope.terminalId
        : scope.sessionId;
  const rows = database
    .prepare(
      `SELECT token_usage.*
       FROM token_usage
       JOIN requests ON requests.id = token_usage.request_id
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${scopeColumn} = ?
       ORDER BY requests.started_at, requests.sequence`,
    )
    .all(scopeValue) as TokenUsageRow[];

  const savedRows = rows.filter(
    (row) => row.raw_input_tokens !== null && row.sent_input_tokens !== null,
  );
  const savedInputTokens =
    savedRows.length === 0
      ? null
      : {
          accuracy: "derived" as const,
          value: savedRows.reduce(
            (total, row) => total + (row.raw_input_tokens ?? 0) - (row.sent_input_tokens ?? 0),
            0,
          ),
        };

  return {
    cacheDiscountTokens: aggregateColumn(rows, "cached_input_tokens", "cached_input_accuracy"),
    contextWindow: aggregateColumn(rows, "context_window", "context_window_accuracy"),
    outputTokens: aggregateColumn(rows, "output_tokens", "output_accuracy"),
    rawInputTokens: aggregateColumn(rows, "raw_input_tokens", "raw_input_accuracy"),
    requestCount: rows.length,
    savedInputTokens,
    sentInputTokens: aggregateColumn(rows, "sent_input_tokens", "sent_input_accuracy"),
  };
};
