import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import { providerMeta, type ProviderId } from "./catalog";

/** Retorna um LanguageModel configurado pro pair (provider, modelId). */
export function getLanguageModel(
  provider: ProviderId,
  modelId: string,
  apiKey: string,
): LanguageModel {
  const meta = providerMeta(provider);

  if (meta.kind === "openai-compat") {
    // Usa o factory do @ai-sdk/openai apontando pro baseURL do provider.
    const client = createOpenAI({
      apiKey,
      baseURL: meta.baseUrl,
    });
    return client(modelId);
  }

  switch (provider) {
    case "anthropic": {
      const a = createAnthropic({
        apiKey,
        headers: {
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      return a(modelId);
    }
    case "openai": {
      const o = createOpenAI({ apiKey });
      return o(modelId);
    }
    case "openrouter": {
      const r = createOpenRouter({ apiKey });
      return r(modelId);
    }
    case "gemini": {
      const g = createGoogleGenerativeAI({ apiKey });
      return g(modelId);
    }
    default:
      throw new Error(`provider não suportado: ${provider}`);
  }
}
