import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli/parse-arguments.js";
import { runCli } from "../dist/cli/run-cli.js";

// Capture injected command I/O for focused dispatch tests without spawning a process.
const captureCli = (arguments_) => {
  const stdout = [];
  const stderr = [];
  const exitCode = runCli(
    arguments_,
    { version: "9.8.7" },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  );

  return { exitCode, stderr, stdout };
};

// Execute the compiled binary to verify the same interface users invoke after installation.
const runExecutable = (arguments_, cwd = process.cwd()) =>
  spawnSync(process.execPath, [resolve("dist/cli.js"), ...arguments_], {
    cwd,
    encoding: "utf8",
  });

test("help aliases resolve to one command", () => {
  for (const alias of ["help", "--help", "-h"]) {
    assert.deepEqual(parseArguments([alias]), {
      arguments_: [],
      command: "help",
      kind: "command",
    });
  }
});

test("version aliases resolve to one command", () => {
  for (const alias of ["version", "--version", "-v"]) {
    assert.deepEqual(parseArguments([alias]), {
      arguments_: [],
      command: "version",
      kind: "command",
    });
  }
});

test("shell subcommands retain their arguments for the handler", () => {
  assert.deepEqual(parseArguments(["shell", "install", "zsh", "--terminal-id"]), {
    arguments_: ["install", "zsh", "--terminal-id"],
    command: "shell",
    kind: "command",
  });
});

test("no arguments show help", () => {
  const result = captureCli([]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join("\n"), /Szal 9\.8\.7/);
  assert.match(result.stdout.join("\n"), /Usage:/);
  assert.deepEqual(result.stderr, []);
});

test("version reports the injected package version", () => {
  const result = captureCli(["--version"]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, ["9.8.7"]);
  assert.deepEqual(result.stderr, []);
});

test("unknown commands fail with a help hint", () => {
  const result = captureCli(["install"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join("\n"), /Unknown command: install/);
  assert.match(result.stderr.join("\n"), /szal help/);
});

test("the executable exposes equivalent help aliases", () => {
  for (const arguments_ of [[], ["help"], ["--help"], ["-h"]]) {
    const result = runExecutable(arguments_);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Szal 0\.1\.0/);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
  }
});

test("the executable exposes equivalent version aliases", () => {
  for (const alias of ["version", "--version", "-v"]) {
    const result = runExecutable([alias]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.1.0\n");
    assert.equal(result.stderr, "");
  }
});

test("the executable returns a non-zero status for unknown commands", () => {
  const result = runExecutable(["install"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: install/);
});

test("the executable does not modify the current project", () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-project-"));
  const markerPath = join(projectDirectory, "source.txt");
  writeFileSync(markerPath, "canonical source\n");
  const beforeFiles = readdirSync(projectDirectory);
  const beforeContents = readFileSync(markerPath, "utf8");

  try {
    const result = runExecutable(["help"], projectDirectory);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.deepEqual(readdirSync(projectDirectory), beforeFiles);
    assert.equal(readFileSync(markerPath, "utf8"), beforeContents);
  } finally {
    rmSync(projectDirectory, { force: true, recursive: true });
  }
});
