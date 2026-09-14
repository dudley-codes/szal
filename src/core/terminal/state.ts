export const SZAL_ENABLED_VARIABLE = "SZAL_ENABLED";
export const SZAL_TERMINAL_ID_VARIABLE = "SZAL_TERMINAL_ID";

export type CapabilityState = "active" | "disabled" | "degraded";
export type TerminalMode = "on" | "off";
export type TerminalStateSource = "default" | "environment" | "override";

export interface TerminalState {
  capability: CapabilityState;
  detail: string;
  enabled: boolean;
  mode: TerminalMode;
  source: TerminalStateSource;
  terminalId: string | null;
}

export interface RuntimePolicy {
  compression: "active" | "pass-through";
  telemetry: "active";
}

const resolveTerminalId = (
  environment: Readonly<Record<string, string | undefined>>,
): string | null => {
  const terminalId = environment[SZAL_TERMINAL_ID_VARIABLE]?.trim();
  return terminalId === undefined || terminalId.length === 0 ? null : terminalId;
};

// Resolve an explicit automation override before the current terminal's environment value.
export const resolveTerminalState = (
  environment: Readonly<Record<string, string | undefined>>,
  override?: TerminalMode,
): TerminalState => {
  const terminalId = resolveTerminalId(environment);

  if (override !== undefined) {
    return {
      capability: override === "on" ? "active" : "disabled",
      detail: `explicit ${override.toUpperCase()} override`,
      enabled: override === "on",
      mode: override,
      source: "override",
      terminalId,
    };
  }

  const configuredValue = environment[SZAL_ENABLED_VARIABLE];
  if (configuredValue === "1" || configuredValue === "0") {
    const enabled = configuredValue === "1";
    return {
      capability: enabled ? "active" : "disabled",
      detail: `${SZAL_ENABLED_VARIABLE}=${configuredValue}`,
      enabled,
      mode: enabled ? "on" : "off",
      source: "environment",
      terminalId,
    };
  }

  if (configuredValue !== undefined && configuredValue.length > 0) {
    return {
      capability: "degraded",
      detail: `${SZAL_ENABLED_VARIABLE} must be 1 or 0; using safe pass-through`,
      enabled: false,
      mode: "off",
      source: "environment",
      terminalId,
    };
  }

  return {
    capability: "disabled",
    detail: `${SZAL_ENABLED_VARIABLE} is unset; using safe pass-through`,
    enabled: false,
    mode: "off",
    source: "default",
    terminalId,
  };
};

// Turning compression off never disables the instrumentation needed for baseline comparisons.
export const resolveRuntimePolicy = (state: TerminalState): RuntimePolicy => ({
  compression: state.enabled ? "active" : "pass-through",
  telemetry: "active",
});

// Produce the small shell contract consumed by bash/zsh integration and automation.
export const renderTerminalStateExport = (mode: TerminalMode): string =>
  `export ${SZAL_ENABLED_VARIABLE}=${mode === "on" ? "1" : "0"}`;
