import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createClaudeAdapter } from "../dist/core/adapters/index.js";
import { DEFAULT_CONFIG } from "../dist/core/config/index.js";

const temporaryDirectories = new Set();
test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

const SCRIPT_MARKER = "#!/usr/bin/env bash\n# Managed by Szal: selective squeez Claude hook v1\n";

const executable = (path, contents = "#!/bin/sh\nexit 0\n") => {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
};

const createFixture = ({ settings, squeeze = true } = {}) => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-claude-adapter-"));
  temporaryDirectories.add(homeDirectory);
  const binDirectory = join(homeDirectory, "bin");
  const claudeDirectory = join(homeDirectory, ".claude");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(claudeDirectory, { recursive: true });
  executable(join(binDirectory, "claude"));
  if (squeeze) {
    executable(join(binDirectory, "squeez"));
  }
  const settingsPath = join(claudeDirectory, "settings.json");
  if (settings !== undefined) {
    writeFileSync(settingsPath, settings, { mode: 0o600 });
  }
  return {
    context: {
      environment: {
        API_SECRET: "must-not-be-persisted",
        HOME: homeDirectory,
        PATH: binDirectory,
      },
      homeDirectory,
      projectDirectory: join(homeDirectory, "project"),
    },
    homeDirectory,
    settingsPath,
  };
};

const fakeSqueezRunner = () => ({
  status: 0,
  stderr: "",
  stdout: "squeez 1.48.9\n",
});

const stagedHooks = async () => ({
  postToolUse: Buffer.from(`${SCRIPT_MARKER}exit 0\n`),
  preToolUse: Buffer.from(`${SCRIPT_MARKER}exit 0\n`),
});

const createFakeLlmtrim = ({ available = true, failVerification = false } = {}) => {
  const state = {
    available,
    disableCalls: 0,
    installed: false,
    running: false,
  };
  const detection = () =>
    state.available
      ? { details: { command: "llmtrim", version: "0.12.0" }, status: "available" }
      : {
          issue: {
            code: "llmtrim-not-installed",
            message: "missing",
            retryable: false,
          },
          status: "unavailable",
        };
  const adapter = {
    configure: async (context, request) => {
      if (request.mode === "off") {
        const environment = { ...context.environment };
        for (const key of [
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "SZAL_LLMTRIM_DAEMON_CONFIGURATION",
          "SZAL_LLMTRIM_ENVIRONMENT_STATE",
        ]) {
          Reflect.deleteProperty(environment, key);
        }
        return {
          changed: false,
          details: {
            compression: "pass-through",
            environment,
            health: "healthy",
            measurementSource: "szal-pass-through",
            recovery: "disabled",
          },
          requiresRestart: false,
          status: "succeeded",
        };
      }
      const alreadyConfigured =
        context.environment.HTTPS_PROXY === "http://127.0.0.1:7788" &&
        context.environment.SZAL_LLMTRIM_DAEMON_CONFIGURATION !== undefined;
      state.running = true;
      const environment = {
        ...context.environment,
        HTTP_PROXY: "http://127.0.0.1:7788",
        HTTPS_PROXY: "http://127.0.0.1:7788",
        LLMTRIM_FIRST_ARRIVAL_RECALL: "true",
        LLMTRIM_PRESET: request.preset,
        NODE_EXTRA_CA_CERTS: join(context.homeDirectory, ".llmtrim", "ca.pem"),
        NODE_USE_ENV_PROXY: "1",
        SZAL_LLMTRIM_DAEMON_CONFIGURATION: JSON.stringify({
          enableRecovery: true,
          pid: 123,
          preset: request.preset,
          version: 1,
        }),
        SZAL_LLMTRIM_ENVIRONMENT_STATE: JSON.stringify({
          applied: {},
          values: {},
          version: 2,
        }),
      };
      return {
        changed: !alreadyConfigured,
        details: {
          compression: "enabled",
          environment,
          health: "healthy",
          measurementSource: "llmtrim-status",
          proxyUrl: "http://127.0.0.1:7788",
          recovery: "enabled",
        },
        requiresRestart: !alreadyConfigured,
        status: "succeeded",
      };
    },
    detect: async () => detection(),
    disable: async () => {
      state.disableCalls += 1;
      state.running = false;
      return { changed: true, requiresRestart: true, status: "succeeded" };
    },
    health: async (context) => {
      if (failVerification && state.running && context.environment.HTTPS_PROXY !== undefined) {
        return {
          details: {
            autostart: false,
            portAccepting: false,
            requests: 0,
            restarts: 0,
            running: true,
          },
          issues: [{ code: "forced-health-failure", message: "forced", retryable: true }],
          status: "failed",
        };
      }
      return {
        details: {
          autostart: false,
          pid: state.running ? 123 : undefined,
          port: state.running ? 7788 : undefined,
          portAccepting: state.running,
          requests: 0,
          restarts: 0,
          running: state.running,
        },
        issues: state.running
          ? []
          : [{ code: "llmtrim-daemon-stopped", message: "stopped", retryable: true }],
        status: state.running ? "healthy" : "unavailable",
      };
    },
    install: async () => {
      state.available = true;
      state.installed = true;
      return {
        changed: true,
        details: { version: "0.12.0" },
        requiresRestart: false,
        status: "succeeded",
      };
    },
  };
  return { adapter, state };
};

