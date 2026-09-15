// Managed by Szal: Pi global extension v1

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("szal", {
    description: "Show Szal Pi extension status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Szal Pi extension is active.", "info");
    },
  });
}
