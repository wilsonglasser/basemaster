import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_MODEL_KEY, type ProviderId } from "@/lib/ai/catalog";

export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      tool_name: string;
      content: string;
      is_error?: boolean;
    };

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: AiContentBlock[];
  createdAt: number;
}

type ApiKeys = Record<ProviderId, string | null>;

const EMPTY_KEYS: ApiKeys = {
  anthropic: null,
  openai: null,
  openrouter: null,
  gemini: null,
  groq: null,
  deepseek: null,
  mistral: null,
  xai: null,
  perplexity: null,
  together: null,
  fireworks: null,
  cerebras: null,
};

interface AiState {
  apiKeys: ApiKeys;
  /** Composite id "<provider>:<modelId>". */
  modelKey: string;

  panelOpen: boolean;
  panelWidth: number;
  messages: AiMessage[];
  loading: boolean;
  error: string | null;

  setApiKey: (provider: ProviderId, key: string | null) => void;
  setModelKey: (key: string) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  appendMessage: (m: AiMessage) => void;
  clear: () => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
}

export const useAiAgent = create<AiState>()(
  persist(
    (set) => ({
      apiKeys: EMPTY_KEYS,
      modelKey: DEFAULT_MODEL_KEY,
      panelOpen: false,
      panelWidth: 380,
      messages: [],
      loading: false,
      error: null,

      setApiKey: (provider, key) =>
        set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: key } })),
      setModelKey: (modelKey) => set({ modelKey }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setPanelWidth: (panelWidth) =>
        set({ panelWidth: Math.max(280, Math.min(720, panelWidth)) }),
      appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
      clear: () => set({ messages: [], error: null }),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
    }),
    {
      name: "basemaster.ai-agent",
      partialize: (s) => ({
        apiKeys: s.apiKeys,
        modelKey: s.modelKey,
        panelOpen: s.panelOpen,
        panelWidth: s.panelWidth,
      }),
    },
  ),
);
