import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  };
  return { commands, entries, handlers, pi };
};

const withEnabled = async (value, run) => {
  const previous = process.env.SZAL_ENABLED;
  if (value === undefined) {
    delete process.env.SZAL_ENABLED;
  } else {
    process.env.SZAL_ENABLED = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SZAL_ENABLED;
    } else {
      process.env.SZAL_ENABLED = previous;
    }
  }
};

const eventFor = (text) => ({
  content: [{ type: "text", text }],
  input: { command: "printf lots" },
  isError: false,
  toolCallId: "tool-1",
  toolName: "bash",
});

test("Pi extension compresses large enabled text tool results and records measurement", async () => {
  const loaded = await loadExtension();
  try {
    const { entries, handlers, pi } = createPi();
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = `${"line of output\n".repeat(900)}final line`;

    const result = await withEnabled("1", () => handler(eventFor(content), {}));

    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /szal compressed/);
    assert.ok(
      Buffer.byteLength(result.content[0].text, "utf8") < Buffer.byteLength(content, "utf8"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, loaded.module.SZAL_MEASUREMENT_ENTRY_TYPE);
    assert.equal(entries[0].data.category, "bash");
    assert.equal(entries[0].data.reasonCode, "compressed");
    assert.ok(entries[0].data.rawBytes > entries[0].data.compressedBytes);
    assert.equal(entries[0].data.failedOpen, false);
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
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
  try {
    const { handlers, pi } = createPi({ appendThrows: true });
    loaded.module.default(pi);
    const handler = handlers.get("tool_result");
    const content = `${"line of output\n".repeat(900)}final line`;

    await assert.doesNotReject(withEnabled("1", () => handler(eventFor(content), {})));
  } finally {
    rmSync(loaded.directory, { force: true, recursive: true });
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
