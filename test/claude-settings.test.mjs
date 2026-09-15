import assert from "node:assert/strict";
import {
  chmodSync,
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
import { join } from "node:path";
import test from "node:test";

import {
  ClaudeSettingsError,
  listClaudeCommandHooks,
  patchClaudeSettings,
  serializeClaudeSettings,
} from "../dist/core/adapters/claude-settings.js";
import { FileTransactionError, commitFileTransaction } from "../dist/core/file-transaction.js";

const temporaryDirectories = new Set();
test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

const temporaryDirectory = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
};

const registration = (root, event, matcher, script) => ({
  event,
  handler: { command: join(root, script), timeout: 30, type: "command" },
  matcher,
});

test("Claude settings preserve unrelated fields and patch only exact owned tuples", () => {
  const root = "/private/claude/szal/hooks";
  const oldOwned = registration(root, "PreToolUse", "^Bash$", "pre.sh");
  const desired = registration(root, "PreToolUse", "^(Read|Grep|Glob)$", "pre.sh");
  const unrelated = {
    command: "/Users/example/bin/not-szal",
    timeout: 17,
    type: "command",
    unknownHandlerField: true,
  };
  const original = {
    env: { KEEP: "secret", HTTPS_PROXY: "http://old", UNKNOWN: "value" },
    hooks: {
      PostToolUse: [{ hooks: [unrelated], unknownGroupField: "kept" }],
      PreToolUse: [
        { hooks: [oldOwned.handler, unrelated], matcher: oldOwned.matcher },
        { hooks: [oldOwned.handler], matcher: oldOwned.matcher },
      ],
      SessionStart: [{ hooks: [{ command: "other", type: "command" }] }],
    },
    permissions: { allow: ["Read"] },
    unknownTopLevel: { nested: [1, true, null] },
  };

  const patched = patchClaudeSettings(original, {
    desiredHooks: [desired],
    environment: { HTTPS_PROXY: "http://127.0.0.1:7777" },
    knownHooks: [oldOwned, desired],
    managedEnvironmentKeys: ["HTTPS_PROXY", "HTTP_PROXY"],
  });

  assert.deepEqual(patched.permissions, original.permissions);
  assert.deepEqual(patched.unknownTopLevel, original.unknownTopLevel);
  assert.deepEqual(patched.env, {
    HTTPS_PROXY: "http://127.0.0.1:7777",
    KEEP: "secret",
    UNKNOWN: "value",
  });
  assert.deepEqual(patched.hooks.PostToolUse, original.hooks.PostToolUse);
  assert.deepEqual(patched.hooks.SessionStart, original.hooks.SessionStart);
  const commands = listClaudeCommandHooks(patched);
  assert.equal(
    commands.filter((entry) => entry.handler.command === desired.handler.command).length,
    1,
  );
  assert.equal(commands.filter((entry) => entry.handler.command === unrelated.command).length, 2);
  assert.ok(commands.some((entry) => entry.matcher === ""));
});

test("Claude settings remove owned hook paths embedded in command strings and args", () => {
  const root = "/private/claude/szal/hooks";
  const owned = registration(root, "PreToolUse", "^Bash$", "squeez-pretooluse.sh");
  const original = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { command: `/bin/bash ${owned.handler.command}`, type: "command" },
            { args: ["-n", owned.handler.command], command: "/bin/bash", type: "command" },
            { command: "/user/hook", type: "command" },
          ],
          matcher: "^Bash$",
        },
      ],
    },
  };

  const patched = patchClaudeSettings(original, {
    desiredHooks: [],
    environment: {},
    knownHooks: [owned],
    managedEnvironmentKeys: [],
  });

  assert.deepEqual(patched.hooks.PreToolUse, [
    { hooks: [{ command: "/user/hook", type: "command" }], matcher: "^Bash$" },
  ]);
});

test("Claude settings reject unsafe hook and environment shapes", () => {
  assert.throws(
    () =>
      patchClaudeSettings(
        { env: [] },
        {
          desiredHooks: [],
          environment: {},
          knownHooks: [],
          managedEnvironmentKeys: [],
        },
      ),
    ClaudeSettingsError,
  );
  assert.throws(
    () =>
      patchClaudeSettings(
        { hooks: { PreToolUse: {} } },
        {
          desiredHooks: [],
          environment: {},
          knownHooks: [],
          managedEnvironmentKeys: [],
        },
      ),
    /hooks\.PreToolUse must be an array/,
  );
  assert.throws(
    () => serializeClaudeSettings(JSON.parse('{"__proto__":{"polluted":true}}')),
    /not a safe settings field/,
  );
});