const claudeRunner = async (invocation) => {
  if (basename(invocation.command) === "claude" && invocation.arguments[0] === "--version") {
    return { exitCode: 0, stderr: "", stdout: "2.1.139 (Claude Code)\n" };
  }
  if (invocation.command === "npm" && invocation.arguments[0] === "uninstall") {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  return { errorCode: "ENOENT", exitCode: null, stderr: "", stdout: "" };
};

const createAdapter = (llmtrim, overrides = {}) =>
  createClaudeAdapter({
    llmtrim,
    managedSettingsPaths: [],
    now: () => new Date("2026-09-14T12:34:56.789Z"),
    runCommand: claudeRunner,
    squeezRunCommand: fakeSqueezRunner,
    stageSqueezHooks: stagedHooks,
    validateScript: () => null,
    ...overrides,
  });

test("Claude installation preserves settings, private backups, and idempotence", async () => {
  const fixture = createFixture({
    settings: `${JSON.stringify(
      {
        env: { KEEP: "preserved", HTTPS_PROXY: "http://upstream.example" },
        hooks: {
          SessionStart: [{ hooks: [{ command: "/user/hook", type: "command" }] }],
        },
        unknown: { nested: true },
      },
      null,
      2,
    )}\n`,
  });
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);
  const hookCapabilities = await adapter.capabilities(fixture.context);
  assert.equal(
    hookCapabilities.find((capability) => capability.name === "input-rewrite").issue.code,
    "claude-hook-activation-unverified",
  );

  const first = await adapter.install(fixture.context, { config: structuredClone(DEFAULT_CONFIG) });
  assert.equal(first.status, "succeeded");
  assert.equal(first.changed, true);
  assert.equal(first.requiresRestart, true);
  assert.equal(first.details.settings.changed, true);
  assert.deepEqual(first.details.squeez.features, ["bash-wrap"]);
  assert.equal(first.details.squeez.state, "configured");
  assert.equal(first.details.backupPaths.length, 2);
  for (const backupPath of first.details.backupPaths) {
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  }

  const installed = JSON.parse(readFileSync(fixture.settingsPath, "utf8"));
  assert.deepEqual(installed.unknown, { nested: true });
  assert.deepEqual(installed.hooks.SessionStart, [
    { hooks: [{ command: "/user/hook", type: "command" }] },
  ]);
  assert.equal(installed.env.KEEP, "preserved");
  assert.equal(installed.env.API_SECRET, undefined);
  assert.equal(installed.env.HTTPS_PROXY, "http://127.0.0.1:7788");
  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.equal(installed.hooks.PreToolUse[0].matcher, "^Bash$");
  assert.deepEqual(installed.hooks.PreToolUse[0].hooks[0].args, []);
  const hookPath = installed.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(readFileSync(hookPath, "utf8"), `${SCRIPT_MARKER}exit 0\n`);
  assert.equal(statSync(hookPath).mode & 0o777, 0o700);

  const backupNamesBefore = readdirSync(join(fixture.homeDirectory, ".claude"), {
    recursive: true,
  }).filter((name) => String(name).includes(".szal-backup."));
  const second = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });
  const backupNamesAfter = readdirSync(join(fixture.homeDirectory, ".claude"), {
    recursive: true,
  }).filter((name) => String(name).includes(".szal-backup."));

  assert.equal(second.status, "succeeded");
  assert.equal(second.changed, false);
  assert.equal(second.requiresRestart, false);
  assert.equal(second.details.settings.changed, false);
  assert.deepEqual(second.details.backupPaths, []);
  assert.deepEqual(backupNamesAfter, backupNamesBefore);
});

