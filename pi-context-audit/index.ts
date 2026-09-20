import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAuditState,
  observeContext,
  observeToolCall,
  observeToolResult,
} from "./collector.ts";
import { formatNoSnapshot, formatRecentSnapshots, formatSnapshot } from "./report.ts";

export default function contextAuditExtension(pi: ExtensionAPI): void {
  let state = createAuditState();

  pi.on("context", (event) => {
    observeContext(state, event.messages);
  });

  pi.on("tool_call", (event) => {
    observeToolCall(state, event);
  });

  pi.on("tool_result", (event) => {
    observeToolResult(state, event);
  });

  pi.registerCommand("context-audit", {
    description: "Show passive context size estimates. Usage: /context-audit [recent|reset]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "reset") {
        state = createAuditState();
        ctx.ui.notify("Context audit reset.", "info");
        return;
      }

      if (action === "recent") {
        ctx.ui.notify(formatRecentSnapshots(state.snapshots), "info");
        return;
      }

      const snapshot = state.snapshots.at(-1);
      ctx.ui.notify(
        snapshot ? formatSnapshot(snapshot, state.tools) : formatNoSnapshot(state.tools),
        "info",
      );
    },
  });
}
