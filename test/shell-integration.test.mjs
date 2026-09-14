import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  installShellIntegration,
  resolveShellConfigPath,
  resolveSupportedShell,
  restoreShellIntegration,
  uninstallShellIntegration,
} from "../dist/core/shell/index.js";

const fixedTime = () => new Date("2026-09-14T12:34:56.789Z");
const acceptConfig = () => null;

// Run each filesystem test in a disposable home so real shell configuration is never touched.
const withTemporaryHome = (run) => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-shell-"));
  try {
    return run(homeDirectory);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
};

const backupNames = (homeDirectory, configName) =>
  readdirSync(homeDirectory).filter((name) => name.startsWith(`${configName}.szal-backup.`));

test("supported shell selection accepts explicit values and detects SHELL", () => {
  assert.equal(resolveSupportedShell("bash", {}), "bash");
  assert.equal(resolveSupportedShell(undefined, { SHELL: "/opt/homebrew/bin/zsh" }), "zsh");
  assert.throws(() => resolveSupportedShell(undefined, { SHELL: "/bin/fish" }), /bash or zsh/);
  assert.throws(() => resolveShellConfigPath("bash", "relative-home"), /absolute path/);
});

for (const [shell, configName] of [
  ["bash", ".bashrc"],
  ["zsh", ".zshrc"],
]) {
  test(`${shell} install is idempotent and uninstall restores non-terminated content byte-for-byte`, () =>
    withTemporaryHome((homeDirectory) => {
      const configPath = join(homeDirectory, configName);
      const original = Buffer.from([0x23, 0x20, 0x75, 0x73, 0x65, 0x72, 0xff]);
      writeFileSync(configPath, original);

      const installed = installShellIntegration(shell, homeDirectory, {
        includeTerminalIdentifier: true,
        now: fixedTime,
        validator: acceptConfig,
      });
      const installedContent = readFileSync(configPath);

      assert.equal(installed.changed, true);
      assert.equal(installed.backupPath === null, false);
      assert.deepEqual(readFileSync(installed.backupPath), original);
      assert.equal(statSync(installed.backupPath).mode & 0o777, 0o600);
      assert.equal(installedContent.subarray(0, original.length).equals(original), true);
      assert.match(installedContent.toString("utf8"), /szal shell integration v1/);
      assert.match(installedContent.toString("utf8"), /SZAL_TERMINAL_ID="szal-\$\$"/);

      const repeated = installShellIntegration(shell, homeDirectory, {
        includeTerminalIdentifier: true,
        now: fixedTime,
        validator: acceptConfig,
      });

      assert.deepEqual(repeated, {
        backupPath: null,
        changed: false,
        configPath,
        shell,
      });
      assert.equal(backupNames(homeDirectory, configName).length, 1);

      const removed = uninstallShellIntegration(shell, homeDirectory, {
        now: fixedTime,
        validator: acceptConfig,
      });

      assert.equal(removed.changed, true);
      assert.deepEqual(readFileSync(configPath), original);
      assert.equal(backupNames(homeDirectory, configName).length, 2);
    }));
}

test("uninstall preserves unrelated content added after the owned block", () =>
  withTemporaryHome((homeDirectory) => {
    const configPath = join(homeDirectory, ".bashrc");
    const before = "export BEFORE=1\n";
    const after = "export AFTER=2\n";
    writeFileSync(configPath, before);
    installShellIntegration("bash", homeDirectory, { validator: acceptConfig });
    writeFileSync(configPath, Buffer.concat([readFileSync(configPath), Buffer.from(after)]));

    uninstallShellIntegration("bash", homeDirectory, { validator: acceptConfig });

    assert.equal(readFileSync(configPath, "utf8"), before + after);
  }));

