import assert from "node:assert/strict";
import test from "node:test";

import {
  createLlmtrimAdapter,
  createLlmtrimPassThroughMeasurement,
  diffLlmtrimTelemetry,
  extractLlmtrimRecallReferences,
} from "szal/adapters";

const HEALTHY_STATUS = {
  approximate: false,
  daemon: {
    autostart: true,
    binary_version: "0.13.4",
    env_port: 43117,
    health: "healthy",
    pid: 42,
    port: 43117,
    port_accepting: true,
    restarts: 0,
    running: true,
    uptime_secs: 120,
    version: "0.13.4",
  },
  input: { after: 700, before: 1_000, saved_pct: 30 },
  last_request_ts: "2026-09-14T12:00:00.000Z",
  output: { after: 50, before: 0, events: 1, saved_pct: 0 },
  requests: 3,
};

const commandResult = (stdout = "", exitCode = 0) => ({ exitCode, stderr: "", stdout });

const context = (environment = {}) => ({
  environment,
  homeDirectory: "/home/tester",
});

test("llmtrim detection reports version, health, and machine-readable capabilities", async () => {
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.arguments[0] === "--version") {
        return commandResult("llmtrim 0.13.4\n");
      }
      return commandResult(JSON.stringify(HEALTHY_STATUS));
    },
  });
  const routedContext = context({
    HTTPS_PROXY: "http://127.0.0.1:43117",
    HTTP_PROXY: "http://127.0.0.1:43117",
    NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
    http_proxy: "http://127.0.0.1:43117",
    https_proxy: "http://127.0.0.1:43117",
  });

  const detection = await adapter.detect(context());
  const version = await adapter.version(context());
  const health = await adapter.health(routedContext);
  const bypassedHealth = await adapter.health(
    context({
      ...routedContext.environment,
      https_proxy: "http://corporate-proxy.test:8080",
    }),
  );
  const capabilities = await adapter.capabilities(routedContext);

  assert.deepEqual(detection, {
    details: { command: "llmtrim", version: "0.13.4" },
    status: "available",
  });
  assert.deepEqual(version, { status: "available", version: "0.13.4" });
  assert.equal(health.status, "healthy");
  assert.equal(health.details.running, true);
  assert.equal(health.details.port, 43117);
  assert.equal(bypassedHealth.status, "degraded");
  assert.equal(bypassedHealth.issues[0].code, "llmtrim-transport-unconfigured");
  assert.deepEqual(
    capabilities.map(({ importance, name, status }) => ({ importance, name, status })),
    [
      { importance: "required", name: "request-compression", status: "available" },
      { importance: "optional", name: "request-recovery", status: "degraded" },
      { importance: "required", name: "pass-through-measurement", status: "available" },
    ],
  );
  assert.ok(calls.every(({ command }) => command === "llmtrim"));
});

test("a missing llmtrim binary leaves pass-through measurement available", async () => {
  const adapter = createLlmtrimAdapter({
    runCommand: async () => ({
      errorCode: "ENOENT",
      exitCode: null,
      stderr: "",
      stdout: "",
    }),
  });

  const detection = await adapter.detect(context());
  const health = await adapter.health(context());
  const capabilities = await adapter.capabilities(context());

  assert.equal(detection.status, "unavailable");
  assert.equal(detection.issue.code, "llmtrim-not-installed");
  assert.equal(health.status, "unavailable");
  assert.deepEqual(
    capabilities.map(({ name, status }) => ({ name, status })),
    [
      { name: "request-compression", status: "unavailable" },
      { name: "request-recovery", status: "unavailable" },
      { name: "pass-through-measurement", status: "available" },
    ],
  );
});

test("installation is idempotent and verifies the installed binary", async () => {
  let installed = false;
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.command === "npm") {
        installed = true;
        return commandResult();
      }
      return installed
        ? commandResult("llmtrim 0.13.4\n")
        : { errorCode: "ENOENT", exitCode: null, stderr: "", stdout: "" };
    },
  });

  const first = await adapter.install(context(), { packageManager: "npm" });
  const second = await adapter.install(context(), { packageManager: "npm" });

  assert.deepEqual(first, {
    changed: true,
    details: { version: "0.13.4" },
    requiresRestart: false,
    status: "succeeded",
  });
  assert.deepEqual(second, {
    changed: false,
    details: { version: "0.13.4" },
    requiresRestart: false,
    status: "succeeded",
  });
  assert.equal(calls.filter(({ command }) => command === "npm").length, 1);
  assert.deepEqual(calls.find(({ command }) => command === "npm").arguments, [
    "install",
    "--global",
    "@llmtrim/cli@latest",
  ]);
});

