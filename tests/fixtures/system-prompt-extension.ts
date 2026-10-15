import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadChildSessionResources } from "../../.pi/extensions/feishu/conversation-manager.js";

const DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi";
const FEISHU_NOTE = "You are replying through Feishu/Lark";

export default async function systemPromptExtension(pi: ExtensionAPI) {
  const failures: string[] = [];
  const cwd = process.cwd();

  try {
    const loader = await loadChildSessionResources(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime: await ModelRuntime.create(),
      sessionManager: SessionManager.create(cwd),
      resourceLoader: loader,
    });
    const prompt = session.systemPrompt ?? "";

    if (!prompt.includes(DEFAULT_PREAMBLE)) {
      failures.push("missing pi default preamble");
    }
    for (const section of ["<tools>", "<rules>", "<docs>"]) {
      if (!prompt.includes(section)) failures.push(`missing ${section} section`);
    }
    if (!prompt.includes(FEISHU_NOTE)) failures.push("missing Feishu note");
    if (!prompt.includes("<addendum>")) failures.push("Feishu note is not in the addendum section");

    session.dispose();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    console.error(`SYSTEM_PROMPT_CHECK_FAILED: ${failures.join("; ")}`);
  } else {
    console.log("SYSTEM_PROMPT_CHECK_OK");
  }

  pi.registerCommand("verify-feishu-system-prompt", {
    handler: async () => undefined,
  });
}
