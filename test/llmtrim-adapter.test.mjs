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
    fileExists: async () => true,
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

test("NO_PROXY conflicts prevent active Claude compression", async () => {
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      return commandResult(JSON.stringify(HEALTHY_STATUS));
    },
  });
  const routedEnvironment = {
    HTTPS_PROXY: "http://127.0.0.1:43117",
    HTTP_PROXY: "http://127.0.0.1:43117",
    NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
    http_proxy: "http://127.0.0.1:43117",
    https_proxy: "http://127.0.0.1:43117",
  };

  const health = await adapter.health(context({ ...routedEnvironment, NO_PROXY: "*" }));
  const configuration = await adapter.configure(
    context({ ...routedEnvironment, no_proxy: "api.anthropic.com" }),
    { enableRecovery: true, host: "claude", mode: "on", preset: "auto" },
  );

  assert.equal(health.status, "degraded");
  assert.equal(health.issues[0].code, "llmtrim-no-proxy-conflict");
  assert.equal(configuration.status, "failed");
  assert.equal(configuration.changed, false);
  assert.equal(configuration.issue.code, "llmtrim-no-proxy-conflict");
  assert.equal(calls.filter(({ arguments: arguments_ }) => arguments_[0] === "start").length, 0);
});

test("recovery remains unavailable before llmtrim 0.12.0", async () => {
  let pid = 42;
  const oldStatus = () => ({
    ...HEALTHY_STATUS,
    daemon: {
      ...HEALTHY_STATUS.daemon,
      binary_version: "0.11.12",
      pid,
      version: "0.11.12",
    },
  });
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      if (invocation.arguments[0] === "--version") {
        return commandResult("llmtrim 0.11.12\n");
      }
      if (invocation.arguments[0] === "start") {
        pid += 1;
        return commandResult("Interceptor running\n");
      }
      return commandResult(JSON.stringify(oldStatus()));
    },
  });
  const routedContext = context({
    HTTPS_PROXY: "http://127.0.0.1:43117",
    HTTP_PROXY: "http://127.0.0.1:43117",
    NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
    http_proxy: "http://127.0.0.1:43117",
    https_proxy: "http://127.0.0.1:43117",
  });

  const configured = await adapter.configure(routedContext, {
    enableRecovery: true,
    host: "claude",
    mode: "on",
    preset: "auto",
  });
  const recovery = (await adapter.capabilities(context(configured.details.environment))).find(
    ({ name }) => name === "request-recovery",
  );

  assert.equal(configured.status, "succeeded");
  assert.equal(configured.details.compression, "enabled");
  assert.equal(configured.details.recovery, "unverified");
  assert.equal(recovery.status, "unavailable");
  assert.equal(recovery.issue.code, "llmtrim-recovery-unsupported");
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
  const installCall = calls.find(({ command }) => command === "npm");
  assert.deepEqual(installCall.arguments, ["install", "--global", "@llmtrim/cli@latest"]);
  assert.equal(installCall.timeoutMs, 120_000);
});

