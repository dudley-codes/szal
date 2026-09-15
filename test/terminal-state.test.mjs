import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli/parse-arguments.js";
import { runCli } from "../dist/cli/run-cli.js";
import {
  renderTerminalStateExport,
  resolveRuntimeIndicator,
  resolveRuntimePolicy,
  resolveTerminalState,
} from "../dist/core/terminal/index.js";

const captureCli = async (arguments_, options = {}) => {
  const stdout = [];
  const stderr = [];
  const exitCode = await runCli(
    arguments_,
    {
      environment: {},
      projectDirectory: "/workspace/project",
      version: "9.8.7",
      ...options,
    },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  );

  return { exitCode, stderr, stdout };
};

const runExecutable = (arguments_, environment) =>
  spawnSync(process.execPath, [resolve("dist/cli.js"), ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });

test("short and long ON/OFF syntaxes share command handlers", async () => {
  for (const alias of ["on", "-on", "--on"]) {
    assert.deepEqual(parseArguments([alias]), {
      command: "on",
      kind: "command",
    });
    assert.match(
      (await captureCli([alias])).stdout.join("\n"),
      /Requested Szal terminal state: ON/,
    );
  }

  for (const alias of ["off", "-off", "--off"]) {
    assert.deepEqual(parseArguments([alias]), {
      command: "off",
      kind: "command",
    });
    assert.match(
      (await captureCli([alias])).stdout.join("\n"),
      /Requested Szal terminal state: OFF/,
    );
  }
});

test("shell export output is minimal and deterministic", async () => {
  assert.equal(renderTerminalStateExport("on"), "export SZAL_ENABLED=1");
  assert.equal(renderTerminalStateExport("off"), "export SZAL_ENABLED=0");
  assert.deepEqual((await captureCli(["on", "--shell-export"])).stdout, ["export SZAL_ENABLED=1"]);
  assert.deepEqual((await captureCli(["-off", "--shell-export"])).stdout, [
    "export SZAL_ENABLED=0",
  ]);
});

test("two terminal environments retain independent state and identifiers", () => {
  const terminalA = resolveTerminalState({ SZAL_ENABLED: "1", SZAL_TERMINAL_ID: "terminal-a" });
  const terminalB = resolveTerminalState({ SZAL_ENABLED: "0", SZAL_TERMINAL_ID: "terminal-b" });

  assert.deepEqual(
    {
      enabled: terminalA.enabled,
      id: terminalA.terminalId,
      indicator: resolveRuntimeIndicator(terminalA),
      policy: resolveRuntimePolicy(terminalA),
    },
    {
      enabled: true,
      id: "terminal-a",
      indicator: "ON",
      policy: { compression: "active", telemetry: "active" },
    },
  );
  assert.deepEqual(
    {
      enabled: terminalB.enabled,
      id: terminalB.terminalId,
      indicator: resolveRuntimeIndicator(terminalB),
      policy: resolveRuntimePolicy(terminalB),
    },
    {
      enabled: false,
      id: "terminal-b",
      indicator: "OFF",
      policy: { compression: "pass-through", telemetry: "active" },
    },
  );
});

