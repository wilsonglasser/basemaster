import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_MODEL_KEY, type ProviderId } from "@/lib/ai/catalog";
import { ipc } from "@/lib/ipc";

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
  /** Loads stored keys from the OS keyring into memory. Call once on startup. */
  hydrateKeys: () => Promise<void>;
  setModelKey: (key: string) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  appendMessage: (m: AiMessage) => void;
  clear: () => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
}

/** Removes the legacy plaintext `apiKeys` field from the persisted
 *  localStorage blob, once keys have been moved to the keyring. */
function scrubPersistedKeys() {
  const KEY = "basemaster.ai-agent";
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (parsed.state && "apiKeys" in parsed.state) {
      delete parsed.state.apiKeys;
      localStorage.setItem(KEY, JSON.stringify(parsed));
    }
  } catch {
    // malformed blob — nothing to scrub.
  }
}

export const useAiAgent = create<AiState>()(
  persist(
    (set, get) => ({
      apiKeys: EMPTY_KEYS,
      modelKey: DEFAULT_MODEL_KEY,
      panelOpen: false,
      panelWidth: 380,
      messages: [],
      loading: false,
      error: null,

      setApiKey: (provider, key) => {
        set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: key } }));
        // Persist at-rest in the OS keyring (empty = delete). Fire-and-forget:
        // in-memory state is the source of truth for the current session.
        void ipc.ai.setKey(provider, key ?? "").catch(() => {});
      },
      hydrateKeys: async () => {
        const providers = Object.keys(EMPTY_KEYS) as ProviderId[];
        try {
          const stored = await ipc.ai.getKeys(providers);
          // Migrate keys left in the old localStorage blob (rehydrated into
          // state by persist) into the keyring, then wipe them off disk.
          const inMemory = get().apiKeys;
          for (const p of providers) {
            const local = inMemory[p];
            if (local && !stored[p]) {
              stored[p] = local;
              void ipc.ai.setKey(p, local).catch(() => {});
            }
          }
          set((s) => ({ apiKeys: { ...s.apiKeys, ...stored } }));
          scrubPersistedKeys();
        } catch {
          // keyring unavailable — user re-enters keys in settings.
        }
      },
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
      // apiKeys intentionally excluded — they live in the OS keyring, not in
      // plaintext localStorage. Hydrated on startup via hydrateKeys().
      partialize: (s) => ({
        modelKey: s.modelKey,
        panelOpen: s.panelOpen,
        panelWidth: s.panelWidth,
      }),
    },
  ),
);