test("aggressive ownership installs only anchored tool hooks and no lifecycle entries", async () => {
  const fixture = createFixture();
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);
  const config = structuredClone(DEFAULT_CONFIG);
  config.profile = "aggressive";

  const result = await adapter.install(fixture.context, { config });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.details.squeez.features, [
    "bash-wrap",
    "hard-tool-budget",
    "tool-output-rewrite",
  ]);
  const settings = JSON.parse(readFileSync(fixture.settingsPath, "utf8"));
  assert.deepEqual(
    settings.hooks.PreToolUse.map((entry) => entry.matcher),
    ["^Bash$", "^(Read|Grep|Glob)$"],
  );
  assert.deepEqual(
    settings.hooks.PostToolUse.map((entry) => entry.matcher),
    ["^(Read|Grep|Glob)$"],
  );
  for (const event of ["SessionStart", "SubagentStop", "PreCompact", "PostCompact", "Stop"]) {
    assert.equal(settings.hooks[event], undefined);
  }
  assert.equal(readdirSync(join(fixture.homeDirectory, ".claude")).includes("CLAUDE.md"), false);
});

test("hook policy restrictions disable optional squeez without blocking transport", async () => {
  const fixture = createFixture({ settings: '{"disableAllHooks":true}\n' });
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);

  const capabilities = await adapter.capabilities(fixture.context);
  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(
    capabilities.find((capability) => capability.name === "input-rewrite").status,
    "unavailable",
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.details.squeez.features, []);
  assert.equal(result.details.llmtrim.compression, "enabled");
  const settings = JSON.parse(readFileSync(fixture.settingsPath, "utf8"));
  assert.equal(settings.hooks, undefined);
});

test("absolute CLAUDE_CONFIG_DIR controls the user settings location", async () => {
  const fixture = createFixture();
  const customDirectory = join(fixture.homeDirectory, "custom-claude");
  mkdirSync(customDirectory, { recursive: true });
  fixture.context.environment.CLAUDE_CONFIG_DIR = customDirectory;
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);

  const detection = await adapter.detect(fixture.context);
  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(detection.status, "available");
  assert.equal(detection.details.settingsPath, join(customDirectory, "settings.json"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.details.settings.path, join(customDirectory, "settings.json"));
});

test("managed hook policy takes precedence and old Claude versions degrade output rewriting", async () => {
  const fixture = createFixture({ settings: '{"disableAllHooks":true}\n' });
  const managedPath = join(fixture.homeDirectory, "managed-settings.json");
  writeFileSync(managedPath, '{"disableAllHooks":false}\n');
  const fake = createFakeLlmtrim();
  const oldVersionRunner = async (invocation) =>
    basename(invocation.command) === "claude"
      ? { exitCode: 0, stderr: "", stdout: "2.1.118 (Claude Code)\n" }
      : claudeRunner(invocation);
  const adapter = createAdapter(fake.adapter, {
    managedSettingsPaths: [managedPath],
    runCommand: oldVersionRunner,
  });

  const detection = await adapter.detect(fixture.context);
  const capabilities = await adapter.capabilities(fixture.context);

  assert.equal(detection.status, "available");
  assert.equal(detection.details.hookPolicy.status, "unverified");
  assert.equal(detection.details.hookSurface.toolOutputReplacement, false);
  assert.equal(
    capabilities.find((capability) => capability.name === "output-rewrite").status,
    "degraded",
  );
  assert.equal(
    capabilities.find((capability) => capability.name === "input-rewrite").status,
    "degraded",
  );
  const legacyAdapter = createAdapter(fake.adapter, {
    managedSettingsPaths: [managedPath],
    runCommand: async (invocation) =>
      basename(invocation.command) === "claude"
        ? { exitCode: 0, stderr: "", stdout: "2.0.99 (Claude Code)\n" }
        : claudeRunner(invocation),
  });
  const legacyCapabilities = await legacyAdapter.capabilities(fixture.context);
  assert.equal(
    legacyCapabilities.find((capability) => capability.name === "input-rewrite").status,
    "degraded",
  );

  writeFileSync(managedPath, '{"allowManagedHooksOnly":true,"disableAllHooks":false}\n');
  const restricted = await adapter.detect(fixture.context);
  assert.equal(restricted.status, "available");
  assert.equal(restricted.details.hookPolicy.status, "managed-only");
});