test("explicit state overrides support non-interactive usage without changing the environment", async () => {
  const environment = { SZAL_ENABLED: "0", SZAL_TERMINAL_ID: "ci-terminal" };
  const result = await captureCli(["status", "--state=on"], { environment });
  const splitResult = await captureCli(["status", "--state", "off"], {
    environment: { SZAL_ENABLED: "1" },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join("\n"), /Terminal state: ACTIVE - explicit ON override/);
  assert.match(result.stdout.join("\n"), /Runtime indicator: ON/);
  assert.match(result.stdout.join("\n"), /Terminal ID: ci-terminal/);
  assert.match(splitResult.stdout.join("\n"), /Terminal state: INACTIVE - explicit OFF override/);
  assert.match(splitResult.stdout.join("\n"), /Runtime indicator: OFF/);
  assert.equal(environment.SZAL_ENABLED, "0");
});

test("status reports project and active agent and engine capabilities", async () => {
  const result = await captureCli(["status"], {
    agent: { name: "Claude Code", state: "active" },
    engine: { name: "llmtrim", state: "active" },
    environment: { SZAL_ENABLED: "1", SZAL_TERMINAL_ID: "terminal-1" },
  });
  const output = result.stdout.join("\n");

  assert.equal(result.exitCode, 0);
  assert.match(output, /Terminal state: ACTIVE/);
  assert.match(output, /Runtime indicator: ON/);
  assert.match(output, /Project: \/workspace\/project/);
  assert.match(output, /Agent: ACTIVE - Claude Code/);
  assert.match(output, /Engine: ACTIVE - llmtrim/);
  assert.match(output, /Telemetry: ACTIVE/);
});

test("status renders unsupported and failed integration states without changing semantics", async () => {
  for (const state of ["unsupported", "failed"]) {
    const result = await captureCli(["status"], {
      agent: { name: "Representative host", state },
      engine: { name: "Representative engine", state },
      environment: { SZAL_ENABLED: "1" },
    });

    assert.match(result.stdout.join("\n"), new RegExp(`Agent: ${state.toUpperCase()}`));
    assert.match(result.stdout.join("\n"), new RegExp(`Engine: ${state.toUpperCase()}`));
  }
});

test("OFF status is pass-through while telemetry and shared capabilities remain available", async () => {
  const result = await captureCli(["status"], {
    agent: { name: "Claude Code", state: "active" },
    engine: { name: "llmtrim", state: "active" },
    environment: { SZAL_ENABLED: "0" },
  });
  const output = result.stdout.join("\n");

  assert.match(output, /Terminal state: INACTIVE/);
  assert.match(output, /Runtime indicator: OFF/);
  assert.match(output, /Agent: ACTIVE - Claude Code/);
  assert.match(output, /Engine: INACTIVE - llmtrim \(compression pass-through for this terminal\)/);
  assert.match(output, /Telemetry: ACTIVE - baseline measurement remains enabled/);
});

test("invalid terminal state degrades safely instead of enabling compression", async () => {
  const state = resolveTerminalState({ SZAL_ENABLED: "maybe" });
  const result = await captureCli(["status"], { environment: { SZAL_ENABLED: "maybe" } });

  assert.deepEqual(resolveRuntimePolicy(state), {
    compression: "pass-through",
    telemetry: "active",
  });
  assert.equal(resolveRuntimeIndicator(state), "degraded");
  assert.match(result.stdout.join("\n"), /Terminal state: DEGRADED/);
  assert.match(result.stdout.join("\n"), /Runtime indicator: degraded/);
  assert.match(result.stdout.join("\n"), /Engine: INACTIVE/);
});

test("executable status keeps independently supplied terminal environments isolated", () => {
  const enabled = runExecutable(["status"], {
    SZAL_ENABLED: "1",
    SZAL_TERMINAL_ID: "terminal-a",
  });
  const disabled = runExecutable(["status"], {
    SZAL_ENABLED: "0",
    SZAL_TERMINAL_ID: "terminal-b",
  });

  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /Terminal state: ACTIVE/);
  assert.match(enabled.stdout, /Runtime indicator: ON/);
  assert.match(enabled.stdout, /Terminal ID: terminal-a/);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /Terminal state: INACTIVE/);
  assert.match(disabled.stdout, /Runtime indicator: OFF/);
  assert.match(disabled.stdout, /Terminal ID: terminal-b/);
  assert.match(disabled.stdout, /Telemetry: ACTIVE/);
});

test("invalid state override fails with actionable usage", async () => {
  const result = await captureCli(["status", "--state=maybe"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join("\n"), /Expected 'on' or 'off'/);
  assert.match(result.stderr.join("\n"), /Usage:/);
});
