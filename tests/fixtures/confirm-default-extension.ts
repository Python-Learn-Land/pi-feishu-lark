import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uiConfirm } from "../../.pi/extensions/feishu/setup.js";

// pi renders a fixed ["Yes", "No"] selector that always starts on the first
// entry, so the intended default has to be ordered first by the caller.
function ctxCapturingFirstOption(captured: string[]) {
  return {
    ui: {
      select: async (_title: string, options: string[]) => {
        captured.push(options[0]);
        return options[0];
      },
    },
  } as never;
}

export default async function confirmDefaultExtension(pi: ExtensionAPI) {
  const failures: string[] = [];

  // Models pi's interactive UI, which offers both dialogs. ui.confirm renders a
  // fixed ["Yes", "No"] list that always starts on "Yes".
  const ctxLikePi = (captured: string[]) => ({
    ui: {
      select: async (_title: string, options: string[]) => {
        captured.push(options[0]);
        return options[0];
      },
      confirm: async () => true,
    },
  }) as never;

  const destructive: string[] = [];
  if (await uiConfirm(ctxLikePi(destructive), "Reset?", false)) {
    failures.push("destructive prompt resolved to Yes");
  }
  if (destructive[0] !== "No") {
    failures.push(`destructive prompt highlighted "${destructive[0]}", expected "No"`);
  }

  const affirmative: string[] = [];
  if (!(await uiConfirm(ctxLikePi(affirmative), "Start now?", true))) {
    failures.push("affirmative prompt resolved to No");
  }
  if (affirmative[0] !== "Yes") {
    failures.push(`affirmative prompt highlighted "${affirmative[0]}", expected "Yes"`);
  }

  // A UI without ui.select falls back to ui.confirm, which must stay honored.
  const fallback = await uiConfirm({ ui: { confirm: async () => false } } as never, "Reset?", false);
  if (fallback) failures.push("ui.confirm fallback ignored the answer");

  if (failures.length > 0) {
    console.error(`CONFIRM_DEFAULT_CHECK_FAILED: ${failures.join("; ")}`);
  } else {
    console.log("CONFIRM_DEFAULT_CHECK_OK");
  }

  pi.registerCommand("verify-feishu-confirm-defaults", {
    handler: async () => undefined,
  });
}