test("unrecognized Claude versions fail detection before settings mutation", async () => {
  const fixture = createFixture({ settings: '{"unknown":true}\n' });
  const before = readFileSync(fixture.settingsPath);
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter, {
    runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "Claude development build\n" }),
  });

  const detection = await adapter.detect(fixture.context);
  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(detection.status, "unavailable");
  assert.equal(detection.issue.code, "claude-version-invalid");
  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.ok(readFileSync(fixture.settingsPath).equals(before));
});

test("future Claude schemas fail closed while version reporting remains available", async () => {
  const fixture = createFixture({ settings: '{"unknown":true}\n' });
  const before = readFileSync(fixture.settingsPath);
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter, {
    runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "3.0.0 (Claude Code)\n" }),
  });

  const version = await adapter.version(fixture.context);
  const detection = await adapter.detect(fixture.context);
  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.deepEqual(version, { status: "available", version: "3.0.0" });
  assert.equal(detection.status, "unavailable");
  assert.equal(detection.issue.code, "claude-version-unsupported");
  assert.equal(result.status, "failed");
  assert.ok(readFileSync(fixture.settingsPath).equals(before));
});

test("Claude settings with llmtrim transport but missing environment state fail before mutation", async () => {
  const fixture = createFixture();
  writeFileSync(
    fixture.settingsPath,
    `${JSON.stringify({
      env: {
        HTTP_PROXY: "http://127.0.0.1:7788",
        HTTPS_PROXY: "http://127.0.0.1:7788",
        NODE_EXTRA_CA_CERTS: join(fixture.homeDirectory, ".llmtrim", "ca.pem"),
        NODE_USE_ENV_PROXY: "1",
        SZAL_LLMTRIM_DAEMON_CONFIGURATION: JSON.stringify({
          enableRecovery: true,
          pid: 123,
          preset: "auto",
          version: 1,
        }),
      },
    })}\n`,
    { mode: 0o600 },
  );
  const before = readFileSync(fixture.settingsPath);
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);

  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.issue.code, "claude-llmtrim-environment-state-missing");
  assert.ok(readFileSync(fixture.settingsPath).equals(before));
});

test("malformed settings and unmanaged squeez hooks fail before mutation", async () => {
  const malformed = createFixture({ settings: '{"hooks":{"PreToolUse":{}}}\n' });
  const malformedBefore = readFileSync(malformed.settingsPath);
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);

  const malformedResult = await adapter.install(malformed.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });
  assert.equal(malformedResult.status, "failed");
  assert.equal(malformedResult.changed, false);
  assert.equal(malformedResult.rolledBack, true);
  assert.ok(readFileSync(malformed.settingsPath).equals(malformedBefore));

  const overlap = createFixture({
    settings: `${JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                args: ["/home/user/.claude/squeez/hooks/posttooluse.sh"],
                command: "bash",
                type: "command",
              },
            ],
          },
        ],
      },
    })}\n`,
  });
  const overlapBefore = readFileSync(overlap.settingsPath);
  const overlapResult = await adapter.install(overlap.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });
  assert.equal(overlapResult.status, "failed");
  assert.equal(overlapResult.issue.code, "claude-unmanaged-squeez-hooks");
  assert.ok(readFileSync(overlap.settingsPath).equals(overlapBefore));
});