test("failed validation leaves the original config unchanged and keeps its backup", () =>
  withTemporaryHome((homeDirectory) => {
    const configPath = join(homeDirectory, ".bashrc");
    const original = "export SAFE=value\n";
    writeFileSync(configPath, original);

    assert.throws(
      () =>
        installShellIntegration("bash", homeDirectory, {
          now: fixedTime,
          validator: () => "synthetic parser failure",
        }),
      /Validation failed.*left unchanged.*synthetic parser failure/,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(backupNames(homeDirectory, ".bashrc").length, 1);
  }));

test("partial or duplicate ownership markers fail safely without creating a backup", () =>
  withTemporaryHome((homeDirectory) => {
    const configPath = join(homeDirectory, ".bashrc");
    const original =
      "# >>> szal shell integration v1 (separator: none) >>>\n# >>> szal shell integration damaged\n# <<< szal shell integration <<<\n";
    writeFileSync(configPath, original);

    assert.throws(
      () => installShellIntegration("bash", homeDirectory, { validator: acceptConfig }),
      /incomplete or duplicate/,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.deepEqual(backupNames(homeDirectory, ".bashrc"), []);
  }));

test("restore recovers the exact most recent pre-change bytes", () =>
  withTemporaryHome((homeDirectory) => {
    const configPath = join(homeDirectory, ".zshrc");
    const original = Buffer.from("export ORIGINAL='yes'\n");
    writeFileSync(configPath, original);
    installShellIntegration("zsh", homeDirectory, {
      now: fixedTime,
      validator: acceptConfig,
    });

    const restored = restoreShellIntegration("zsh", homeDirectory, {
      now: () => new Date("2026-09-14T12:35:00.000Z"),
      validator: acceptConfig,
    });

    assert.equal(restored.changed, true);
    assert.deepEqual(readFileSync(configPath), original);
  }));

test("atomic writes preserve a symlinked shell configuration", () =>
  withTemporaryHome((homeDirectory) => {
    const targetPath = join(homeDirectory, "dotfiles-zshrc");
    const configPath = join(homeDirectory, ".zshrc");
    writeFileSync(targetPath, "export LINKED=1\n");
    symlinkSync(targetPath, configPath);

    installShellIntegration("zsh", homeDirectory, { validator: acceptConfig });

    assert.equal(lstatSync(configPath).isSymbolicLink(), true);
    assert.match(readFileSync(targetPath, "utf8"), /szal shell integration/);
  }));

for (const [shellName, configName, cleanArguments] of [
  ["bash", ".bashrc", ["--noprofile", "--norc"]],
  ["zsh", ".zshrc", ["-f"]],
]) {
  const unavailable = spawnSync(shellName, ["-c", "exit 0"]).error !== undefined;

  test(
    `the executable installs a valid ${shellName} function that mutates only its current shell`,
    { skip: unavailable ? `${shellName} is not installed` : false },
    () =>
      withTemporaryHome((homeDirectory) => {
        const executable = resolve("dist/cli.js");
        const environment = {
          ...process.env,
          HOME: homeDirectory,
          SHELL: `/bin/${shellName}`,
        };
        writeFileSync(join(homeDirectory, configName), "export USER_SETTING=preserved\n");

        const install = spawnSync(
          process.execPath,
          [executable, "shell", "install", shellName, "--terminal-id"],
          { encoding: "utf8", env: environment },
        );
        assert.equal(install.status, 0, install.stderr);
        assert.match(install.stdout, new RegExp(`Installed ${shellName} integration`));

        const shell = spawnSync(
          shellName,
          [
            ...cleanArguments,
            "-c",
            `source "$HOME/${configName}"; szal -on >/dev/null; printf "%s|%s|%s\\n" "$SZAL_ENABLED" "$SZAL_TERMINAL_ID" "$USER_SETTING"; szal -off >/dev/null; printf "%s\\n" "$SZAL_ENABLED"`,
          ],
          { encoding: "utf8", env: environment },
        );

        assert.equal(shell.status, 0, shell.stderr);
        assert.match(shell.stdout, /^1\|szal-[0-9]+\|preserved\n0\n$/);
        assert.equal(environment.SZAL_ENABLED, undefined);
      }),
  );
}

test("the executable rolls back when the real bash parser rejects the result", () =>
  withTemporaryHome((homeDirectory) => {
    const executable = resolve("dist/cli.js");
    const configPath = join(homeDirectory, ".bashrc");
    const original = "if then\n";
    writeFileSync(configPath, original);

    const result = spawnSync(process.execPath, [executable, "shell", "install", "bash"], {
      encoding: "utf8",
      env: { ...process.env, HOME: homeDirectory, SHELL: "/bin/bash" },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Validation failed.*left unchanged/);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(backupNames(homeDirectory, ".bashrc").length, 1);
  }));
