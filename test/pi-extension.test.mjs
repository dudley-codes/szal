import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const loadExtension = async () => {
  const sourcePath = join(process.cwd(), "resources", "pi", "extensions", "szal", "index.ts");
  const source = readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "szal-pi-extension-"));
  const modulePath = join(directory, "index.mjs");
  writeFileSync(modulePath, output.outputText, "utf8");
  const module = await import(`${modulePath}?${Date.now()}-${Math.random()}`);
  return { directory, module };
};

const createPi = ({ appendThrows = false } = {}) => {
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const statuses = new Map();
  const tools = new Map();
  const pi = {
    appendEntry(customType, data) {
      if (appendThrows) {
        throw new Error("append failed");
      }
      entries.push({ customType, data, type: "custom" });
    },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  return { commands, entries, handlers, pi, statuses, tools };
};

const withEnabled = async (value, run) => {
  const previous = process.env.SZAL_ENABLED;
  const previousMemory = process.env.SZAL_PI_MEMORY;
  if (value === undefined) {
    delete process.env.SZAL_ENABLED;
  } else {
    process.env.SZAL_ENABLED = value;
  }
  if (previousMemory === undefined) {
    process.env.SZAL_PI_MEMORY = "0";
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SZAL_ENABLED;
    } else {
      process.env.SZAL_ENABLED = previous;
    }
    if (previousMemory === undefined) {
      delete process.env.SZAL_PI_MEMORY;
    } else {
      process.env.SZAL_PI_MEMORY = previousMemory;
    }
  }
};

const withPiMemory = async (value, run) => {
  const previous = process.env.SZAL_PI_MEMORY;
  process.env.SZAL_PI_MEMORY = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SZAL_PI_MEMORY;
    } else {
      process.env.SZAL_PI_MEMORY = previous;
    }
  }
};

const withTestOwners = async (value, run) => {
  const previous = process.env.SZAL_PI_TEST_OWNERS;
  if (value === undefined) {
    delete process.env.SZAL_PI_TEST_OWNERS;
  } else {
    process.env.SZAL_PI_TEST_OWNERS = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SZAL_PI_TEST_OWNERS;
    } else {
      process.env.SZAL_PI_TEST_OWNERS = previous;
    }
  }
};

const withSzalCliPath = async (value, run) => {
  const previous = process.env.SZAL_CLI_PATH;
  process.env.SZAL_CLI_PATH = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SZAL_CLI_PATH;
    } else {
      process.env.SZAL_CLI_PATH = previous;
    }
  }
};

const createColdStoreExecutable = ({ exitCode = 0 } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "szal-pi-cold-store-"));
  const capturePath = join(directory, "payload.txt");
  const argumentsPath = join(directory, "arguments.json");
  const executablePath = join(directory, "szal-cold-store.js");
  const coldObjectId = `szal://cold/sha256/${"b".repeat(64)}`;
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nwriteFileSync(${JSON.stringify(capturePath)}, Buffer.concat(chunks));\nwriteFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = ${String(exitCode)};\nif (${String(exitCode)} === 0) process.stdout.write(${JSON.stringify(coldObjectId)} + "\\n");\n`,
  );
  chmodSync(executablePath, 0o700);
  return { argumentsPath, capturePath, coldObjectId, directory, executablePath };
};

const createSzalMemoryExecutable = ({
  recallText = "## Szal memory\n- [task:selected] remembered context",
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "szal-pi-memory-"));
  const callsPath = join(directory, "calls.jsonl");
  const executablePath = join(directory, "szal-memory.js");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nconst call = { argv: process.argv.slice(2), cwd: process.cwd(), stdin: Buffer.concat(chunks).toString("utf8") };\nappendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + "\\n");\nif (call.argv[0] === "memory" && call.argv[1] === "recall") { process.stdout.write(${JSON.stringify(recallText)}); }\nelse if (call.argv[0] === "memory" && call.argv[1] === "capture-host-lifecycle") { process.stdout.write(JSON.stringify({ accepted: 1, rejected: 0 })); }\nelse { process.exitCode = 2; }\n`,
  );
  chmodSync(executablePath, 0o700);
  const readCalls = () =>
    readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { callsPath, directory, executablePath, readCalls };
};

const eventFor = (text) => ({
  content: [{ type: "text", text }],
  input: { command: "printf lots" },
  isError: false,
  toolCallId: "tool-1",
  toolName: "bash",
});

