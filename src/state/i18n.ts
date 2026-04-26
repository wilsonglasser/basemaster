import { create } from "zustand";
import { persist } from "zustand/middleware";

import { de } from "@/i18n/de";
import { en } from "@/i18n/en";
import { es } from "@/i18n/es";
import { fr } from "@/i18n/fr";
import { ja } from "@/i18n/ja";
import { ptBR, type Dict } from "@/i18n/pt-br";
import { ru } from "@/i18n/ru";
import { zhCN } from "@/i18n/zh-CN";

export type Lang =
  | "pt-BR"
  | "en"
  | "es"
  | "zh-CN"
  | "ja"
  | "de"
  | "fr"
  | "ru";

const DICTS: Record<Lang, Dict> = {
  "pt-BR": ptBR,
  en,
  es,
  "zh-CN": zhCN,
  ja,
  de,
  fr,
  ru,
};

/** Dot-path keys of the translation tree. Generates a recursive
 *  string-literal type for call-site autocomplete. */
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
  if (n.startsWith("es")) return "es";
  if (n.startsWith("zh")) return "zh-CN";
  if (n.startsWith("ja")) return "ja";
  if (n.startsWith("de")) return "de";
  if (n.startsWith("fr")) return "fr";
  if (n.startsWith("ru")) return "ru";
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

/** Convenience hook. `const t = useT();` then `t('sidebar.connections')`. */
export function useT() {
  return useI18n((s) => s.t);
}
