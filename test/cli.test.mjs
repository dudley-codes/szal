import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli/parse-arguments.js";
import { runCli } from "../dist/cli/run-cli.js";

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

test("help aliases resolve to one command", () => {
  for (const alias of ["help", "--help", "-h"]) {
    assert.deepEqual(parseArguments([alias]), { command: "help", kind: "command" });
  }
});

test("version aliases resolve to one command", () => {
  for (const alias of ["version", "--version", "-v"]) {
    assert.deepEqual(parseArguments([alias]), { command: "version", kind: "command" });
  }
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

test("the executable does not modify the current project", () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-project-"));
  const markerPath = join(projectDirectory, "source.txt");
  writeFileSync(markerPath, "canonical source\n");
  const beforeFiles = readdirSync(projectDirectory);
  const beforeContents = readFileSync(markerPath, "utf8");

  try {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "help"], {
      cwd: projectDirectory,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.deepEqual(readdirSync(projectDirectory), beforeFiles);
    assert.equal(readFileSync(markerPath, "utf8"), beforeContents);
  } finally {
    rmSync(projectDirectory, { force: true, recursive: true });
  }
});