const statusContext = (statuses) => ({
  ui: {
    setStatus: (key, text) => statuses.set(key, text),
  },
});

const messageFor = (text) => ({
  content: [{ type: "text", text }],
  role: "toolResult",
  timestamp: 123,
  toolCallId: "tool-1",
  toolName: "bash",
});

const branchEntryFor = (message) => ({
  id: "entry-1",
  message,
  parentId: null,
  timestamp: 123,
  type: "message",
});

test("Pi extension updates runtime status indicator and records local status telemetry", async () => {
  const loaded = await loadExtension();
  try {
    for (const [enabledValue, expectedStatus, expectedReason] of [
      ["1", "ON", "terminal-on"],
      ["0", "OFF", "terminal-off"],
      [undefined, "OFF", "terminal-unset"],
      ["maybe", "degraded", "invalid-szal-enabled"],
    ]) {
      const { entries, handlers, pi, statuses } = createPi();
      loaded.module.default(pi);
      const handler = handlers.get("session_start");

      await withEnabled(enabledValue, () =>
        handler({ reason: "startup" }, statusContext(statuses)),
      );

      const statusEntry = entries.find(
        (entry) => entry.customType === loaded.module.SZAL_RUNTIME_STATUS_ENTRY_TYPE,
      );
      assert.equal(statuses.get("szal"), expectedStatus);
      assert.equal(statusEntry.data.status, expectedStatus);
      assert.equal(statusEntry.data.reasonCode, expectedReason);
      assert.equal(statusEntry.data.source, "session-startup");
    }
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi extension compresses large enabled text tool results, stores original, and records measurement", async () => {
  const loaded = await loadExtension();
  const coldStore = createColdStoreExecutable();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = `${"line of output\n".repeat(900)}final line`;

    const result = await withSzalCliPath(coldStore.executablePath, () =>
      withEnabled("1", () => handler(eventFor(content), {})),
    );

    assert.equal(readFileSync(coldStore.capturePath, "utf8"), content);
    assert.deepEqual(JSON.parse(readFileSync(coldStore.argumentsPath, "utf8")), [
      "cold",
      "store",
      "--category",
      "bash",
      "--source-tool",
      "bash",
    ]);
    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /szal compressed/);
    assert.match(result.content[0].text, new RegExp(`szal recall ${coldStore.coldObjectId}`));
    assert.ok(
      Buffer.byteLength(result.content[0].text, "utf8") < Buffer.byteLength(content, "utf8"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, loaded.module.SZAL_MEASUREMENT_ENTRY_TYPE);
    assert.equal(entries[0].data.category, "bash");
    assert.equal(entries[0].data.coldObjectId, coldStore.coldObjectId);
    assert.equal(entries[0].data.reasonCode, "compressed");
    assert.ok(entries[0].data.rawBytes > entries[0].data.compressedBytes);
    assert.equal(entries[0].data.failedOpen, false);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
    rmSync(coldStore.directory, { force: true, recursive: true });
  }
});

test("Pi extension fails open when original cold storage fails", async () => {
  const loaded = await loadExtension();
  const coldStore = createColdStoreExecutable({ exitCode: 2 });
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = `${"line of output\n".repeat(900)}final line`;

    const result = await withSzalCliPath(coldStore.executablePath, () =>
      withEnabled("1", () => handler(eventFor(content), {})),
    );

    assert.equal(result, undefined);
    assert.equal(readFileSync(coldStore.capturePath, "utf8"), content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.reasonCode, "cold-store-error");
    assert.equal(entries[0].data.rawBytes, entries[0].data.compressedBytes);
    assert.equal(entries[0].data.failedOpen, true);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
    rmSync(coldStore.directory, { force: true, recursive: true });
  }
});

test("Pi extension passes through disabled terminals with equal measurement", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = "long enough?\n".repeat(900);

    const result = await withEnabled(undefined, () => handler(eventFor(content), {}));

    assert.equal(result, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.reasonCode, "terminal-pass-through");
    assert.equal(entries[0].data.rawBytes, entries[0].data.compressedBytes);
    assert.equal(entries[0].data.failedOpen, false);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi extension fails open if measurement persistence throws", async () => {
  const loaded = await loadExtension();
  const coldStore = createColdStoreExecutable();
  try {
    const { handlers, pi } = createPi({ appendThrows: true });
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = `${"line of output\n".repeat(900)}final line`;

    await assert.doesNotReject(
      withSzalCliPath(coldStore.executablePath, () =>
        withEnabled("1", () => handler(eventFor(content), {})),
      ),
    );
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
    rmSync(coldStore.directory, { force: true, recursive: true });
  }
});