test("Claude transport startup composes an existing proxy and is idempotent", async () => {
  let running = false;
  let pid = 42;
  const calls = [];
  const adapter = createLlmtrimAdapter({
    fileExists: async () => true,
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
      const status = running
        ? {
            ...HEALTHY_STATUS,
            daemon: {
              ...HEALTHY_STATUS.daemon,
              env_port: null,
              health: "degraded",
              pid,
            },
          }
        : {
            ...HEALTHY_STATUS,
            daemon: {
              ...HEALTHY_STATUS.daemon,
              env_port: 43117,
              health: "degraded",
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
    NO_PROXY: "upper.internal",
    https_proxy: "http://127.0.0.1:7890",
    no_proxy: "lower.internal",
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
  assert.equal(first.details.environment.NODE_EXTRA_CA_CERTS, "/var/lib/llmtrim/ca.pem");
  assert.match(first.details.environment.NO_PROXY, /lower\.internal/);
  assert.match(first.details.environment.NO_PROXY, /upper\.internal/);
  assert.match(first.details.environment.NO_PROXY, /localhost/);
  assert.equal(first.details.environment.no_proxy, first.details.environment.NO_PROXY);

  const startCall = calls.find(({ arguments: arguments_ }) => arguments_[0] === "start");
  assert.deepEqual(startCall.arguments, ["start", "--force"]);
  assert.equal(startCall.environment.LLMTRIM_UPSTREAM_PROXY, "http://127.0.0.1:7890");
  assert.equal(startCall.environment.LLMTRIM_FIRST_ARRIVAL_RECALL, "true");
  assert.equal(startCall.environment.LLMTRIM_PRESET, "auto");
  assert.equal(startCall.timeoutMs, 20_000);

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
  const runCommand = async (invocation) => {
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
  };
  const adapter = createLlmtrimAdapter({ runCommand });
  const recreatedAdapter = createLlmtrimAdapter({
    runCommand,
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
  const third = await recreatedAdapter.configure(context(second.details.environment), {
    enableRecovery: false,
    host: "claude",
    mode: "on",
    preset: "safe",
  });
  const fourth = await recreatedAdapter.configure(
    context({
      ...third.details.environment,
      LLMTRIM_UPSTREAM_PROXY: "http://replacement-proxy.test:8080",
      no_proxy: "latest.internal",
    }),
    {
      enableRecovery: false,
      host: "claude",
      mode: "on",
      preset: "safe",
    },
  );
  const off = await recreatedAdapter.configure(context(fourth.details.environment), {
    enableRecovery: false,
    host: "claude",
    mode: "off",
    preset: "safe",
  });

  const startCalls = calls.filter(({ arguments: arguments_ }) => arguments_[0] === "start");
  assert.equal(first.status, "succeeded");
  assert.equal(first.details.recovery, "enabled");
  assert.equal(second.status, "succeeded");
  assert.equal(second.details.recovery, "disabled");
  assert.equal(third.status, "succeeded");
  assert.equal(third.changed, false);
  assert.equal(fourth.status, "succeeded");
  assert.equal(fourth.changed, true);
  assert.equal(startCalls.length, 3);
  assert.deepEqual(startCalls[0].arguments, ["start", "--force"]);
  assert.deepEqual(startCalls[1].arguments, ["start", "--force"]);
  assert.deepEqual(startCalls[2].arguments, ["start", "--force"]);
  assert.equal(startCalls[1].environment.LLMTRIM_PRESET, "safe");
  assert.equal(startCalls[1].environment.LLMTRIM_FIRST_ARRIVAL_RECALL, "false");
  assert.equal(
    startCalls[2].environment.LLMTRIM_UPSTREAM_PROXY,
    "http://replacement-proxy.test:8080",
  );
  assert.deepEqual(off.details.environment, {
    HTTPS_PROXY: "http://replacement-proxy.test:8080",
    HTTP_PROXY: "http://replacement-proxy.test:8080",
    LLMTRIM_UPSTREAM_PROXY: "http://replacement-proxy.test:8080",
    http_proxy: "http://replacement-proxy.test:8080",
    https_proxy: "http://replacement-proxy.test:8080",
    no_proxy: "latest.internal",
  });
});

test("OFF mode restores the upstream proxy and records byte-identical pass-through", async () => {
  let pid = 42;
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
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
  const originalEnvironment = {
    HTTPS_PROXY: "http://secure-proxy.test:8443",
    HTTP_PROXY: "http://plain-proxy.test:8080",
    LLMTRIM_FIRST_ARRIVAL_RECALL: "false",
    LLMTRIM_PRESET: "aggressive",
    LLMTRIM_UPSTREAM_PROXY: "http://preconfigured-upstream.test:8080",
    NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
    NODE_USE_ENV_PROXY: "0",
    NO_PROXY: "upper.internal",
    http_proxy: "http://lower-plain-proxy.test:8080",
    https_proxy: "http://lower-secure-proxy.test:8443",
    no_proxy: "lower.internal",
  };
  const on = await adapter.configure(context(originalEnvironment), {
    enableRecovery: true,
    host: "claude",
    mode: "on",
    preset: "auto",
  });
  const off = await adapter.configure(context(on.details.environment), {
    enableRecovery: false,
    host: "claude",
    mode: "off",
    preset: "auto",
  });
  const officialAdapter = createLlmtrimAdapter({
    runCommand: async () => commandResult(JSON.stringify(HEALTHY_STATUS)),
  });
  const officialOff = await officialAdapter.configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
      NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    }),
    { enableRecovery: false, host: "claude", mode: "off", preset: "auto" },
  );
  const officialOffWithoutCa = await officialAdapter.configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
    }),
    { enableRecovery: false, host: "claude", mode: "off", preset: "auto" },
  );
  const unverifiedOff = await createLlmtrimAdapter({
    runCommand: async () => commandResult("", 1),
  }).configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
    }),
    { enableRecovery: false, host: "claude", mode: "off", preset: "auto" },
  );
  const localProxy = await adapter.configure(context({ https_proxy: "http://127.0.0.1:7890" }), {
    enableRecovery: false,
    host: "claude",
    mode: "off",
    preset: "auto",
  });
  let aliasProbeCalls = 0;
  const aliasEnvironment = {
    NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
    https_proxy: "http://localhost:43117",
  };
  const trailingSlashEnvironment = {
    NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
    https_proxy: "http://127.0.0.1:43117/",
  };
  const aliasAdapter = createLlmtrimAdapter({
    runCommand: async () => {
      aliasProbeCalls += 1;
      return commandResult(JSON.stringify(HEALTHY_STATUS));
    },
  });
  const aliasProxy = await aliasAdapter.configure(context(aliasEnvironment), {
    enableRecovery: false,
    host: "claude",
    mode: "off",
    preset: "auto",
  });
  const trailingSlashProxy = await aliasAdapter.configure(context(trailingSlashEnvironment), {
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

  assert.equal(on.status, "succeeded");
  assert.equal(on.details.environment.LLMTRIM_UPSTREAM_PROXY, originalEnvironment.https_proxy);
  assert.equal(off.status, "succeeded");
  assert.equal(off.details.compression, "pass-through");
  assert.deepEqual(off.details.environment, originalEnvironment);
  assert.equal(officialOff.status, "succeeded");
  assert.equal("HTTPS_PROXY" in officialOff.details.environment, false);
  assert.equal("HTTP_PROXY" in officialOff.details.environment, false);
  assert.equal("NODE_EXTRA_CA_CERTS" in officialOff.details.environment, false);
  assert.equal(officialOffWithoutCa.status, "succeeded");
  assert.deepEqual(officialOffWithoutCa.details.environment, {});
  assert.equal(unverifiedOff.status, "failed");
  assert.equal(unverifiedOff.issue.code, "llmtrim-off-proxy-unverified");
  assert.equal(localProxy.changed, false);
  assert.equal(localProxy.details.environment.https_proxy, "http://127.0.0.1:7890");
  assert.equal(aliasProxy.status, "succeeded");
  assert.equal(aliasProxy.changed, false);
  assert.deepEqual(aliasProxy.details.environment, aliasEnvironment);
  assert.equal(trailingSlashProxy.status, "succeeded");
  assert.equal(trailingSlashProxy.changed, false);
  assert.deepEqual(trailingSlashProxy.details.environment, trailingSlashEnvironment);
  assert.equal(aliasProbeCalls, 0);
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

test("failed force restart reports conservative mutation metadata", async () => {
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.arguments[0] === "--version") {
        return commandResult("llmtrim 0.13.4\n");
      }
      if (invocation.arguments[0] === "start") {
        return commandResult("", 1);
      }
      return commandResult(JSON.stringify(HEALTHY_STATUS));
    },
  });
  const result = await adapter.configure(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
      NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
      http_proxy: "http://127.0.0.1:43117",
      https_proxy: "http://127.0.0.1:43117",
    }),
    { enableRecovery: true, host: "claude", mode: "on", preset: "safe" },
  );

  const startCall = calls.find(({ arguments: arguments_ }) => arguments_[0] === "start");
  assert.equal(result.status, "failed");
  assert.equal(result.changed, true);
  assert.equal(result.rolledBack, false);
  assert.deepEqual(startCall.arguments, ["start", "--force"]);
  assert.equal(startCall.timeoutMs, 20_000);
});

