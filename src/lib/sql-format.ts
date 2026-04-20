import { format as formatSql, type SqlLanguage } from "sql-formatter";

/** Mapeia nosso driver name pro dialect do sql-formatter. */
function dialectFor(driver: string | undefined): SqlLanguage {
  switch (driver) {
    case "postgres":
      return "postgresql";
    case "mysql":
      return "mysql";
    default:
      return "sql";
  }
}

export function formatSqlText(text: string, driver?: string): string {
  if (!text.trim()) return text;
  try {
    return formatSql(text, {
      language: dialectFor(driver),
      keywordCase: "upper",
      dataTypeCase: "upper",
      functionCase: "upper",
      linesBetweenQueries: 2,
      tabWidth: 2,
      useTabs: false,
    });
  } catch (e) {
    // sql-formatter lança em sintaxe muito quebrada — devolve original.
    console.warn("sql format:", e);
    return text;
  }
}