test("Claude transport startup composes an existing proxy and is idempotent", async () => {
  let running = false;
  let pid = 42;
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.arguments[0] === "--version") {
        return commandResult("llmtrim 0.13.4\n");
      }
      if (invocation.arguments[0] === "start") {
        running = true;
        pid += 1;
        return commandResult("Interceptor running\n");
      }
      const proxyUrl = "http://127.0.0.1:43117";
      const environmentConfigured = [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "https_proxy",
        "http_proxy",
      ].every((key) => invocation.environment[key] === proxyUrl);
      const status = running
        ? {
            ...HEALTHY_STATUS,
            daemon: {
              ...HEALTHY_STATUS.daemon,
              env_port: environmentConfigured ? 43117 : null,
              health: environmentConfigured ? "healthy" : "degraded",
              pid,
            },
          }
        : {
            ...HEALTHY_STATUS,
            daemon: {
              ...HEALTHY_STATUS.daemon,
              env_port: null,
              health: "stopped",
              pid: null,
              port: null,
              port_accepting: false,
              running: false,
              uptime_secs: null,
              version: null,
            },
          };
      return commandResult(JSON.stringify(status));
    },
  });
  const initialContext = context({
    HTTPS_PROXY: "http://ignored-proxy.test:8080",
    LLMTRIM_HOME: "/var/lib/llmtrim",
    NO_PROXY: "internal.test",
    https_proxy: "http://127.0.0.1:7890",
  });

  const first = await adapter.configure(initialContext, {
    enableRecovery: true,
    host: "claude",
    mode: "on",
    preset: "auto",
  });
  assert.equal(first.status, "succeeded");
  assert.equal(first.changed, true);
  assert.equal(first.requiresRestart, true);
  assert.equal(first.details.compression, "enabled");
  assert.equal(first.details.recovery, "enabled");
  assert.equal(first.details.environment.HTTPS_PROXY, "http://127.0.0.1:43117");
  assert.equal(first.details.environment.HTTP_PROXY, "http://127.0.0.1:43117");
  assert.equal(first.details.environment.https_proxy, "http://127.0.0.1:43117");
  assert.equal(first.details.environment.http_proxy, "http://127.0.0.1:43117");
  assert.equal(first.details.environment.SZAL_LLMTRIM_PROXY_URL, "http://127.0.0.1:43117");
  assert.equal(first.details.environment.NODE_EXTRA_CA_CERTS, "/var/lib/llmtrim/ca.pem");
  assert.match(first.details.environment.NO_PROXY, /internal\.test/);
  assert.match(first.details.environment.NO_PROXY, /localhost/);

  const startCall = calls.find(({ arguments: arguments_ }) => arguments_[0] === "start");
  assert.equal(startCall.environment.LLMTRIM_UPSTREAM_PROXY, "http://127.0.0.1:7890");
  assert.equal(startCall.environment.LLMTRIM_FIRST_ARRIVAL_RECALL, "true");
  assert.equal(startCall.environment.LLMTRIM_PRESET, "auto");

  const second = await adapter.configure(context(first.details.environment), {
    enableRecovery: true,
    host: "claude",
    mode: "on",
    preset: "auto",
  });
  assert.equal(second.status, "succeeded");
  assert.equal(second.changed, false);
  assert.equal(calls.filter(({ arguments: arguments_ }) => arguments_[0] === "start").length, 1);
  assert.equal(
    (await adapter.capabilities(context(first.details.environment))).find(
      ({ name }) => name === "request-recovery",
    ).status,
    "available",
  );
});

test("running daemon settings are restarted only when configuration changes", async () => {
  let pid = 42;
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.arguments[0] === "--version") {
        return commandResult("llmtrim 0.13.4\n");
      }
      if (invocation.arguments[0] === "start") {
        pid += 1;
        return commandResult("Interceptor running\n");
      }
      return commandResult(
        JSON.stringify({
          ...HEALTHY_STATUS,
          daemon: { ...HEALTHY_STATUS.daemon, pid },
        }),
      );
    },
  });

  const first = await adapter.configure(context(), {
    enableRecovery: true,
    host: "claude",
    mode: "on",
    preset: "auto",
  });
  const second = await adapter.configure(context(first.details.environment), {
    enableRecovery: false,
    host: "claude",
    mode: "on",
    preset: "safe",
  });
  const third = await adapter.configure(context(second.details.environment), {
    enableRecovery: false,
    host: "claude",
    mode: "on",
    preset: "safe",
  });

  const startCalls = calls.filter(({ arguments: arguments_ }) => arguments_[0] === "start");
  assert.equal(first.status, "succeeded");
  assert.equal(first.details.recovery, "enabled");
  assert.equal(second.status, "succeeded");
  assert.equal(second.details.recovery, "disabled");
  assert.equal(third.status, "succeeded");
  assert.equal(third.changed, false);
  assert.equal(startCalls.length, 2);
  assert.deepEqual(startCalls[0].arguments, ["start", "--force"]);
  assert.deepEqual(startCalls[1].arguments, ["start", "--force"]);
  assert.equal(startCalls[1].environment.LLMTRIM_PRESET, "safe");
  assert.equal(startCalls[1].environment.LLMTRIM_FIRST_ARRIVAL_RECALL, "false");
});

