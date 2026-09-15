import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli/parse-arguments.js";
import { runCli } from "../dist/cli/run-cli.js";
import { REQUIRED_PRESERVATION_FIELDS } from "../dist/core/compression/index.js";
import {
  openSzalDatabase,
  recordTelemetrySession,
  resolveMemoryProject,
  storeMemoryItem,
} from "../dist/core/storage/index.js";

const ENABLED_MEMORY_POLICY = { enabled: true, maxItems: 10_000 };

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
const runExecutable = (arguments_, cwd = process.cwd(), environment = process.env) =>
  spawnSync(process.execPath, [resolve("dist/cli.js"), ...arguments_], {
    cwd,
    encoding: "utf8",
    env: environment,
  });

// Capture every repository path and file byte so CLI side effects cannot hide below the root.
const snapshotDirectory = (rootDirectory) => {
  const snapshot = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(rootDirectory, absolutePath);
      if (entry.isDirectory()) {
        snapshot.push({ kind: "directory", path });
        visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.push({
          bytes: readFileSync(absolutePath).toString("base64"),
          kind: "file",
          path,
        });
      } else {
        snapshot.push({ kind: "other", path });
      }
    }
  };

  visit(rootDirectory);
  return snapshot;
};

test("help aliases resolve to one command", () => {
  for (const alias of ["help", "--help", "-h"]) {
    assert.deepEqual(parseArguments([alias]), {
      command: "help",
      kind: "command",
    });
  }
});

