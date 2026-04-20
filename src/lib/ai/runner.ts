import { generateText, stepCountIs, type ModelMessage } from "ai";

import { buildSystemPrompt } from "@/lib/ai-context";
import { parseModelKey } from "./catalog";
import { getLanguageModel } from "./providers";
import { TOOLS } from "./tools";
import { useAiAgent, type AiContentBlock, type AiMessage } from "@/state/ai-agent";

const MAX_STEPS = 8;

function uid() {
  return crypto.randomUUID();
}

/** Maps our internal AiMessage[] to the SDK's ModelMessage[]. Tool results
 *  live in their own `role: "tool"` messages in the SDK, so a synthetic
 *  user-message containing only tool_result blocks is split out. */
function toModelMessages(history: AiMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const toolResults = m.content.filter(
        (c): c is Extract<AiContentBlock, { type: "tool_result" }> =>
          c.type === "tool_result",
      );
      const texts = m.content.filter(
        (c): c is Extract<AiContentBlock, { type: "text" }> =>
          c.type === "text",
      );

      if (toolResults.length > 0) {
        out.push({
          role: "tool",
          content: toolResults.map((tr) => ({
            type: "tool-result",
            toolCallId: tr.tool_use_id,
            toolName: tr.tool_name,
            output: { type: tr.is_error ? "error-text" : "text", value: tr.content },
          })),
        });
      }
      if (texts.length > 0) {
        out.push({
          role: "user",
          content: texts.map((t) => ({ type: "text", text: t.text })),
        });
      }
    } else {
      // assistant
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      for (const c of m.content) {
        if (c.type === "text") parts.push({ type: "text", text: c.text });
        else if (c.type === "tool_use")
          parts.push({
            type: "tool-call",
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          });
      }
      out.push({ role: "assistant", content: parts });
    }
  }
  return out;
}

/** Turns the new ModelMessage[] returned by the SDK into our AiMessage[].
 *  Preserves tool_name so later rendering + re-serialization work. */
function fromModelMessages(messages: ModelMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks: AiContentBlock[] = [];
      const content = m.content;
      if (typeof content === "string") {
        blocks.push({ type: "text", text: content });
      } else {
        for (const part of content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text });
          } else if (part.type === "tool-call") {
            blocks.push({
              type: "tool_use",
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            });
          }
        }
      }
      if (blocks.length > 0) {
        out.push({
          id: uid(),
          role: "assistant",
          content: blocks,
          createdAt: Date.now(),
        });
      }
    } else if (m.role === "tool") {
      const blocks: AiContentBlock[] = [];
      for (const part of m.content) {
        if (part.type !== "tool-result") continue;
        const output = part.output;
        const isError = output?.type === "error-text" || output?.type === "error-json";
        let content: string;
        if (output?.type === "text" || output?.type === "error-text") {
          content = String((output as { value: unknown }).value ?? "");
        } else {
          try {
            content = JSON.stringify((output as { value: unknown })?.value ?? output);
          } catch {
            content = String(output);
          }
        }
        blocks.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          tool_name: part.toolName,
          content,
          is_error: isError,
        });
      }
      if (blocks.length > 0) {
        out.push({
          id: uid(),
          role: "user",
          content: blocks,
          createdAt: Date.now(),
        });
      }
    }
  }
  return out;
}

export async function askAgent(userText: string, signal?: AbortSignal) {
  const st = useAiAgent.getState();
  if (st.loading) return;

  const parsed = parseModelKey(st.modelKey);
  if (!parsed) {
    st.setError("Modelo inválido. Escolha um nas configurações.");
    return;
  }
  const apiKey = st.apiKeys[parsed.provider];
  if (!apiKey) {
    st.setError(
      `Configure a API key do ${parsed.provider} nas configurações.`,
    );
    return;
  }

  st.setError(null);
  st.setLoading(true);

  const userMsg: AiMessage = {
    id: uid(),
    role: "user",
    content: [{ type: "text", text: userText }],
    createdAt: Date.now(),
  };
  st.appendMessage(userMsg);

  try {
    const model = getLanguageModel(parsed.provider, parsed.modelId, apiKey);
    const system = buildSystemPrompt();
    const history = useAiAgent.getState().messages;

    const result = await generateText({
      model,
      system,
      tools: TOOLS,
      messages: toModelMessages(history),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
    });

    const newMessages = fromModelMessages(result.response.messages);
    for (const m of newMessages) {
      useAiAgent.getState().appendMessage(m);
    }
  } catch (e) {
    useAiAgent
      .getState()
      .setError(e instanceof Error ? e.message : String(e));
  } finally {
    useAiAgent.getState().setLoading(false);
  }
}
