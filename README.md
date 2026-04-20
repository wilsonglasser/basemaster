# BaseMaster

Gerenciador de bancos de dados desktop (MySQL, MariaDB, PostgreSQL, SQLite) escrito em Rust + Tauri + React.

## Features

- **Multi-driver**: MySQL, MariaDB, PostgreSQL, SQLite (com SQLCipher)
- **Editor SQL**: CodeMirror 6 com autocomplete, format, Ctrl+Enter
- **Grid editável**: Glide Data Grid com edições tipo Navicat (multi-fill, paste multi-row, apply explícito)
- **Schema editor**: tabelas, colunas, índices, FKs — cria/edita via UI
- **Data transfer**: entre bancos/conexões com paralelismo intra-tabela, copy de triggers, FKs
- **Import/export**: `.bmconn` (nosso formato), `.ncx` (Navicat, com Blowfish decrypt)
- **Docker auto-discovery**: detecta containers MySQL/Postgres no sistema
- **MCP server**: expõe suas conexões pra clientes AI externos via JSON-RPC
- **Agente de IA embutido**: 19 tools (Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Perplexity, Together, Fireworks, Cerebras)
- **Import estruturado**: CSV / JSON / Excel com auto-map fuzzy
- **Shortcuts completos**: Ctrl+K palette, Ctrl+D estrutura, F2 rename, Ctrl+/ cheat-sheet

## Setup de desenvolvimento

```bash
# Rust + Node
rustup install stable
# Node 20+
pnpm install
pnpm tauri dev
```

Requisitos Linux extras:

```bash
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libxdo-dev
```

## Build de release

```bash
pnpm tauri build
# artefatos em src-tauri/target/release/bundle/
```

Veja `docs/RELEASE.md` pra setup de code signing (SignPath Foundation — gratuito pra OSS) e winget.

## Estrutura

```
basemaster/
├─ src/                    # frontend React/TypeScript
├─ src-tauri/              # backend Rust (Tauri app)
├─ crates/
│  ├─ core/                # trait Driver + Value + tipos compartilhados
│  ├─ driver-mysql/        # sqlx + MySQL (cobre MariaDB)
│  ├─ driver-postgres/     # sqlx + PostgreSQL
│  ├─ driver-sqlite/       # sqlx + SQLite (+ SQLCipher opt)
│  └─ store/               # SQLite local (perfis, queries salvas, etc)
└─ docs/
```

## Licença

MIT