test("missing automatic engines leave absent settings untouched", async () => {
  const fixture = createFixture({ squeeze: false });
  const fake = createFakeLlmtrim({ available: false });
  const adapter = createAdapter(fake.adapter);

  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.changed, false);
  assert.equal(result.requiresRestart, false);
  assert.equal(result.details.settings.changed, false);
  assert.equal(result.details.llmtrim.installation, "skipped");
  assert.equal(result.details.squeez.state, "unavailable");
  assert.equal(result.details.backupPaths.length, 0);
  assert.equal(
    readdirSync(join(fixture.homeDirectory, ".claude")).includes("settings.json"),
    false,
  );
});

test("explicit missing squeez fails while automatic mode falls back safely", async () => {
  const fixture = createFixture({ squeeze: false });
  const fake = createFakeLlmtrim();
  const adapter = createAdapter(fake.adapter);
  const explicit = structuredClone(DEFAULT_CONFIG);
  explicit.engines.squeez.mode = "enabled";

  const failed = await adapter.install(fixture.context, { config: explicit });
  assert.equal(failed.status, "failed");
  assert.equal(failed.changed, false);
  assert.equal(failed.issue.code, "squeez-not-found");

  const automatic = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });
  assert.equal(automatic.status, "succeeded");
  assert.deepEqual(automatic.details.squeez.features, []);
  for (const category of [
    "conversation",
    "code",
    "bash",
    "tests",
    "json",
    "markdown",
    "responses",
  ]) {
    assert.equal(
      automatic.details.ownership.assignments.find((assignment) => assignment.category === category)
        .owner,
      "llmtrim",
    );
  }
  assert.equal(
    automatic.details.ownership.assignments.find((assignment) => assignment.category === "memory")
      .owner,
    null,
  );
});

test("post-install ownership preflight rolls back without recursive failure", async () => {
  const fixture = createFixture({ squeeze: false });
  const fake = createFakeLlmtrim({ available: false });
  let uninstallCalls = 0;
  const adapter = createAdapter(fake.adapter, {
    runCommand: async (invocation) => {
      if (invocation.command === "npm" && invocation.arguments[0] === "uninstall") {
        uninstallCalls += 1;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return claudeRunner(invocation);
    },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.engines.llmtrim.mode = "enabled";
  config.ownership.bash = "squeez";

  const result = await adapter.install(fixture.context, { config });

  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "claude-explicit-owner-unavailable");
  assert.equal(result.changed, true);
  assert.equal(result.rolledBack, true);
  assert.equal(uninstallCalls, 1);
});

test("failed verification removes llmtrim installed by the same transaction", async () => {
  const original = '{"unknown":"preserved"}\n';
  const fixture = createFixture({ settings: original, squeeze: false });
  const fake = createFakeLlmtrim({ available: false, failVerification: true });
  let uninstallCalls = 0;
  const adapter = createAdapter(fake.adapter, {
    runCommand: async (invocation) => {
      if (invocation.command === "npm" && invocation.arguments[0] === "uninstall") {
        uninstallCalls += 1;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return claudeRunner(invocation);
    },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.engines.llmtrim.mode = "enabled";
  config.engines.squeez.mode = "disabled";

  const result = await adapter.install(fixture.context, { config });

  assert.equal(result.status, "failed");
  assert.equal(result.changed, true);
  assert.equal(result.rolledBack, true);
  assert.equal(fake.state.installed, true);
  assert.equal(fake.state.disableCalls, 1);
  assert.equal(uninstallCalls, 1);
  assert.equal(readFileSync(fixture.settingsPath, "utf8"), original);
});

test("post-install health failure restores settings and newly published hooks", async () => {
  const original = '{"unknown":"preserved"}\n';
  const fixture = createFixture({ settings: original });
  const fake = createFakeLlmtrim({ failVerification: true });
  const adapter = createAdapter(fake.adapter);

  const result = await adapter.install(fixture.context, {
    config: structuredClone(DEFAULT_CONFIG),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.changed, true);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(fixture.settingsPath, "utf8"), original);
  assert.equal(fake.state.disableCalls, 1);
  assert.equal(
    readdirSync(join(fixture.homeDirectory, ".claude", "szal", "hooks")).includes(
      "squeez-pretooluse.sh",
    ),
    false,
  );
});
