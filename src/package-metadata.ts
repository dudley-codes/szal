import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

// Read the installed manifest so version output always matches the published package.
export const readPackageVersion = (): string => {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as PackageManifest;

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("The package manifest does not contain a valid version.");
  }

  return manifest.version;
};
