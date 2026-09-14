import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfigPaths,
  setConfigValue,
  writeConfig,
} from "../dist/core/config/index.js";

const createTemporaryHome = () => mkdtempSync(join(tmpdir(), "szal-config-"));

test("config paths honor only absolute XDG config homes", () => {
  assert.equal(
    resolveConfigPaths({ XDG_CONFIG_HOME: "/custom/config" }, "/unused/home").configPath,
    "/custom/config/szal/config.json",
  );
  assert.equal(
    resolveConfigPaths({ XDG_CONFIG_HOME: "relative/config" }, "/safe/home").configPath,
    "/safe/home/.config/szal/config.json",
  );
});

test("missing config loads complete balanced defaults without writing", () => {
  const homeDirectory = createTemporaryHome();

  try {
    const loaded = loadConfig({ environment: {}, homeDirectory });

    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.exists, false);
    assert.deepEqual(readdirSync(homeDirectory), []);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("partial config merges with defaults and preserves unknown fields", () => {
  const homeDirectory = createTemporaryHome();
  const paths = resolveConfigPaths({}, homeDirectory);
  writeConfig(
    {
      ...DEFAULT_CONFIG,
      futureFeature: { enabled: true },
      profile: "safe",
      retention: { ...DEFAULT_CONFIG.retention, telemetryDays: 7 },
    },
    { paths },
  );

  try {
    const partial = JSON.parse(readFileSync(paths.configPath, "utf8"));
    delete partial.memory;
    partial.retention = { telemetryDays: 7 };
    writeFileSync(paths.configPath, `${JSON.stringify(partial, null, 2)}\n`);

    const loaded = loadConfig({ paths });

    assert.equal(loaded.config.profile, "safe");
    assert.equal(loaded.config.retention.telemetryDays, 7);
    assert.equal(loaded.config.retention.coldStorageDays, DEFAULT_CONFIG.retention.coldStorageDays);
    assert.deepEqual(loaded.config.memory, DEFAULT_CONFIG.memory);
    assert.deepEqual(loaded.config.futureFeature, { enabled: true });

    const updated = setConfigValue(loaded.config, "profile", "aggressive");
    writeConfig(updated, { paths });
    assert.deepEqual(JSON.parse(readFileSync(paths.configPath, "utf8")).futureFeature, {
      enabled: true,
    });
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("all compression profiles validate and invalid config errors name the field", () => {
  for (const profile of ["safe", "balanced", "aggressive", "off"]) {
    assert.equal(setConfigValue(DEFAULT_CONFIG, "profile", profile).profile, profile);
  }

  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "profile", "maximum"),
    /profile.*safe.*balanced.*aggressive.*off/i,
  );
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "retention.telemetryDays", -1),
    /retention\.telemetryDays.*non-negative integer/i,
  );
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "retention.telemeteryDays", 7),
    /Unknown configuration path.*telemeteryDays/i,
  );
});

test("compression ownership is configurable by category and rejects stacked values", () => {
  const configured = setConfigValue(DEFAULT_CONFIG, "ownership.code", "squeez");

  assert.equal(configured.ownership.code, "squeez");
  assert.equal(DEFAULT_CONFIG.ownership.code, "auto");
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "ownership.code", ["llmtrim", "squeez"]),
    /ownership\.code.*auto.*raw.*llmtrim.*squeez/i,
  );
});

test("model-window overrides require positive integer token counts", () => {
  const configured = setConfigValue(DEFAULT_CONFIG, "modelWindows.claude-opus-4-1", 200_000);

  assert.equal(configured.modelWindows["claude-opus-4-1"], 200_000);
  assert.throws(
    () => setConfigValue(configured, "modelWindows.invalid", 0),
    /modelWindows\.invalid.*positive integer/i,
  );
});

test("writes are private, atomic, backed up, and leave no temporary files", () => {
  const homeDirectory = createTemporaryHome();
  const paths = resolveConfigPaths({}, homeDirectory);
  const firstConfig = setConfigValue(DEFAULT_CONFIG, "profile", "safe");
  const secondConfig = setConfigValue(firstConfig, "profile", "aggressive");

  try {
    writeConfig(firstConfig, { paths });
    const firstBytes = readFileSync(paths.configPath, "utf8");
    writeConfig(secondConfig, { paths });

    assert.equal(JSON.parse(readFileSync(paths.configPath, "utf8")).profile, "aggressive");
    assert.equal(readFileSync(paths.backupPath, "utf8"), firstBytes);
    assert.equal(statSync(paths.configDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(paths.configPath).mode & 0o777, 0o600);
    assert.equal(statSync(paths.backupPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(paths.configDirectory).sort(), ["config.json", "config.json.bak"]);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("invalid existing configuration is not overwritten", () => {
  const homeDirectory = createTemporaryHome();
  const paths = resolveConfigPaths({}, homeDirectory);
  writeConfig(DEFAULT_CONFIG, { paths });
  const invalidBytes = '{"profile":"unsafe"}\n';
  writeFileSync(paths.configPath, invalidBytes);
  chmodSync(paths.configPath, 0o600);

  try {
    assert.throws(() => loadConfig({ paths }), /profile.*unsafe/i);
    assert.equal(readFileSync(paths.configPath, "utf8"), invalidBytes);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("unsafe unknown fields are rejected instead of merged", () => {
  const homeDirectory = createTemporaryHome();
  const paths = resolveConfigPaths({}, homeDirectory);
  writeConfig(DEFAULT_CONFIG, { paths });
  writeFileSync(paths.configPath, '{"__proto__":{"polluted":true}}\n');

  try {
    assert.throws(() => loadConfig({ paths }), /__proto__.*not a safe configuration field/i);
    assert.equal({}.polluted, undefined);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});
