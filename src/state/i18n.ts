import { create } from "zustand";
import { persist } from "zustand/middleware";

import { en } from "@/i18n/en";
import { ptBR, type Dict } from "@/i18n/pt-br";

export type Lang = "pt-BR" | "en";

const DICTS: Record<Lang, Dict> = {
  "pt-BR": ptBR,
  en,
};

/** Dot-path keys da árvore de traduções. Gera tipo string-literal recursivo
 *  pra autocomplete no call-site. */
type Leaves<T, P extends string = ""> = T extends string
  ? P
  : {
      [K in keyof T & string]: Leaves<T[K], P extends "" ? K : `${P}.${K}`>;
    }[keyof T & string];

export type TKey = Leaves<Dict>;

function resolve(dict: Dict, key: string): string {
  const parts = key.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = dict;
  for (const p of parts) {
    if (cur == null) return key;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : key;
}

function interpolate(
  tmpl: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? String(params[k]) : `{${k}}`,
  );
}

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TKey, params?: Record<string, string | number>) => string;
}

function detect(): Lang {
  if (typeof navigator === "undefined") return "pt-BR";
  const n = navigator.language.toLowerCase();
  if (n.startsWith("pt")) return "pt-BR";
  return "en";
}

export const useI18n = create<I18nState>()(
  persist(
    (set, get) => ({
      lang: detect(),
      setLang(l) {
        set({ lang: l });
      },
      t(key, params) {
        const dict = DICTS[get().lang] ?? DICTS["pt-BR"];
        return interpolate(resolve(dict, key), params);
      },
    }),
    { name: "basemaster.i18n" },
  ),
);

/** Hook de conveniência. `const t = useT();` depois `t('sidebar.connections')`. */
export function useT() {
  return useI18n((s) => s.t);
}
