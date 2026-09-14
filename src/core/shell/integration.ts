import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

export type SupportedShell = "bash" | "zsh";

export interface ShellIntegrationResult {
  backupPath: string | null;
  changed: boolean;
  configPath: string;
  shell: SupportedShell;
}

export type ShellConfigValidator = (shell: SupportedShell, configPath: string) => string | null;

interface ChangeOptions {
  now?: () => Date;
  validator?: ShellConfigValidator;
}

interface InstallOptions extends ChangeOptions {
  includeTerminalIdentifier?: boolean;
}

interface ManagedBlock {
  end: number;
  separator: "added" | "none";
  start: number;
}

const BEGIN_PREFIX = Buffer.from("# >>> szal shell integration");
const BEGIN_ADDED = Buffer.from("# >>> szal shell integration v1 (separator: added) >>>");
const BEGIN_NONE = Buffer.from("# >>> szal shell integration v1 (separator: none) >>>");
const END_MARKER = Buffer.from("# <<< szal shell integration <<<");
const BACKUP_INFIX = ".szal-backup.";

// Resolve an explicit shell or infer it from SHELL without accepting unsupported config files.
export const resolveSupportedShell = (
  requestedShell: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): SupportedShell => {
  const shellName = requestedShell ?? basename(environment.SHELL ?? "");

  if (shellName === "bash" || shellName === "zsh") {
    return shellName;
  }

  throw new Error("Unable to detect bash or zsh. Specify the shell explicitly.");
};

// Map supported shells to their interactive startup file in the supplied home directory.
export const resolveShellConfigPath = (shell: SupportedShell, homeDirectory: string): string => {
  if (!isAbsolute(homeDirectory)) {
    throw new Error("The home directory must be an absolute path.");
  }

  return join(homeDirectory, shell === "bash" ? ".bashrc" : ".zshrc");
};

// Install or update the owned block while retaining every byte outside its markers.
export const installShellIntegration = (
  shell: SupportedShell,
  homeDirectory: string,
  options: InstallOptions = {},
): ShellIntegrationResult => {
  const configPath = resolveShellConfigPath(shell, homeDirectory);
  const content = readConfig(configPath);
  const managedBlock = locateManagedBlock(content);
  const separator = managedBlock?.separator ?? chooseSeparator(content);
  const desiredBlock = renderManagedBlock(separator, options.includeTerminalIdentifier ?? false);
  const candidate =
    managedBlock === null
      ? Buffer.concat([content, desiredBlock])
      : Buffer.concat([
          content.subarray(0, managedBlock.start),
          desiredBlock,
          content.subarray(managedBlock.end),
        ]);

  if (candidate.equals(content)) {
    return { backupPath: null, changed: false, configPath, shell };
  }

  const backupPath = commitValidatedChange(configPath, content, candidate, shell, options);
  return { backupPath, changed: true, configPath, shell };
};

// Remove exactly the Szal-owned range and leave unrelated bytes untouched.
export const uninstallShellIntegration = (
  shell: SupportedShell,
  homeDirectory: string,
  options: ChangeOptions = {},
): ShellIntegrationResult => {
  const configPath = resolveShellConfigPath(shell, homeDirectory);
  const content = readConfig(configPath);
  const managedBlock = locateManagedBlock(content);

  if (managedBlock === null) {
    return { backupPath: null, changed: false, configPath, shell };
  }

  const candidate = Buffer.concat([
    content.subarray(0, managedBlock.start),
    content.subarray(managedBlock.end),
  ]);
  const backupPath = commitValidatedChange(configPath, content, candidate, shell, options);
  return { backupPath, changed: true, configPath, shell };
};

// Restore the most recent timestamped backup after validating it as shell syntax.
export const restoreShellIntegration = (
  shell: SupportedShell,
  homeDirectory: string,
  options: ChangeOptions = {},
): ShellIntegrationResult => {
  const configPath = resolveShellConfigPath(shell, homeDirectory);
  const backupPathToRestore = findLatestBackup(configPath);

  if (backupPathToRestore === null) {
    throw new Error(`No Szal backup exists for ${configPath}.`);
  }

  const content = readConfig(configPath);
  const candidate = readFileSync(backupPathToRestore);

  if (candidate.equals(content)) {
    return { backupPath: null, changed: false, configPath, shell };
  }

  const backupPath = commitValidatedChange(configPath, content, candidate, shell, options);
  return { backupPath, changed: true, configPath, shell };
};

const readConfig = (configPath: string): Buffer =>
  existsSync(configPath) ? readFileSync(configPath) : Buffer.alloc(0);

const chooseSeparator = (content: Buffer): ManagedBlock["separator"] =>
  content.length > 0 && content[content.length - 1] !== 0x0a ? "added" : "none";