test("Pi extension status command summarizes branch measurements", async () => {
  const loaded = await loadExtension();
  try {
    const { commands, pi } = createPi();
    loaded.module.default(pi);
    const notifications = [];
    const measurement = {
      category: "bash",
      compressedBytes: 50,
      compressedTokens: 13,
      rawBytes: 100,
      rawTokens: 25,
      reasonCode: "compressed",
    };

    await withEnabled("1", () =>
      commands.get("szal").handler("", {
        sessionManager: {
          getBranch: () => [
            {
              customType: loaded.module.SZAL_MEASUREMENT_ENTRY_TYPE,
              data: measurement,
              type: "custom",
            },
          ],
        },
        ui: { notify: (message) => notifications.push(message) },
      }),
    );

    assert.match(notifications[0], /compression enabled/);
    assert.match(notifications[0], /saved 50 bytes \/ 12 estimated tokens/);
    assert.match(notifications[0], /bash: compressed 100→50 bytes/);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi context hook shapes model context without changing canonical session history", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("context");
    const content = `${"context line\n".repeat(900)}final line`;
    const canonicalMessage = messageFor(content);
    const canonicalBranch = [branchEntryFor(canonicalMessage)];
    const beforeCanonical = JSON.stringify(canonicalBranch);

    const result = await withEnabled("1", () =>
      handler(
        { messages: [structuredClone(canonicalMessage)] },
        { sessionManager: { getBranch: () => canonicalBranch } },
      ),
    );

    assert.equal(JSON.stringify(canonicalBranch), beforeCanonical);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0].content[0].text, /szal compressed/);
    assert.ok(
      Buffer.byteLength(result.messages[0].content[0].text, "utf8") <
        Buffer.byteLength(content, "utf8"),
    );
    assert.equal(canonicalMessage.content[0].text, content);
    const measurement = entries.find(
      (entry) => entry.customType === loaded.module.SZAL_CONTEXT_ENTRY_TYPE,
    );
    assert.equal(measurement.data.reasonCode, "compressed");
    assert.ok(measurement.data.rawContextBytes > measurement.data.shapedContextBytes);
    assert.equal(measurement.data.canonicalHistoryIntact, true);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi context measurements show reduced context reaches provider payload", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const contextHandler = handlers.get("context");
    const providerHandler = handlers.get("before_provider_request");
    const content = `${"provider line\n".repeat(900)}final line`;
    const message = messageFor(content);

    const shaped = await withEnabled("1", () =>
      contextHandler(
        { messages: [structuredClone(message)] },
        { sessionManager: { getBranch: () => [] } },
      ),
    );
    await withEnabled("1", () =>
      providerHandler(
        { payload: { messages: shaped.messages } },
        { sessionManager: { getBranch: () => [] } },
      ),
    );

    const providerMeasurement = entries.find(
      (entry) => entry.customType === loaded.module.SZAL_PROVIDER_CONTEXT_ENTRY_TYPE,
    );
    assert.equal(providerMeasurement.data.reasonCode, "provider-payload-observed");
    assert.ok(
      providerMeasurement.data.rawContextBytes > providerMeasurement.data.shapedContextBytes,
    );
    assert.ok(
      providerMeasurement.data.providerPayloadBytes < providerMeasurement.data.rawContextBytes,
    );
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi context owner conflicts fail open and preserve canonical history", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("context");
    const content = `${"conflict line\n".repeat(900)}final line`;
    const canonicalMessage = messageFor(content);
    const canonicalBranch = [branchEntryFor(canonicalMessage)];
    const beforeCanonical = JSON.stringify(canonicalBranch);

    const result = await withTestOwners("szal-pi,other", () =>
      withEnabled("1", () =>
        handler(
          { messages: [structuredClone(canonicalMessage)] },
          { sessionManager: { getBranch: () => canonicalBranch } },
        ),
      ),
    );

    assert.equal(JSON.stringify(canonicalBranch), beforeCanonical);
    assert.deepEqual(result.messages, [canonicalMessage]);
    const measurement = entries.find(
      (entry) => entry.customType === loaded.module.SZAL_CONTEXT_ENTRY_TYPE,
    );
    assert.equal(measurement.data.reasonCode, "owner-conflict");
    assert.equal(measurement.data.failedOpen, true);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi session_before_compact observes canonical compaction preparation", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("session_before_compact");
    const message = messageFor("compact me");
    const branchEntries = [branchEntryFor(message)];
    const beforeBranch = JSON.stringify(branchEntries);

    const result = await withEnabled("1", () =>
      handler(
        {
          branchEntries,
          preparation: {
            firstKeptEntryId: "entry-1",
            messagesToSummarize: [message],
            tokensBefore: 1234,
            turnPrefixMessages: [],
          },
          reason: "manual",
          signal: new AbortController().signal,
          willRetry: false,
        },
        {},
      ),
    );

    assert.equal(result, undefined);
    assert.equal(JSON.stringify(branchEntries), beforeBranch);
    const observation = entries.find(
      (entry) => entry.customType === loaded.module.SZAL_COMPACTION_OBSERVATION_ENTRY_TYPE,
    );
    assert.equal(observation.data.tokensBefore, 1234);
    assert.equal(observation.data.firstKeptEntryId, "entry-1");
    assert.equal(observation.data.reason, "manual");
    assert.equal(observation.data.owner, "szal-pi");
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi context shaping passes through disabled terminals", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("context");
    const content = `${"disabled line\n".repeat(900)}final line`;
    const message = messageFor(content);

    const result = await withEnabled(undefined, () =>
      handler(
        { messages: [structuredClone(message)] },
        { sessionManager: { getBranch: () => [] } },
      ),
    );

    assert.deepEqual(result.messages, [message]);
    const measurement = entries.find(
      (entry) => entry.customType === loaded.module.SZAL_CONTEXT_ENTRY_TYPE,
    );
    assert.equal(measurement.data.reasonCode, "terminal-pass-through");
    assert.equal(measurement.data.rawContextBytes, measurement.data.shapedContextBytes);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
  }
});