test("disable stops a daemon without relying on version detection", async () => {
  let running = true;
  const calls = [];
  const adapter = createLlmtrimAdapter({
    runCommand: async (invocation) => {
      calls.push(invocation);
      if (invocation.arguments[0] === "stop") {
        running = false;
        return commandResult("Interceptor stopped\n");
      }
      if (invocation.arguments[0] === "--version") {
        return commandResult("invalid version output");
      }
      return commandResult(
        JSON.stringify({
          ...HEALTHY_STATUS,
          daemon: {
            ...HEALTHY_STATUS.daemon,
            health: running ? "healthy" : "stopped",
            pid: running ? 42 : null,
            port: running ? 43117 : null,
            port_accepting: running,
            running,
            version: running ? "0.13.4" : null,
          },
        }),
      );
    },
  });
  const result = await adapter.disable(
    context({
      HTTPS_PROXY: "http://127.0.0.1:43117",
      HTTP_PROXY: "http://127.0.0.1:43117",
      NODE_EXTRA_CA_CERTS: "/home/tester/.llmtrim/ca.pem",
      http_proxy: "http://127.0.0.1:43117",
      https_proxy: "http://127.0.0.1:43117",
    }),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.changed, true);
  assert.equal(calls.filter(({ arguments: arguments_ }) => arguments_[0] === "stop").length, 1);
  assert.equal(
    calls.some(({ arguments: arguments_ }) => arguments_[0] === "--version"),
    false,
  );
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
  assert.deepEqual(diffLlmtrimTelemetry(before, after), {
    approximate: true,
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
