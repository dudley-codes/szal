import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ConfigPaths {
  backupPath: string;
  configDirectory: string;
  configPath: string;
}

// Resolve configuration outside repositories while honoring an absolute XDG override.
export const resolveConfigPaths = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory: string = homedir(),
): ConfigPaths => {
  const configuredHome = environment.XDG_CONFIG_HOME;
  const configHome =
    configuredHome !== undefined && configuredHome.length > 0 && isAbsolute(configuredHome)
      ? configuredHome
      : join(homeDirectory, ".config");
  const configDirectory = join(configHome, "szal");
  const configPath = join(configDirectory, "config.json");

  return {
    backupPath: `${configPath}.bak`,
    configDirectory,
    configPath,
  };
};
