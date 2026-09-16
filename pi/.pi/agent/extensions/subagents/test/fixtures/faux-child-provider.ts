import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ScriptedCall {
  name: string;
  arguments: Record<string, unknown>;
}

type ScriptedTurn =
  | { type: "tools"; calls: ScriptedCall[] }
  | { type: "text"; text: string };

export default function fauxChildProvider(pi: ExtensionAPI): void {
  const scriptPath = process.env.PI_SUBAGENT_FAUX_SCRIPT;
  if (!scriptPath) {
    throw new Error("PI_SUBAGENT_FAUX_SCRIPT is required for the faux child provider");
  }

  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptedTurn[];
  if (!Array.isArray(script)) {
    throw new Error("PI_SUBAGENT_FAUX_SCRIPT must contain a JSON array of turns");
  }

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "scripted", name: "Scripted" }],
  });
  faux.setResponses(
    script.map((turn) => {
      if (turn.type === "tools") {
        return fauxAssistantMessage(
          turn.calls.map((call) => fauxToolCall(call.name, call.arguments)),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(turn.text, { stopReason: "stop" });
    }),
  );
  pi.registerProvider(faux.provider);
}