test("OFF mode restores the upstream proxy and records byte-identical pass-through", async () => {
  const adapter = createLlmtrimAdapter({
    runCommand: async () => commandResult("llmtrim 0.13.4\n"),
  });
  const off = await adapter.configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
      https_proxy: "http://127.0.0.1:43117",
      http_proxy: "http://127.0.0.1:43117",
      LLMTRIM_FIRST_ARRIVAL_RECALL: "true",
      LLMTRIM_UPSTREAM_PROXY: "http://corporate-proxy.test:8080",
      LLMTRIM_PRESET: "auto",
      NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
      SZAL_LLMTRIM_PROXY_URL: "http://127.0.0.1:43117",
    }),
    { enableRecovery: false, host: "claude", mode: "off", preset: "auto" },
  );
  const localProxy = await adapter.configure(context({ https_proxy: "http://127.0.0.1:7890" }), {
    enableRecovery: false,
    host: "claude",
    mode: "off",
    preset: "auto",
  });
  const measurement = createLlmtrimPassThroughMeasurement({
    model: "claude-sonnet",
    provider: "anthropic",
    rawBytes: 512,
    rawInputTokens: 128,
  });

  assert.equal(off.status, "succeeded");
  assert.equal(off.details.compression, "pass-through");
  assert.equal(off.details.environment.HTTPS_PROXY, "http://corporate-proxy.test:8080");
  assert.equal(off.details.environment.HTTP_PROXY, "http://corporate-proxy.test:8080");
  assert.equal(off.details.environment.https_proxy, "http://corporate-proxy.test:8080");
  assert.equal(off.details.environment.http_proxy, "http://corporate-proxy.test:8080");
  assert.equal("NODE_EXTRA_CA_CERTS" in off.details.environment, false);
  assert.equal("SZAL_LLMTRIM_PROXY_URL" in off.details.environment, false);
  assert.equal(localProxy.changed, false);
  assert.equal(localProxy.details.environment.https_proxy, "http://127.0.0.1:7890");
  assert.deepEqual(measurement, {
    approximate: false,
    compressed: false,
    inputBytesAfter: 512,
    inputBytesBefore: 512,
    inputTokensAfter: 128,
    inputTokensBefore: 128,
    mode: "off",
    model: "claude-sonnet",
    provider: "anthropic",
    requestCount: 1,
    source: "szal-pass-through",
  });
});

test("unhealthy startup never reports successful compression", async () => {
  const degraded = {
    ...HEALTHY_STATUS,
    daemon: { ...HEALTHY_STATUS.daemon, health: "degraded" },
  };
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) =>
      invocation.arguments[0] === "--version"
        ? commandResult("llmtrim 0.13.4\n")
        : commandResult(JSON.stringify(degraded)),
  });

  const result = await adapter.configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
      LLMTRIM_PRESET: "auto",
      NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
      SZAL_LLMTRIM_PROXY_URL: "http://127.0.0.1:43117",
      http_proxy: "http://127.0.0.1:43117",
      https_proxy: "http://127.0.0.1:43117",
    }),
    {
      enableRecovery: false,
      host: "claude",
      mode: "on",
      preset: "auto",
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "llmtrim-unhealthy");
  assert.equal(result.changed, true);
  assert.equal(result.rolledBack, false);
});

test("telemetry snapshots, deltas, and recall references are ledger-ready", async () => {
  const before = {
    approximate: false,
    capturedAt: "2026-09-14T12:00:00.000Z",
    inputTokensAfter: 100,
    inputTokensBefore: 100,
    lastRequestAt: "2026-09-14T11:59:00.000Z",
    requests: 1,
  };
  const after = {
    approximate: false,
    capturedAt: "2026-09-14T12:00:01.000Z",
    inputTokensAfter: 350,
    inputTokensBefore: 500,
    lastRequestAt: "2026-09-14T12:00:01.000Z",
    requests: 2,
  };
  const handle = `r_${"A".repeat(43)}`;
  const adapter = createLlmtrimAdapter({
    now: () => new Date("2026-09-14T12:00:01.000Z"),
    runCommand: async () => commandResult(JSON.stringify(HEALTHY_STATUS)),
  });

  assert.deepEqual(await adapter.readTelemetry(context()), {
    snapshot: {
      approximate: false,
      capturedAt: "2026-09-14T12:00:01.000Z",
      inputTokensAfter: 700,
      inputTokensBefore: 1_000,
      lastRequestAt: "2026-09-14T12:00:00.000Z",
      requests: 3,
    },
    status: "available",
  });
  assert.deepEqual(diffLlmtrimTelemetry(before, after, "on"), {
    approximate: false,
    compressed: true,
    inputTokensAfter: 250,
    inputTokensBefore: 400,
    mode: "on",
    requestCount: 1,
    source: "llmtrim-status",
  });
  assert.deepEqual(
    extractLlmtrimRecallReferences(
      `shortened output [llmtrim: full output: llmtrim recall ${handle}; if unavailable, re-run the tool] ${handle}`,
    ),
    [{ handle }],
  );
  assert.deepEqual(
    extractLlmtrimRecallReferences(`documentation says llmtrim recall ${handle}`),
    [],
  );
});