test("Pi before_agent_start injects bounded recalled memory and captures prompt lifecycle", async () => {
  const loaded = await loadExtension();
  const memory = createSzalMemoryExecutable({
    recallText: "## Szal memory\n- [task:selected] Continue the Widget implementation",
  });
  try {
    const { handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("before_agent_start");

    const result = await withSzalCliPath(memory.executablePath, () =>
      withPiMemory("1", () =>
        withEnabled("1", () =>
          handler(
            { prompt: "finish Widget tests", systemPrompt: "base prompt" },
            {
              cwd: memory.directory,
              sessionManager: {
                getSessionFile: () => join(memory.directory, "session.jsonl"),
                getSessionId: () => "pi-session-1",
              },
            },
          ),
        ),
      ),
    );

    assert.match(result.systemPrompt, /base prompt/);
    assert.match(result.systemPrompt, /Continue the Widget implementation/);
    const calls = memory.readCalls();
    assert.deepEqual(calls[0].argv.slice(0, 2), ["memory", "recall"]);
    assert.deepEqual(calls[1].argv.slice(0, 2), ["memory", "capture-host-lifecycle"]);
    assert.ok(calls[1].argv.includes("--session-id"));
    assert.equal(calls[1].argv[calls[1].argv.indexOf("--kind") + 1], "prompt-lifecycle");
    const candidates = JSON.parse(calls[1].stdin);
    assert.equal(candidates[0].class, "task");
    assert.match(candidates[0].content, /finish Widget tests/);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
    rmSync(memory.directory, { force: true, recursive: true });
  }
});

test("Pi szal-recall command and szal_recall tool expose bounded project memory", async () => {
  const loaded = await loadExtension();
  const memory = createSzalMemoryExecutable({
    recallText: "## Szal memory\n- [decision:selected] Use exact cold recall",
  });
  try {
    const { commands, pi, tools } = createPi();
    loaded.module.default(pi);
    const notifications = [];
    const ctx = {
      cwd: memory.directory,
      ui: { notify: (message) => notifications.push(message) },
    };

    await withSzalCliPath(memory.executablePath, () =>
      commands.get("szal-recall").handler("cold", ctx),
    );
    const toolResult = await withSzalCliPath(memory.executablePath, () =>
      tools
        .get("szal_recall")
        .execute("tool-1", { limit: 3, query: "cold" }, undefined, undefined, ctx),
    );

    assert.match(notifications[0], /Use exact cold recall/);
    assert.match(toolResult.content[0].text, /Use exact cold recall/);
    const calls = memory.readCalls();
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.argv.includes("--query")));
    assert.ok(calls.every((call) => call.argv.includes("cold")));
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
    rmSync(memory.directory, { force: true, recursive: true });
  }
});
