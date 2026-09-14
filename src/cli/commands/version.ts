import type { CommandHandler } from "./types.js";

export const runVersion: CommandHandler = ({ stdout, version }) => {
  stdout(version);
  return 0;
};