// Locate one complete owned block and reject partial or duplicate markers as unsafe to edit.
const locateManagedBlock = (content: Buffer): ManagedBlock | null => {
  const addedStart = content.indexOf(BEGIN_ADDED);
  const noneStart = content.indexOf(BEGIN_NONE);
  const exactStarts = [addedStart, noneStart].filter((position) => position >= 0);
  const beginCount = countOccurrences(content, BEGIN_PREFIX);
  const endCount = countOccurrences(content, END_MARKER);

  if (beginCount === 0 && endCount === 0) {
    return null;
  }

  if (beginCount !== 1 || endCount !== 1 || exactStarts.length !== 1) {
    throw new Error(
      "The shell configuration contains an incomplete or duplicate Szal-owned block.",
    );
  }

  const markerStart = exactStarts[0];
  if (markerStart === undefined) {
    return null;
  }
  const separator: ManagedBlock["separator"] = markerStart === addedStart ? "added" : "none";
  const beginMarker = separator === "added" ? BEGIN_ADDED : BEGIN_NONE;
  const endMarkerStart = content.indexOf(END_MARKER, markerStart + beginMarker.length);

  if (endMarkerStart < 0) {
    throw new Error(
      "The shell configuration contains an incomplete or duplicate Szal-owned block.",
    );
  }

  let start = markerStart;
  if (separator === "added") {
    if (markerStart === 0 || content[markerStart - 1] !== 0x0a) {
      throw new Error("The Szal-owned block has an invalid separator.");
    }
    start -= 1;
  }

  let end = endMarkerStart + END_MARKER.length;
  if (content[end] === 0x0a) {
    end += 1;
  }

  return { end, separator, start };
};

// Count raw markers without decoding the surrounding user content.
const countOccurrences = (content: Buffer, marker: Buffer): number => {
  let count = 0;
  let position = content.indexOf(marker);

  while (position >= 0) {
    count += 1;
    position = content.indexOf(marker, position + marker.length);
  }

  return count;
};

// Render one portable function because aliases and child processes cannot mutate the parent shell.
const renderManagedBlock = (
  separator: ManagedBlock["separator"],
  includeTerminalIdentifier: boolean,
): Buffer => {
  const prefix = separator === "added" ? "\n" : "";
  const terminalIdentifier = includeTerminalIdentifier
    ? `
if [ -z "\${SZAL_TERMINAL_ID+x}" ]; then
  export SZAL_TERMINAL_ID="szal-$$"
fi
`
    : "";

  return Buffer.from(`${prefix}# >>> szal shell integration v1 (separator: ${separator}) >>>
# This block is managed by Szal. Use 'szal shell uninstall' to remove it.
${terminalIdentifier}
szal() {
  if [ "$#" -eq 1 ]; then
    case "\${1-}" in
      -on|--on|on)
        export SZAL_ENABLED=1
        printf '%s\\n' 'Szal is enabled in this terminal.'
        return 0
        ;;
      -off|--off|off)
        export SZAL_ENABLED=0
        printf '%s\\n' 'Szal is disabled in this terminal.'
        return 0
        ;;
    esac
  fi

  command szal "$@"
}
# <<< szal shell integration <<<
`);
};

// Back up first, validate a private temporary file, then atomically replace the config target.
const commitValidatedChange = (
  configPath: string,
  original: Buffer,
  candidate: Buffer,
  shell: SupportedShell,
  options: ChangeOptions,
): string => {
  const backupPath = createBackup(configPath, original, options.now ?? (() => new Date()));
  const targetPath = resolveWriteTarget(configPath);
  const targetMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : 0o600;
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.szal-${String(process.pid)}-${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(temporaryPath, candidate, { mode: targetMode });
    chmodSync(temporaryPath, targetMode);
    const validationError = (options.validator ?? validateWithShell)(shell, temporaryPath);

    if (validationError !== null) {
      throw new Error(
        `Validation failed; ${configPath} was left unchanged. ${validationError} Backup: ${backupPath}`,
      );
    }

    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return backupPath;
};

const resolveWriteTarget = (configPath: string): string => {
  try {
    return lstatSync(configPath).isSymbolicLink() ? realpathSync(configPath) : configPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return configPath;
    }
    throw error;
  }
};

// Use an exclusive filename so even identical clock values never overwrite an earlier backup.
const createBackup = (configPath: string, content: Buffer, now: () => Date): string => {
  const timestamp = now().toISOString().replaceAll(/[-:.]/g, "");
  const basePath = `${configPath}${BACKUP_INFIX}${timestamp}`;
  let attempt = 0;

  while (attempt <= Number.MAX_SAFE_INTEGER) {
    const backupPath = attempt === 0 ? basePath : `${basePath}.${String(attempt)}`;
    try {
      writeFileSync(backupPath, content, { flag: "wx", mode: 0o600 });
      chmodSync(backupPath, 0o600);
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      attempt += 1;
    }
  }

  throw new Error(`Unable to allocate a unique backup path for ${configPath}.`);
};

const findLatestBackup = (configPath: string): string | null => {
  const directory = dirname(configPath);
  const prefix = `${basename(configPath)}${BACKUP_INFIX}`;
  const backups = readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix))
    .sort((left, right) => right.localeCompare(left));
  const latest = backups[0];
  return latest === undefined ? null : join(directory, latest);
};

// Ask the user's actual shell parser to reject invalid edits before any replacement occurs.
const validateWithShell: ShellConfigValidator = (shell, configPath) => {
  const result = spawnSync(shell, ["-n", configPath], { encoding: "utf8" });

  if (result.error !== undefined) {
    return `Could not run ${shell}: ${result.error.message}`;
  }

  if (result.status !== 0) {
    return (
      result.stderr ||
      result.stdout ||
      `${shell} exited with status ${String(result.status)}.`
    ).trim();
  }

  return null;
};
