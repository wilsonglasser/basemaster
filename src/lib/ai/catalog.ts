export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "groq"
  | "deepseek"
  | "mistral"
  | "xai"
  | "perplexity"
  | "together"
  | "fireworks"
  | "cerebras";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  keyPlaceholder: string;
  keysUrl: string;
  /** Base URL for OpenAI-compatible providers. null = native. */
  baseUrl?: string;
  /** Internal kind: "native" (has dedicated @ai-sdk) or "openai-compat". */
  kind: "native" | "openai-compat";
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
    kind: "native",
  },
  {
    id: "openai",
    name: "OpenAI",
    keyPlaceholder: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
    kind: "native",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    keyPlaceholder: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
    kind: "native",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    keyPlaceholder: "sk-or-…",
    keysUrl: "https://openrouter.ai/settings/keys",
    kind: "native",
  },
  {
    id: "groq",
    name: "Groq",
    keyPlaceholder: "gsk_…",
    keysUrl: "https://console.groq.com/keys",
    baseUrl: "https://api.groq.com/openai/v1",
    kind: "openai-compat",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyPlaceholder: "sk-…",
    keysUrl: "https://platform.deepseek.com/api_keys",
    baseUrl: "https://api.deepseek.com/v1",
    kind: "openai-compat",
  },
  {
    id: "mistral",
    name: "Mistral",
    keyPlaceholder: "…",
    keysUrl: "https://console.mistral.ai/api-keys",
    baseUrl: "https://api.mistral.ai/v1",
    kind: "openai-compat",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    keyPlaceholder: "xai-…",
    keysUrl: "https://console.x.ai/",
    baseUrl: "https://api.x.ai/v1",
    kind: "openai-compat",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    keyPlaceholder: "pplx-…",
    keysUrl: "https://www.perplexity.ai/settings/api",
    baseUrl: "https://api.perplexity.ai",
    kind: "openai-compat",
  },
  {
    id: "together",
    name: "Together AI",
    keyPlaceholder: "…",
    keysUrl: "https://api.together.xyz/settings/api-keys",
    baseUrl: "https://api.together.xyz/v1",
    kind: "openai-compat",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    keyPlaceholder: "fw_…",
    keysUrl: "https://fireworks.ai/account/api-keys",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    kind: "openai-compat",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    keyPlaceholder: "csk-…",
    keysUrl: "https://cloud.cerebras.ai",
    baseUrl: "https://api.cerebras.ai/v1",
    kind: "openai-compat",
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export interface ModelRef {
  provider: ProviderId;
  modelId: string;
  label: string;
  hint?: string;
}

export function modelKey(m: ModelRef): string {
  return `${m.provider}:${m.modelId}`;
}

export function parseModelKey(
  key: string,
): { provider: ProviderId; modelId: string } | null {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  const provider = key.slice(0, idx) as ProviderId;
  const modelId = key.slice(idx + 1);
  if (!PROVIDERS.find((p) => p.id === provider)) return null;
  if (!modelId) return null;
  return { provider, modelId };
}

/** Suggested models (autocomplete). The user can type anything. */
export const MODEL_CATALOG: ModelRef[] = [
  // Anthropic
  { provider: "anthropic", modelId: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "recomendado" },
  { provider: "anthropic", modelId: "claude-opus-4-7", label: "Opus 4.7", hint: "mais capaz" },
  { provider: "anthropic", modelId: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "rápido" },

  // OpenAI
  { provider: "openai", modelId: "gpt-4o", label: "GPT-4o" },
  { provider: "openai", modelId: "gpt-4o-mini", label: "GPT-4o mini", hint: "rápido" },
  { provider: "openai", modelId: "o1-mini", label: "o1 mini", hint: "raciocínio" },
  { provider: "openai", modelId: "o1", label: "o1" },

  // Gemini
  { provider: "gemini", modelId: "gemini-2.0-flash-exp", label: "Gemini 2.0 Flash" },
  { provider: "gemini", modelId: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
  { provider: "gemini", modelId: "gemini-1.5-flash", label: "Gemini 1.5 Flash", hint: "rápido" },

  // OpenRouter
  { provider: "openrouter", modelId: "anthropic/claude-sonnet-4", label: "Sonnet 4" },
  { provider: "openrouter", modelId: "openai/gpt-4o", label: "GPT-4o" },
  { provider: "openrouter", modelId: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash (free)" },
  { provider: "openrouter", modelId: "meta-llama/llama-3.1-70b-instruct", label: "Llama 3.1 70B" },
  { provider: "openrouter", modelId: "deepseek/deepseek-chat", label: "DeepSeek Chat" },

  // Groq
  { provider: "groq", modelId: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
  { provider: "groq", modelId: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "rápido" },
  { provider: "groq", modelId: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },

  // DeepSeek
  { provider: "deepseek", modelId: "deepseek-chat", label: "DeepSeek V3" },
  { provider: "deepseek", modelId: "deepseek-reasoner", label: "DeepSeek R1", hint: "raciocínio" },

  // Mistral
  { provider: "mistral", modelId: "mistral-large-latest", label: "Mistral Large" },
  { provider: "mistral", modelId: "mistral-small-latest", label: "Mistral Small" },
  { provider: "mistral", modelId: "codestral-latest", label: "Codestral", hint: "código" },

  // xAI
  { provider: "xai", modelId: "grok-2-latest", label: "Grok 2" },
  { provider: "xai", modelId: "grok-beta", label: "Grok beta" },

  // Perplexity
  { provider: "perplexity", modelId: "sonar-pro", label: "Sonar Pro" },
  { provider: "perplexity", modelId: "sonar", label: "Sonar" },

  // Together
  { provider: "together", modelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", label: "Llama 3.1 70B Turbo" },
  { provider: "together", modelId: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen 2.5 72B" },

  // Fireworks
  { provider: "fireworks", modelId: "accounts/fireworks/models/llama-v3p1-70b-instruct", label: "Llama 3.1 70B" },

  // Cerebras
  { provider: "cerebras", modelId: "llama3.1-70b", label: "Llama 3.1 70B" },
  { provider: "cerebras", modelId: "llama3.1-8b", label: "Llama 3.1 8B", hint: "rápido" },
];

export const DEFAULT_MODEL_KEY = "anthropic:claude-sonnet-4-6";

export function modelsByProvider(): Record<ProviderId, ModelRef[]> {
  const out = {} as Record<ProviderId, ModelRef[]>;
  for (const p of PROVIDERS) out[p.id] = [];
  for (const m of MODEL_CATALOG) out[m.provider].push(m);
  return out;
}
