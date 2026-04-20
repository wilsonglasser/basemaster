/** Sinônimos curados bidirecionais — pares que devem casar no auto-map.
 *  Canonicalizamos via `normalize` antes de comparar. */
const SYNONYM_GROUPS: string[][] = [
  ["id", "uuid", "pk"],
  ["email", "mail", "e-mail", "emailaddress"],
  ["phone", "telephone", "telefone", "cellphone", "mobile", "celular"],
  ["username", "login", "user", "usuario"],
  ["password", "passwd", "senha", "pass"],
  ["firstname", "fname", "givenname", "nome"],
  ["lastname", "lname", "surname", "familyname", "sobrenome"],
  ["fullname", "name"],
  ["createdat", "created", "datecreated", "creationdate", "criadoem"],
  ["updatedat", "updated", "dateupdated", "modificationdate", "atualizadoem"],
  ["deletedat", "deleted", "datedeleted", "removidoem"],
  ["zipcode", "postalcode", "cep"],
  ["state", "uf", "province", "estado"],
  ["country", "pais"],
  ["city", "cidade"],
  ["street", "address1", "address", "logradouro", "endereco"],
];

const SYNONYM_MAP = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const set = new Set(group);
    for (const term of group) map.set(term, set);
  }
  return map;
})();

/** Normaliza um identificador pra comparação:
 *  - remove acentos (NFD + strip marks)
 *  - lowercase
 *  - strip separadores (_ - . espaço)
 *  - remove prefixo "fk_"/"idx_"/"ix_" quando óbvio (ruído de naming) */
export function normalize(s: string): string {
  let x = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  // Só strip prefixo quando sobra algo relevante.
  if (/^(fk|idx|ix|pk)[a-z0-9]/.test(x)) {
    const stripped = x.replace(/^(fk|idx|ix|pk)/, "");
    if (stripped.length >= 3) x = stripped;
  }
  return x;
}

/** Levenshtein distance — DP standard, O(n*m). Bom suficiente pra N<100. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Score 0..1 entre dois identificadores já normalizados. 1 = igual. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Sinônimos: 0.95 (mais forte que quase-letra-diferente).
  const groupA = SYNONYM_MAP.get(a);
  if (groupA && groupA.has(b)) return 0.95;
  // Substring: 0.8 se um contém o outro (user vs user_id → "user" vs "userid").
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.7 + 0.2 * ratio; // 0.7..0.9
  }
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

export interface AutoMapResult {
  /** targetCol → sourceCol (já resolvido). */
  mapping: Record<string, string>;
  /** Source cols que não ficaram em nenhum target. */
  unmappedSources: string[];
  /** Target cols que ficaram sem source. */
  unmappedTargets: string[];
  /** Mappings pelo fuzzy (score < 0.9) — para sugerir em cinza na UI. */
  fuzzySuggestions: Record<string, { source: string; score: number }>;
}

export interface AutoMapOptions {
  /** Mappings já definidos manualmente — não sobrescrever. */
  preserve?: Record<string, string>;
  /** Score mínimo pra aceitar match automático. Default 0.9 (muito estrito). */
  minAutoScore?: number;
  /** Score mínimo pra listar como sugestão fuzzy (UI cinza). Default 0.7. */
  minSuggestionScore?: number;
}

/** Algoritmo greedy:
 *  1. Score cada par (target, source) com similarity().
 *  2. Ordena pares por score desc.
 *  3. Atribui greedy: primeiro match forte pra cada target/source (um-pra-um).
 *  4. Target/source já usados (pelo preserve) saem da competição.
 *  5. Mappings com score < minAutoScore viram sugestão fuzzy (não aplicados). */
export function autoMapColumns(
  targets: string[],
  sources: string[],
  opts: AutoMapOptions = {},
): AutoMapResult {
  const preserve = opts.preserve ?? {};
  const minAuto = opts.minAutoScore ?? 0.9;
  const minSug = opts.minSuggestionScore ?? 0.7;

  const mapping: Record<string, string> = {};
  const usedSources = new Set<string>();
  const usedTargets = new Set<string>();

  // Aplica preserve primeiro.
  for (const [t, s] of Object.entries(preserve)) {
    if (s && sources.includes(s) && targets.includes(t)) {
      mapping[t] = s;
      usedSources.add(s);
      usedTargets.add(t);
    }
  }

  const normTargets = targets.map((t) => ({ raw: t, norm: normalize(t) }));
  const normSources = sources.map((s) => ({ raw: s, norm: normalize(s) }));

  // Score all pairs.
  const pairs: Array<{ target: string; source: string; score: number }> = [];
  for (const t of normTargets) {
    if (usedTargets.has(t.raw)) continue;
    for (const s of normSources) {
      if (usedSources.has(s.raw)) continue;
      const score = similarity(t.norm, s.norm);
      if (score >= minSug) {
        pairs.push({ target: t.raw, source: s.raw, score });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const fuzzySuggestions: Record<string, { source: string; score: number }> = {};

  for (const p of pairs) {
    if (usedTargets.has(p.target) || usedSources.has(p.source)) continue;
    if (p.score >= minAuto) {
      mapping[p.target] = p.source;
      usedTargets.add(p.target);
      usedSources.add(p.source);
    } else if (!fuzzySuggestions[p.target]) {
      fuzzySuggestions[p.target] = { source: p.source, score: p.score };
    }
  }

  const unmappedSources = sources.filter((s) => !usedSources.has(s));
  const unmappedTargets = targets.filter((t) => !(t in mapping));

  return { mapping, unmappedSources, unmappedTargets, fuzzySuggestions };
}
