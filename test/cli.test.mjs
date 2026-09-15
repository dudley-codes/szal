import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
const captureCli = async (arguments_, options = {}) => {
  const stdout = [];
  const stderr = [];
  const exitCode = await runCli(
    arguments_,
    { ...options, version: "9.8.7" },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  );

  return { exitCode, stderr, stdout };
};

// Execute the compiled binary to verify the same interface users invoke after installation.
const runExecutable = (arguments_, cwd = process.cwd(), environment = process.env, input) =>
  spawnSync(process.execPath, [resolve("dist/cli.js"), ...arguments_], {
    cwd,
    encoding: "utf8",
    env: environment,
    ...(input === undefined ? {} : { input }),
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

test("install aliases resolve to the Claude target", () => {
  for (const alias of ["install", "-install", "--install"]) {
    assert.deepEqual(parseArguments([alias, "claude"]), {
      arguments_: ["claude"],
      command: "install",
      kind: "command",
    });
  }
});

test("uninstall resolves to its command", () => {
  assert.deepEqual(parseArguments(["uninstall", "pi"]), {
    arguments_: ["pi"],
    command: "uninstall",
    kind: "command",
  });
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

test("cold store and recall retain arguments for their handlers", () => {
  assert.deepEqual(parseArguments(["recall", "szal://cold/sha256/" + "a".repeat(64)]), {
    arguments_: ["szal://cold/sha256/" + "a".repeat(64)],
    command: "recall",
    kind: "command",
  });
  assert.deepEqual(parseArguments(["cold", "store", "--category", "bash"]), {
    arguments_: ["store", "--category", "bash"],
    command: "cold",
    kind: "command",
  });
});

test("no arguments show help", async () => {
  const result = await captureCli([]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join("\n"), /Szal 9\.8\.7/);
  assert.match(result.stdout.join("\n"), /Usage:/);
  assert.deepEqual(result.stderr, []);
});

test("version reports the injected package version", async () => {
  const result = await captureCli(["--version"]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, ["9.8.7"]);
  assert.deepEqual(result.stderr, []);
});

test("unknown commands fail with a help hint", async () => {
  const result = await captureCli(["frobnicate"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join("\n"), /Unknown command: frobnicate/);
  assert.match(result.stderr.join("\n"), /szal help/);
});

test("cold store and recall round-trip exact bytes through real CLI processes", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-cold-home-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-cold-project-"));
  const dataHome = join(homeDirectory, "data");
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    XDG_DATA_HOME: dataHome,
  };
  const payload = "first line\nsecond line without final newline";

  try {
    const before = snapshotDirectory(projectDirectory);
    const storeResult = runExecutable(
      ["cold", "store", "--category", "bash", "--source-tool", "bash"],
      projectDirectory,
      environment,
      payload,
    );

    assert.equal(storeResult.status, 0, storeResult.stderr);
    const id = storeResult.stdout.trim();
    assert.match(id, /^szal:\/\/cold\/sha256\/[a-f0-9]{64}$/);

    const recallResult = runExecutable(["recall", id], projectDirectory, environment);
    assert.equal(recallResult.status, 0, recallResult.stderr);
    assert.equal(recallResult.stdout, payload);
    assert.equal(recallResult.stderr, "");

    const invalidResult = runExecutable(
      ["recall", "szal://cold/nope"],
      projectDirectory,
      environment,
    );
    assert.equal(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /Usage: szal recall/);
    assert.deepEqual(snapshotDirectory(projectDirectory), before);
    assert.equal(existsSync(join(dataHome, "szal", "szal.db")), true);
    assert.equal(existsSync(join(projectDirectory, ".szal")), false);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
    rmSync(projectDirectory, { force: true, recursive: true });
  }
});

test("install aliases dispatch one Claude installer and report restart state", async () => {
  let calls = 0;
  const claudeAdapter = {
    install: async () => {
      calls += 1;
      return {
        changed: true,
        details: {
          backupPaths: ["/tmp/settings.backup"],
          claude: { executablePath: "/bin/claude", version: "2.1.119" },
          llmtrim: { compression: "enabled", installation: "existing" },
          ownership: { assignments: [], issues: [], profile: "balanced" },
          settings: { changed: true, path: "/tmp/settings.json" },
          squeez: { features: ["bash-wrap"], state: "configured", version: "1.48.9" },
        },
        requiresRestart: true,
        status: "succeeded",
      };
    },
  };

  for (const alias of ["install", "-install", "--install"]) {
    const result = await captureCli([alias, "claude"], { claudeAdapter });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.join("\n"), /Claude Code: 2\.1\.119/);
    assert.match(result.stdout.join("\n"), /Settings: updated/);
    assert.match(result.stdout.join("\n"), /Claude Code restart required: yes/);
    assert.deepEqual(result.stderr, []);
  }
  assert.equal(calls, 3);
});

test("install dispatches the Pi installer and reports reload state", async () => {
  let calls = 0;
  const piAdapter = {
    install: async () => {
      calls += 1;
      return {
        changed: true,
        details: {
          backupPaths: [],
          extension: { changed: true, path: "/tmp/pi/extensions/szal/index.ts" },
          pi: { configDirectory: "/tmp/pi", executablePath: "/bin/pi", version: "pi 1.2.3" },
        },
        requiresRestart: true,
        status: "succeeded",
      };
    },
  };

  const result = await captureCli(["install", "pi"], { piAdapter });

  assert.equal(result.exitCode, 0);
  assert.equal(calls, 1);
  assert.match(result.stdout.join("\n"), /Pi: pi 1\.2\.3 \(\/bin\/pi\)/);
  assert.match(result.stdout.join("\n"), /Config: \/tmp\/pi/);
  assert.match(result.stdout.join("\n"), /Extension: installed/);
  assert.match(result.stdout.join("\n"), /Pi restart\/reload required: yes/);
  assert.deepEqual(result.stderr, []);
});

test("uninstall dispatches the Pi uninstaller and reports reload state", async () => {
  let calls = 0;
  const piAdapter = {
    disable: async () => {
      calls += 1;
      return {
        changed: true,
        details: {
          backupPaths: [],
          extension: { changed: true, path: "/tmp/pi/extensions/szal/index.ts" },
          pi: { configDirectory: "/tmp/pi", executablePath: "/bin/pi", version: "pi 1.2.3" },
        },
        requiresRestart: true,
        status: "succeeded",
      };
    },
  };

  const result = await captureCli(["uninstall", "pi"], { piAdapter });

  assert.equal(result.exitCode, 0);
  assert.equal(calls, 1);
  assert.deepEqual(result.stdout, [
    "Extension: removed (/tmp/pi/extensions/szal/index.ts)",
    "Pi restart/reload required: yes",
  ]);
  assert.deepEqual(result.stderr, []);
});

test("install and uninstall reject unsupported targets and still report restart state", async () => {
  const installResult = await captureCli(["install", "other"]);
  const uninstallResult = await captureCli(["uninstall", "other"]);

  assert.equal(installResult.exitCode, 1);
  assert.deepEqual(installResult.stderr, ["Usage: szal install claude|pi"]);
  assert.deepEqual(installResult.stdout, ["Claude Code restart required: no"]);
  assert.equal(uninstallResult.exitCode, 1);
  assert.deepEqual(uninstallResult.stderr, ["Usage: szal uninstall pi"]);
  assert.deepEqual(uninstallResult.stdout, ["Pi restart/reload required: no"]);
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
  const result = runExecutable(["frobnicate"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: frobnicate/);
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

test("memory capture-host-lifecycle and recall round-trip current project memory", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-capture-home-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-memory-capture-project-"));
  const dataHome = join(homeDirectory, "data");
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    XDG_DATA_HOME: dataHome,
  };
  const candidates = [
    {
      class: "task",
      content: "Implement issue 51 vertical slice",
      key: "task:issue-51",
      status: "selected",
    },
    {
      class: "constraint",
      content: "Do not close ticket 51",
      key: "constraint:no-close",
      status: "selected",
    },
  ];

  try {
    const before = snapshotDirectory(projectDirectory);
    const captureArguments = [
      "memory",
      "capture-host-lifecycle",
      "--host",
      "pi",
      "--session-id",
      "pi-session-1",
      "--kind",
      "prompt-lifecycle",
      "--event-id",
      "prompt-event-1",
      "--project",
      ".",
      "--json",
    ];
    const first = runExecutable(
      captureArguments,
      projectDirectory,
      environment,
      JSON.stringify(candidates),
    );
    const second = runExecutable(
      captureArguments,
      projectDirectory,
      environment,
      JSON.stringify(candidates),
    );
    const recall = runExecutable(
      ["memory", "recall", "--query", "ticket 51", "--json"],
      projectDirectory,
      environment,
    );
    const bounded = runExecutable(
      ["memory", "recall", "--limit", "1"],
      projectDirectory,
      environment,
    );

    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      accepted: 2,
      projectId: JSON.parse(first.stdout).projectId,
      rejected: 0,
      schemaVersion: 1,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(recall.status, 0, recall.stderr);
    const recalled = JSON.parse(recall.stdout);
    assert.deepEqual(
      recalled.items.map(({ content, sourceEventKind, sourceHost }) => ({
        content,
        sourceEventKind,
        sourceHost,
      })),
      [
        {
          content: "Do not close ticket 51",
          sourceEventKind: "prompt-lifecycle",
          sourceHost: "pi",
        },
      ],
    );
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.match(bounded.stdout, /^## Szal memory\n- \[/);
    assert.equal((bounded.stdout.match(/^- \[/gmu) ?? []).length, 1);

    const storage = openSzalDatabase({ environment, homeDirectory });
    try {
      assert.equal(
        storage.connection.prepare("SELECT COUNT(*) FROM memory_items").pluck().get(),
        2,
      );
      assert.equal(
        storage.connection.prepare("SELECT COUNT(*) FROM memory_capture_rejections").pluck().get(),
        0,
      );
    } finally {
      storage.connection.close();
    }

    assert.deepEqual(snapshotDirectory(projectDirectory), before);
    assert.equal(existsSync(join(dataHome, "szal", "szal.db")), true);
    assert.equal(existsSync(join(projectDirectory, ".szal")), false);
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

test("the compiled -install Claude journey is safe and idempotent", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal cli claude home-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "szal-cli-claude-project-"));
  const binDirectory = join(homeDirectory, "bin");
  const claudeDirectory = join(homeDirectory, ".claude");
  const markerPath = join(projectDirectory, "source.txt");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(claudeDirectory, { recursive: true });
  writeFileSync(markerPath, "canonical source\n");
  writeFileSync(
    join(claudeDirectory, "settings.json"),
    `${JSON.stringify(
      {
        env: { KEEP: "preserved" },
        hooks: { SessionStart: [{ hooks: [{ command: "/user/hook", type: "command" }] }] },
        unknown: { retained: true },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(binDirectory, "claude"), "#!/bin/sh\nprintf '2.1.139 (Claude Code)\\n'\n");
  writeFileSync(
    join(binDirectory, "llmtrim"),
    `#!/bin/sh
state="$HOME/.fake-llmtrim-running"
case "$1" in
  --version)
    printf 'llmtrim 0.12.0\\n'
    ;;
  status)
    if [ -f "$state" ]; then
      printf '{"daemon":{"running":true,"port_accepting":true,"autostart":false,"health":"healthy","pid":4242,"port":7788,"restarts":0,"binary_version":"0.12.0","version":"0.12.0"},"input":{"before":0,"after":0},"requests":0}\\n'
    else
      printf '{"daemon":{"running":false,"port_accepting":false,"autostart":false,"health":"stopped","restarts":0,"binary_version":"0.12.0","version":"0.12.0"},"input":{"before":0,"after":0},"requests":0}\\n'
    fi
    ;;
  start)
    mkdir -p "$HOME/.llmtrim"
    printf 'test ca\\n' > "$HOME/.llmtrim/ca.pem"
    : > "$state"
    ;;
  stop)
    rm -f "$state"
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  writeFileSync(
    join(binDirectory, "squeez"),
    `#!/bin/sh
case "$1" in
  --version)
    printf 'squeez 1.48.9\\n'
    ;;
  setup)
    mkdir -p "$SQUEEZ_DIR/hooks"
    cat > "$SQUEEZ_DIR/hooks/pretooluse.sh" <<'HOOK'
#!/usr/bin/env bash
# 'permissionDecision': 'allow', harmless staged fixture
# d['tool_input']['command'] = squeez + ' wrap ' + shlex.quote(cmd)
exit 0
HOOK
    cat > "$SQUEEZ_DIR/hooks/posttooluse.sh" <<'HOOK'
#!/usr/bin/env bash
exit 0
HOOK
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  for (const executablePath of ["claude", "llmtrim", "squeez"].map((name) =>
    join(binDirectory, name),
  )) {
    chmodSync(executablePath, 0o700);
  }
  const environment = {
    HOME: homeDirectory,
    PATH: `${binDirectory}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(homeDirectory, "config"),
  };
  const beforeProjectFiles = readdirSync(projectDirectory);

  try {
    const first = runExecutable(["-install", "claude"], projectDirectory, environment);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Settings: updated/);
    assert.match(first.stdout, /llmtrim: existing; transport enabled/);
    assert.match(first.stdout, /squeez: configured bash-wrap/);
    assert.match(first.stdout, /Claude Code restart required: yes/);
    const settingsPath = join(claudeDirectory, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.unknown, { retained: true });
    assert.equal(settings.env.KEEP, "preserved");
    assert.deepEqual(settings.hooks.SessionStart, [
      { hooks: [{ command: "/user/hook", type: "command" }] },
    ]);
    assert.equal(settings.hooks.PreToolUse[0].matcher, "^Bash$");
    assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].args, []);
    const managedScript = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.doesNotMatch(readFileSync(managedScript, "utf8"), /permissionDecision.*allow/);
    assert.equal(statSync(managedScript).mode & 0o777, 0o700);
    const hookResult = spawnSync(managedScript, [], {
      encoding: "utf8",
      env: environment,
      input: "{}\n",
    });
    assert.equal(hookResult.status, 0, hookResult.stderr);
    const firstBackups = readdirSync(claudeDirectory, { recursive: true }).filter((entry) =>
      String(entry).includes(".szal-backup."),
    );
    assert.equal(firstBackups.length, 2);

    const second = runExecutable(["-install", "claude"], projectDirectory, environment);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Settings: unchanged/);
    assert.match(second.stdout, /Claude Code restart required: no/);
    const secondBackups = readdirSync(claudeDirectory, { recursive: true }).filter((entry) =>
      String(entry).includes(".szal-backup."),
    );
    assert.deepEqual(secondBackups, firstBackups);
    assert.deepEqual(readdirSync(projectDirectory), beforeProjectFiles);
    assert.equal(readFileSync(markerPath, "utf8"), "canonical source\n");
    assert.equal(readdirSync(claudeDirectory).includes("CLAUDE.md"), false);
    assert.equal(readdirSync(claudeDirectory).includes("commands"), false);
  } finally {
    rmSync(homeDirectory, { force: true, recursive: true });
    rmSync(projectDirectory, { force: true, recursive: true });
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
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "degraded");
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

test("doctor fails closed when two active lossy engines claim one category", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "szal-cli-doctor-conflict-"));
  const stdout = [];
  const stderr = [];
  const bashCapability = {
    category: "bash",
    preserves: REQUIRED_PRESERVATION_FIELDS,
    safety: "lossy-recoverable",
  };

  try {
    const exitCode = await runCli(
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
