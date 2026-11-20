import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatGreeting } from "./greeting.ts";

/** Minimal example adapter; replace the command, not the engineering baseline. */
export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("hello", {
    description: "Example: greet a name without calling a model",
    handler: async (args, ctx) => {
      const text = formatGreeting(args);
      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      } else {
        pi.sendMessage(
          { customType: "template-greeting", content: text, display: true },
          { triggerTurn: false },
        );
      }
    },
  });
}
