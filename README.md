# szal

Szal is an agent-agnostic context virtualization layer for terminal-based coding agents.

This repository currently contains the TypeScript CLI foundation. Context compression, agent adapters, telemetry, and configuration are tracked in later milestones.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Development

```bash
npm install
npm test
npm link
```

After linking, the currently implemented commands are:

```bash
szal help
szal --version
```

## Design constraints

- Running the CLI must not modify project source.
- Agent-specific behavior belongs behind adapters.
- Szal orchestrates existing compression engines instead of implementing a custom compressor.
- No daemon is included in the CLI foundation.
