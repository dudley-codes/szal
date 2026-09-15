#!/usr/bin/env node

import { runCli } from "./cli/run-cli.js";
import { readPackageVersion } from "./package-metadata.js";

process.exitCode = await runCli(process.argv.slice(2), {
  version: readPackageVersion(),
});
