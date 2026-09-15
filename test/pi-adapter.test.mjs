import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiAdapter, PI_EXTENSION_OWNERSHIP_MARKER } from "../dist/core/adapters/index.js";

const temporaryDirectories = new Set();
test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

const executable = (path, contents = "#!/bin/sh\nprintf 'pi 1.2.3\\n'\n") => {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
};

const createFixture = ({ environment = {} } = {}) => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-pi-adapter-"));
  temporaryDirectories.add(homeDirectory);
  const binDirectory = join(homeDirectory, "bin");
  mkdirSync(binDirectory, { recursive: true });
  executable(join(binDirectory, "pi"));
  return {
    context: {
      environment: { HOME: homeDirectory, PATH: binDirectory, ...environment },
      homeDirectory,
      projectDirectory: join(homeDirectory, "project"),
    },
    homeDirectory,
  };
};

test("Pi detection reports executable, version, and default global config directory", async () => {
  const { context, homeDirectory } = createFixture();
  const result = await createPiAdapter().detect(context);

  assert.equal(result.status, "available");
  assert.equal(result.details.version, "pi 1.2.3");
  assert.equal(result.details.configDirectory, join(homeDirectory, ".pi", "agent"));
  assert.equal(
    result.details.extensionDirectory,
    join(homeDirectory, ".pi", "agent", "extensions", "szal"),
  );
  assert.equal(result.details.installed, false);
});

test("Pi detection honors absolute PI_CODING_AGENT_DIR", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-pi-config-"));
  temporaryDirectories.add(homeDirectory);
  const configDirectory = join(homeDirectory, "custom-pi-agent");
  const { context } = createFixture({ environment: { PI_CODING_AGENT_DIR: configDirectory } });

  const result = await createPiAdapter().detect(context);

  assert.equal(result.status, "available");
  assert.equal(result.details.configDirectory, configDirectory);
  assert.equal(result.details.extensionDirectory, join(configDirectory, "extensions", "szal"));
});

test("Pi detection ignores relative PI_CODING_AGENT_DIR", async () => {
  const { context, homeDirectory } = createFixture({
    environment: { PI_CODING_AGENT_DIR: "relative" },
  });

  const result = await createPiAdapter().detect(context);

  assert.equal(result.status, "available");
  assert.equal(result.details.configDirectory, join(homeDirectory, ".pi", "agent"));
});

test("Pi install creates the owned global extension and is idempotent", async () => {
  const { context, homeDirectory } = createFixture();
  const adapter = createPiAdapter({ now: () => new Date("2026-09-15T12:34:56.789Z") });

  const first = await adapter.install(context, {});
  const extensionPath = join(homeDirectory, ".pi", "agent", "extensions", "szal", "index.ts");

  assert.equal(first.status, "succeeded");
  assert.equal(first.changed, true);
  assert.equal(first.details.extension.path, extensionPath);
  assert.equal(first.details.extension.changed, true);
  assert.equal(first.requiresRestart, true);
  assert.equal(existsSync(extensionPath), true);
  assert.equal(readFileSync(extensionPath, "utf8").startsWith(PI_EXTENSION_OWNERSHIP_MARKER), true);

  const second = await adapter.install(context, {});

  assert.equal(second.status, "succeeded");
  assert.equal(second.changed, false);
  assert.equal(second.details.extension.changed, false);
  assert.equal(second.requiresRestart, false);
});

test("Pi install refuses to overwrite a non-Szal extension", async () => {
  const { context, homeDirectory } = createFixture();
  const extensionDirectory = join(homeDirectory, ".pi", "agent", "extensions", "szal");
  const extensionPath = join(extensionDirectory, "index.ts");
  mkdirSync(extensionDirectory, { recursive: true });
  writeFileSync(extensionPath, "// user extension\n", { mode: 0o600 });

  const result = await createPiAdapter().install(context, {});

  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(extensionPath, "utf8"), "// user extension\n");
});

test("Pi uninstall removes only the owned extension and empty directory", async () => {
  const { context, homeDirectory } = createFixture();
  const adapter = createPiAdapter();
  const installed = await adapter.install(context, {});
  assert.equal(installed.status, "succeeded");

  const extensionDirectory = join(homeDirectory, ".pi", "agent", "extensions", "szal");
  const removed = await adapter.disable(context);

  assert.equal(removed.status, "succeeded");
  assert.equal(removed.changed, true);
  assert.equal(removed.requiresRestart, true);
  assert.equal(existsSync(join(extensionDirectory, "index.ts")), false);
  assert.equal(existsSync(extensionDirectory), false);

  const absent = await adapter.disable(context);
  assert.equal(absent.status, "succeeded");
  assert.equal(absent.changed, false);
  assert.equal(absent.requiresRestart, false);
});

test("Pi uninstall refuses to remove a non-Szal extension", async () => {
  const { context, homeDirectory } = createFixture();
  const extensionDirectory = join(homeDirectory, ".pi", "agent", "extensions", "szal");
  const extensionPath = join(extensionDirectory, "index.ts");
  mkdirSync(extensionDirectory, { recursive: true });
  writeFileSync(extensionPath, "// user extension\n", { mode: 0o600 });

  const result = await createPiAdapter().disable(context);

  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(extensionPath, "utf8"), "// user extension\n");
});

test("Pi unavailable fails before writing", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-pi-missing-"));
  temporaryDirectories.add(homeDirectory);
  const context = {
    environment: { HOME: homeDirectory, PATH: join(homeDirectory, "empty") },
    homeDirectory,
  };

  const result = await createPiAdapter().install(context, {});

  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.equal(existsSync(join(homeDirectory, ".pi")), false);
});
