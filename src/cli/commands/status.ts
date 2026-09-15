import {
  resolveRuntimeIndicator,
  resolveRuntimePolicy,
  resolveTerminalState,
  type CapabilityState,
  type TerminalMode,
} from "../../core/terminal/index.js";
import type { CliComponentStatus, CommandHandler } from "./types.js";

const STATUS_USAGE = `Usage:
  szal status [--state on|off]
  szal status [--state=on|off]`;

const parseStateOverride = (arguments_: readonly string[]): TerminalMode | undefined => {
  if (arguments_.length === 0) {
    return undefined;
  }

  if (arguments_.length === 1) {
    const match = /^--state=(on|off)$/.exec(arguments_[0] ?? "");
    return match?.[1] as TerminalMode | undefined;
  }

  if (
    arguments_.length === 2 &&
    arguments_[0] === "--state" &&
    (arguments_[1] === "on" || arguments_[1] === "off")
  ) {
    return arguments_[1];
  }

  return undefined;
};

const formatCapability = (
  label: string,
  capability: CliComponentStatus,
  forcedState?: CapabilityState,
  forcedDetail?: string,
): string => {
  const state = forcedState ?? capability.state;
  const detail = forcedDetail ?? capability.detail;
  return `${label}: ${state.toUpperCase()} - ${capability.name}${detail === undefined ? "" : ` (${detail})`}`;
};

// Report terminal policy separately from component health so OFF never looks uninstrumented.
export const runStatus: CommandHandler = (context) => {
  const stateOverride = parseStateOverride(context.arguments_);
  const hasStateOption = context.arguments_.some((argument) => argument.startsWith("--state"));
  if (context.arguments_.length > 0 && stateOverride === undefined) {
    context.stderr(
      hasStateOption ? "Invalid state override. Expected 'on' or 'off'." : STATUS_USAGE,
    );
    context.stderr(STATUS_USAGE);
    return 1;
  }

  const terminal = resolveTerminalState(context.environment, stateOverride);
  const indicator = resolveRuntimeIndicator(terminal);
  const policy = resolveRuntimePolicy(terminal);
  const defaultAgent: CliComponentStatus = {
    detail: "no active agent adapter detected",
    name: "not detected",
    state: "degraded",
  };
  const defaultEngine: CliComponentStatus = {
    detail: "no compression engine configured",
    name: "not configured",
    state: "degraded",
  };
  const agent = context.agent ?? defaultAgent;
  const engine = context.engine ?? defaultEngine;

  context.stdout(`Szal ${context.version}`);
  context.stdout(`Terminal state: ${terminal.capability.toUpperCase()} - ${terminal.detail}`);
  context.stdout(`Runtime indicator: ${indicator}`);
  context.stdout(`Terminal ID: ${terminal.terminalId ?? "not assigned"}`);
  context.stdout(`Project: ${context.projectDirectory}`);
  context.stdout(formatCapability("Agent", agent));
  context.stdout(
    policy.compression === "pass-through"
      ? formatCapability("Engine", engine, "inactive", "compression pass-through for this terminal")
      : formatCapability("Engine", engine),
  );
  context.stdout("Telemetry: ACTIVE - baseline measurement remains enabled");
  return 0;
};