test("Claude file commits are private, timestamped, symlink-safe, and idempotent", () => {
  const root = temporaryDirectory("szal-claude-files-");
  const target = join(root, "real-settings.json");
  const link = join(root, "settings.json");
  writeFileSync(target, '{"before":true}\n', { mode: 0o644 });
  symlinkSync(target, link);

  const candidate = Buffer.from('{"after":true}\n');
  const committed = commitFileTransaction(
    [{ contents: candidate, mode: 0o600, path: link, validate: () => null }],
    { now: () => new Date("2026-09-14T12:34:56.789Z") },
  );

  assert.deepEqual(committed.changedPaths, [link]);
  assert.equal(committed.backupPaths.length, 1);
  assert.match(committed.backupPaths[0], /settings\.json\.szal-backup\.20260914T123456789Z$/);
  assert.equal(statSync(committed.backupPaths[0]).mode & 0o777, 0o600);
  assert.equal(readFileSync(committed.backupPaths[0], "utf8"), '{"before":true}\n');
  assert.equal(readFileSync(target, "utf8"), candidate.toString());
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".tmp")),
    [],
  );

  const second = commitFileTransaction([{ contents: candidate, mode: 0o600, path: link }]);
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(second.backupPaths, []);
});

test("a later validation failure restores every previously committed file byte-for-byte", () => {
  const root = temporaryDirectory("szal-claude-rollback-");
  const first = join(root, "first.sh");
  const second = join(root, "settings.json");
  writeFileSync(first, "first-before\n", { mode: 0o640 });
  writeFileSync(second, "second-before\n", { mode: 0o600 });

  assert.throws(
    () =>
      commitFileTransaction(
        [
          { contents: Buffer.from("first-after\n"), mode: 0o700, path: first },
          {
            contents: Buffer.from("second-after\n"),
            mode: 0o600,
            path: second,
            validate: () => "forced validation failure",
          },
        ],
        { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ),
    (error) => {
      assert.ok(error instanceof FileTransactionError);
      assert.equal(error.rolledBack, true);
      assert.equal(error.backupPaths.length, 2);
      return true;
    },
  );

  assert.equal(readFileSync(first, "utf8"), "first-before\n");
  assert.equal(statSync(first).mode & 0o777, 0o640);
  assert.equal(readFileSync(second, "utf8"), "second-before\n");
  assert.equal(statSync(second).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("symlink retargeting at publish time is rejected without overwriting the stale target", () => {
  const root = temporaryDirectory("szal-claude-symlink-race-");
  const firstTarget = join(root, "first-settings.json");
  const secondTarget = join(root, "second-settings.json");
  const link = join(root, "settings.json");
  writeFileSync(firstTarget, "first-before\n", { mode: 0o600 });
  writeFileSync(secondTarget, "second-before\n", { mode: 0o600 });
  symlinkSync(firstTarget, link);

  assert.throws(
    () =>
      commitFileTransaction([
        {
          contents: Buffer.from("installed\n"),
          mode: 0o600,
          path: link,
          validate: () => {
            rmSync(link);
            symlinkSync(secondTarget, link);
            return null;
          },
        },
      ]),
    (error) => {
      assert.ok(error instanceof FileTransactionError);
      assert.equal(error.rolledBack, false);
      return true;
    },
  );

  assert.equal(readFileSync(firstTarget, "utf8"), "first-before\n");
  assert.equal(readFileSync(secondTarget, "utf8"), "second-before\n");
  assert.equal(readFileSync(link, "utf8"), "second-before\n");
});

test("rollback refuses to overwrite a concurrent user edit", () => {
  const root = temporaryDirectory("szal-claude-race-");
  const path = join(root, "settings.json");
  writeFileSync(path, "before\n", { mode: 0o600 });
  const committed = commitFileTransaction([
    { contents: Buffer.from("installed\n"), mode: 0o600, path },
  ]);
  writeFileSync(path, "concurrent user edit\n", { mode: 0o600 });

  assert.equal(committed.rollback(), false);
  assert.equal(readFileSync(path, "utf8"), "concurrent user edit\n");
});

test("dangling settings symlinks are never replaced", () => {
  const root = temporaryDirectory("szal-claude-dangling-");
  const link = join(root, "settings.json");
  symlinkSync(join(root, "missing-target.json"), link);

  assert.throws(
    () =>
      commitFileTransaction([
        { contents: Buffer.from("{}\n"), mode: 0o600, path: link, validate: () => null },
      ]),
    /Refusing to replace dangling symbolic link/,
  );
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readdirSync(root).includes("settings.json"), true);
});

test("managed script updates refuse an unmarked destination", () => {
  const root = temporaryDirectory("szal-claude-owned-");
  const path = join(root, "hook.sh");
  writeFileSync(path, "#!/bin/sh\n# user file\n");
  chmodSync(path, 0o700);

  assert.throws(
    () =>
      commitFileTransaction([
        {
          contents: Buffer.from("#!/bin/sh\n# Managed by Szal\n"),
          mode: 0o700,
          ownedPrefix: Buffer.from("#!/bin/sh\n# Managed by Szal\n"),
          path,
        },
      ]),
    /Refusing to replace unowned file/,
  );
  assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\n# user file\n");
});