test("version aliases resolve to one command", () => {
  for (const alias of ["version", "--version", "-v"]) {
    assert.deepEqual(parseArguments([alias]), {
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

test("doctor retains its JSON option for the handler", () => {
  assert.deepEqual(parseArguments(["doctor", "--json"]), {
    arguments_: ["--json"],
    command: "doctor",
    kind: "command",
  });
});

test("memory export retains project and format options for the handler", () => {
  assert.deepEqual(
    parseArguments(["memory", "export", "--project", "nested", "--current", "--json"]),
    {
      arguments_: ["export", "--project", "nested", "--current", "--json"],
      command: "memory",
      kind: "command",
    },
  );
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

test("config commands persist and retrieve global values with JSON output", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-config-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-project-"));
  const markerPath = join(projectDirectory, "source.txt");
  const environment = { ...process.env, XDG_CONFIG_HOME: join(homeDirectory, "config") };
  writeFileSync(markerPath, "canonical source\n");
  const beforeFiles = readdirSync(projectDirectory);

  try {
    const setResult = runExecutable(
      ["config", "set", "profile", "safe", "--json"],
      projectDirectory,
      environment,
    );
    const getResult = runExecutable(
      ["config", "get", "profile", "--json"],
      projectDirectory,
      environment,
    );
    const showResult = runExecutable(["config", "--json"], projectDirectory, environment);

    assert.equal(setResult.status, 0, setResult.stderr);
    assert.deepEqual(JSON.parse(setResult.stdout), { path: "profile", value: "safe" });
    assert.equal(getResult.status, 0, getResult.stderr);
    assert.equal(JSON.parse(getResult.stdout), "safe");
    assert.equal(showResult.status, 0, showResult.stderr);
    assert.equal(JSON.parse(showResult.stdout).profile, "safe");
    assert.deepEqual(readdirSync(projectDirectory), beforeFiles);
    assert.equal(readFileSync(markerPath, "utf8"), "canonical source\n");
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
    rmSync(projectDirectory, { force: true, recursive: true });
  }
});

test("memory export preserves history outside the repository across real CLI processes", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-home-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-project-"));
  const ambientDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-ambient-"));
  const emptyDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-empty-"));
  const nestedDirectory = join(projectDirectory, "src");
  const markerPath = join(nestedDirectory, "Widget.ts");
  const dataHome = join(homeDirectory, "data");
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    XDG_DATA_HOME: dataHome,
  };
  const exactError = "src/Widget.ts::build<T> must NOT change.\n```text\nerror TS2322\n```\n";

  try {
    execFileSync("git", ["init", "--quiet", projectDirectory]);
    execFileSync("git", ["init", "--quiet", ambientDirectory]);
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(markerPath, "export const canonical = true;\n");

    const storage = openSzalDatabase({ environment, homeDirectory });
    try {
      const project = resolveMemoryProject(storage.connection, nestedDirectory);
      recordTelemetrySession(storage.connection, {
        host: "cli-test",
        id: "session-1",
        mode: "on",
        projectId: project.id,
      });
      storeMemoryItem(
        storage.connection,
        project.id,
        {
          class: "decision",
          content: "Keep Widget<T>",
          createdAt: "2026-01-02T03:04:01.000Z",
          decision: { reason: "Preserve exact symbols", rejected: "Rename Widget" },
          id: "decision-1",
          representation: "exact",
          source: { sessionId: "session-1" },
          status: "selected",
        },
        ENABLED_MEMORY_POLICY,
      );
      storeMemoryItem(
        storage.connection,
        project.id,
        {
          class: "decision",
          content: "Keep Widget<T> and its path",
          createdAt: "2026-01-02T03:04:02.000Z",
          decision: { reason: "The path is provenance", rejected: "Keep only the name" },
          id: "decision-2",
          representation: "exact",
          source: { artifactUri: "artifact://plan/2", sessionId: "session-1" },
          status: "selected",
          supersedesId: "decision-1",
        },
        ENABLED_MEMORY_POLICY,
      );
      storeMemoryItem(
        storage.connection,
        project.id,
        {
          class: "error",
          content: exactError,
          createdAt: "2026-01-02T03:04:03.000Z",
          id: "error-1",
          representation: "exact",
          source: { artifactUri: "artifact://test/error" },
          status: "unknown",
        },
        ENABLED_MEMORY_POLICY,
      );
    } finally {
      storage.connection.close();
    }

    const before = snapshotDirectory(projectDirectory);
    const fullResult = runExecutable(["memory", "export", "--json"], nestedDirectory, environment);
    const ambientResult = runExecutable(["memory", "export", "--json"], nestedDirectory, {
      ...environment,
      GIT_DIR: join(ambientDirectory, ".git"),
      GIT_WORK_TREE: ambientDirectory,
    });
    const repeatedResult = runExecutable(
      ["memory", "export", "--project", "..", "--json"],
      nestedDirectory,
      environment,
    );
    const currentResult = runExecutable(
      ["memory", "export", "--current", "--json"],
      nestedDirectory,
      environment,
    );
    const markdownResult = runExecutable(["memory", "export"], nestedDirectory, environment);
    const emptyResult = runExecutable(["memory", "export", "--json"], emptyDirectory, environment);
    const invalidResult = runExecutable(
      ["memory", "export", "--unknown"],
      nestedDirectory,
      environment,
    );

    assert.equal(fullResult.status, 0, fullResult.stderr);
    assert.equal(ambientResult.status, 0, ambientResult.stderr);
    assert.equal(ambientResult.stdout, fullResult.stdout);
    assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
    assert.equal(repeatedResult.stdout, fullResult.stdout);
    const fullArchive = JSON.parse(fullResult.stdout);
    assert.equal(fullArchive.schemaVersion, 1);
    assert.equal(fullArchive.project.kind, "git-root");
    assert.equal(
      fullArchive.project.rootPath,
      execFileSync(
        "git",
        ["-C", projectDirectory, "rev-parse", "--path-format=absolute", "--show-toplevel"],
        { encoding: "utf8" },
      ).replace(/\r?\n$/, ""),
    );
    assert.deepEqual(
      fullArchive.items.map(({ content, id, status, supersedesId }) => ({
        content,
        id,
        status,
        supersedesId,
      })),
      [
        {
          content: "Keep Widget<T>",
          id: "decision-1",
          status: "superseded",
          supersedesId: null,
        },
        {
          content: "Keep Widget<T> and its path",
          id: "decision-2",
          status: "selected",
          supersedesId: "decision-1",
        },
        { content: exactError, id: "error-1", status: "unknown", supersedesId: null },
      ],
    );
    assert.equal(fullArchive.decisions[0].reason, "Preserve exact symbols");
    assert.equal(fullArchive.decisions[0].rejected, "Rename Widget");

    assert.equal(currentResult.status, 0, currentResult.stderr);
    const currentArchive = JSON.parse(currentResult.stdout);
    assert.deepEqual(
      currentArchive.items.map(({ id }) => id),
      ["decision-2", "error-1"],
    );
    assert.deepEqual(
      currentArchive.decisions.map(({ id }) => id),
      ["decision-2"],
    );

    assert.equal(markdownResult.status, 0, markdownResult.stderr);
    assert.match(markdownResult.stdout, /^# Structured Memory Archive\n\n````json\n/);
    assert.match(markdownResult.stdout, /error TS2322/);

    assert.equal(emptyResult.status, 0, emptyResult.stderr);
    const emptyArchive = JSON.parse(emptyResult.stdout);
    assert.equal(emptyArchive.project.kind, "cwd");
    assert.deepEqual(emptyArchive.items, []);
    assert.deepEqual(emptyArchive.decisions, []);

    assert.equal(invalidResult.status, 1);
    assert.equal(invalidResult.stdout, "");
    assert.match(invalidResult.stderr, /Unknown memory export option/);
    assert.deepEqual(snapshotDirectory(projectDirectory), before);
    assert.equal(existsSync(join(dataHome, "szal", "szal.db")), true);
    assert.equal(existsSync(join(projectDirectory, ".szal")), false);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
    rmSync(projectDirectory, { force: true, recursive: true });
    rmSync(ambientDirectory, { force: true, recursive: true });
    rmSync(emptyDirectory, { force: true, recursive: true });
  }
});

test("invalid config updates fail without changing the previous file", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-config-invalid-"));
  const configHome = join(homeDirectory, "config");
  const environment = { ...process.env, XDG_CONFIG_HOME: configHome };

  try {
    const initialResult = runExecutable(
      ["config", "set", "profile", "safe"],
      process.cwd(),
      environment,
    );
    const configPath = join(configHome, "szal", "config.json");
    const beforeBytes = readFileSync(configPath, "utf8");
    const invalidResult = runExecutable(
      ["config", "set", "profile", "maximum"],
      process.cwd(),
      environment,
    );
    const negativeResult = runExecutable(
      ["config", "set", "retention.telemetryDays", "-1"],
      process.cwd(),
      environment,
    );

    assert.equal(initialResult.status, 0, initialResult.stderr);
    assert.equal(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /profile.*safe.*balanced.*aggressive.*off/i);
    assert.equal(negativeResult.status, 1);
    assert.match(negativeResult.stderr, /retention\.telemetryDays.*non-negative integer/i);
    assert.equal(readFileSync(configPath, "utf8"), beforeBytes);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("doctor reports active ownership by content category without modifying the project", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-doctor-home-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-doctor-project-"));
  const binDirectory = join(homeDirectory, "bin");
  const executablePath = join(binDirectory, "squeez");
  const markerPath = join(projectDirectory, "source.txt");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(executablePath, "#!/bin/sh\nprintf 'squeez 1.46.0\\n'\n");
  chmodSync(executablePath, 0o700);
  writeFileSync(markerPath, "canonical source\n");
  const beforeFiles = readdirSync(projectDirectory);
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    PATH: binDirectory,
    XDG_CONFIG_HOME: join(homeDirectory, "config"),
  };

  try {
    const result = runExecutable(["doctor", "--json"], projectDirectory, environment);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.engines.squeez.status, "available");
    assert.equal(report.engines.squeez.version, "1.46.0");
    assert.equal(
      report.ownership.find((assignment) => assignment.category === "code").owner,
      "squeez",
    );
    assert.equal(
      report.ownership.find((assignment) => assignment.category === "conversation").owner,
      null,
    );
    assert.equal(
      report.ownership.find((assignment) => assignment.category === "cold-storage").owner,
      null,
    );
    assert.deepEqual(readdirSync(projectDirectory), beforeFiles);
    assert.equal(readFileSync(markerPath, "utf8"), "canonical source\n");
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
    rmSync(projectDirectory, { force: true, recursive: true });
  }
});

test("doctor degrades safely when optional squeez is missing", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-doctor-missing-"));
  const environment = { HOME: homeDirectory, PATH: "/nonexistent" };

  try {
    const result = runExecutable(["doctor"], process.cwd(), environment);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /squeez: UNAVAILABLE/);
    assert.match(result.stdout, /bash: RAW \[degraded\]/);
    assert.match(result.stdout, /cold-storage: RAW \[raw\]/);
    assert.match(result.stdout, /Status: DEGRADED/);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});

test("doctor fails closed when two active lossy engines claim one category", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-doctor-conflict-"));
  const stdout = [];
  const stderr = [];
  const bashCapability = {
    category: "bash",
    preserves: REQUIRED_PRESERVATION_FIELDS,
    safety: "lossy-recoverable",
  };

  try {
    const exitCode = runCli(
      ["doctor", "--json"],
      {
        compressionEngines: [
          {
            activeCategories: ["bash"],
            available: true,
            capabilities: [bashCapability],
            id: "llmtrim",
          },
          {
            activeCategories: ["bash"],
            available: true,
            capabilities: [bashCapability],
            id: "squeez",
          },
        ],
        environment: { PATH: "/nonexistent" },
        homeDirectory,
        version: "9.8.7",
      },
      {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message),
      },
    );
    const report = JSON.parse(stdout.join("\n"));
    const bash = report.ownership.find((assignment) => assignment.category === "bash");

    assert.equal(exitCode, 1);
    assert.equal(report.status, "failed");
    assert.equal(bash.state, "conflict");
    assert.deepEqual(bash.competingOwners, ["llmtrim", "squeez"]);
    assert.deepEqual(stderr, []);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
  }
});
