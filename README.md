<p align="center">
  <img src="src-tauri/icons/icon.png" width="120" alt="BaseMaster logo">
</p>

<h1 align="center">BaseMaster</h1>

<p align="center">
  Gerenciador de banco de dados desktop — Rust + Tauri, rápido e nativo.
</p>

<p align="center">
  <a href="https://github.com/wilsonglasser/basemaster/actions/workflows/ci.yml"><img src="https://github.com/wilsonglasser/basemaster/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/wilsonglasser/basemaster/releases/latest"><img src="https://img.shields.io/github/v/release/wilsonglasser/basemaster?color=green&include_prereleases" alt="Release"></a>
  <img src="https://img.shields.io/badge/rust-stable-orange?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/platforms-linux%20%7C%20macos%20%7C%20windows-blue" alt="Platforms">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://ko-fi.com/wilsonglasser"><img src="https://img.shields.io/badge/Ko--fi-Support%20me-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  <a href="https://buymeacoffee.com/wilsonglasser"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-donate-yellow?logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"></a>
</p>

<p align="center">
  🌐 Português · English
</p>

---

## Download

Binários pré-compilados ficam disponíveis na [página de Releases](https://github.com/wilsonglasser/basemaster/releases/latest):

| Plataforma | Arquitetura | Formato |
|-----------|-------------|---------|
| Windows | x86_64 | `.msi` (instalador) / `.exe` (portátil) |
| macOS | Apple Silicon | `.dmg` |
| macOS | Intel | `.dmg` |
| Linux | x86_64 | `.deb` / `.rpm` / `.AppImage` |

---

## O que é o BaseMaster?

Um cliente desktop moderno de banco de dados — alternativa open-source ao Navicat, DBeaver e TablePlus. Multi-driver, editor SQL completo, grid editável tipo planilha, data transfer entre conexões, integração com IA e servidor MCP. Tudo em um único binário nativo, sem Electron.

### Por quê?

As alternativas existentes são pagas e closed-source (Navicat, TablePlus), ou baseadas em Electron e pesadas (DBeaver), ou só CLI (`psql`, `mysql`). O BaseMaster busca ser **rápido, nativo e com a UX que um DBA/dev profissional espera**.

## Features

### Conectividade
- **Multi-driver** — MySQL, MariaDB, PostgreSQL, SQLite (com suporte opcional a SQLCipher).
- **SSH tunnel** — Tunelamento via [russh 0.60](https://github.com/warp-tech/russh), suporte a chave + passphrase.
- **SSL/TLS** — Configurável por conexão.
- **Docker auto-discovery** — Detecta containers MySQL/Postgres rodando no host e sugere conexão.

### Editor SQL
- **CodeMirror 6** — Editor moderno com autocomplete baseado no schema ativo.
- **Format SQL** — `Ctrl+Shift+F` pra reformatar a query.
- **Execução granular** — `Ctrl+Enter` executa a statement sob o cursor, ou a seleção.
- **Histórico + queries salvas** — Persistidas localmente em SQLite.

### Grid Editável
- **[Glide Data Grid](https://github.com/glideapps/glide-data-grid)** — Renderer canvas, suporta 100k+ linhas sem travar.
- **UX tipo Navicat** — Multi-fill, paste multi-row/multi-col, edições vão pra pending e só comitam com apply explícito.
- **Tipos fortes** — Bytes (hex/utf-8 preview), JSON formatado, datas, enums, arrays, UUID.

### Schema Editor
- **UI completa** — Cria e edita tabelas, colunas, índices, foreign keys e triggers via formulário.
- **Sub-abas por tabela** — Dados, Estrutura, DDL, Índices, Gatilhos.
- **Atalhos** — `F2` pra rename, `Ctrl+D` abre estrutura da tabela ativa.

### Data Transfer (entre conexões)
- **Paralelismo intra-tabela** — Copia chunks em paralelo, configurável por job.
- **Copy de FKs** — Recria relacionamentos no destino quando `create_tables=true`.
- **Copy de triggers** — `SHOW TRIGGERS` + `SHOW CREATE TRIGGER` no MySQL.
- **Progress em tempo real** — Linhas/segundo, ETA, pausar e cancelar.

### Import / Export
- **`.bmconn`** — Formato próprio, exporta conexões + queries salvas.
- **`.ncx`** — Import de conexões do Navicat, com descriptografia Blowfish-ECB nativa.
- **Dados** — CSV, JSON e Excel com auto-map fuzzy entre colunas de origem e destino.

### Integração com IA
- **Agente embutido** — 19 ferramentas pra inspecionar schema, executar queries, explicar planos e editar dados.
- **12 providers** — Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Perplexity, Together, Fireworks, Cerebras.
- **MCP server** — Expõe suas conexões a clientes AI externos (Claude Code, Cursor) via JSON-RPC sobre stdio.

### UX
- **Sidebar resizível** — Ajustável com drag, estado persistido.
- **Command palette** — `Ctrl+K` pra qualquer ação.
- **Cheat-sheet completa** — `Ctrl+/` lista todos os atalhos.
- **Temas** — Dark / Light.
- **i18n** — Português (Brasil) e English.

### Storage & Privacidade
- **SQLite local** — Perfis, queries salvas, histórico, settings, tudo offline.
- **Keyring OS** — Senhas de conexão no Credential Manager (Windows) / Keychain (macOS) / libsecret (Linux).
- **Sem telemetria** — Nenhum dado sai da sua máquina, exceto nas chamadas pros providers de IA que você explicitamente configurar.

## Arquitetura

```
+----- Tauri 2 Application (WebView) ---------------------------+
|                                                               |
|  React + TypeScript (Vite)                                    |
|  Sidebar + Tab Bar + SQL Editor + Grid + AI Chat              |
|                                                               |
+---------------------------------------------------------------+
|  src-tauri (Rust backend, Tauri commands, MCP server)         |
+---------------------------------------------------------------+
|  driver-mysql   |  driver-postgres  |  driver-sqlite          |
|  (sqlx, cobre   |  (sqlx)           |  (sqlx + SQLCipher opt) |
|   MariaDB)      |                   |                         |
+-----------------+-------------------+-------------------------+
|  core           |  store                                      |
|  (trait Driver +|  (SQLite local: perfis, queries,            |
|   Value, tipos) |   histórico, settings)                      |
+---------------------------------------------------------------+
```

| Crate | Propósito |
|-------|-----------|
| `basemaster` (src-tauri) | App Tauri, comandos, MCP server, data transfer, import/export |
| `core` | Trait `Driver`, enum `Value`, tipos compartilhados entre drivers |
| `driver-mysql` | Driver MySQL / MariaDB via sqlx |
| `driver-postgres` | Driver PostgreSQL via sqlx |
| `driver-sqlite` | Driver SQLite via sqlx (+ SQLCipher opcional) |
| `store` | Store SQLite local pra perfis, queries salvas, settings |

## Stack Técnica

| Camada | Tecnologia |
|--------|-----------|
| Shell desktop | Tauri 2 (WebView2 / WebKit / WebKitGTK) |
| Frontend | React 18 + TypeScript + Vite |
| UI | shadcn/ui + Radix + Tailwind |
| Grid | Glide Data Grid |
| Editor SQL | CodeMirror 6 |
| AI SDK | Vercel AI SDK (12 providers) |
| Backend | Rust stable + Tokio |
| DB clients | sqlx (MySQL, Postgres, SQLite) |
| SSH | russh 0.60 |
| Navicat decrypt | `blowfish` + `ecb` + `quick-xml` |
| Storage local | SQLite |
| Keyring | `keyring` crate (OS-native) |
| Error reporting | Sentry (opcional, via env var) |

## Setup de Desenvolvimento

### Requisitos

- Rust stable ([rustup](https://rustup.rs/))
- Node 20+ e [pnpm 10](https://pnpm.io/)

**Linux:**
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libxdo-dev build-essential
```

**macOS:** `xcode-select --install`

**Windows:** Visual Studio Build Tools com workload C++ + WebView2 runtime.

### Build & Run

```bash
git clone https://github.com/wilsonglasser/basemaster.git
cd basemaster
pnpm install
pnpm tauri dev            # Dev com hot reload
pnpm tauri build          # Release → src-tauri/target/release/bundle/
cargo check --workspace   # Check Rust
pnpm tsc --noEmit         # Check TS
```

Detalhes de code signing (SignPath Foundation pra Windows, Apple Developer pra macOS) e publicação no winget em [`docs/RELEASE.md`](docs/RELEASE.md).

## Uso

1. **Primeira execução** — Perfil vazio, sem master password.
2. **Nova conexão** — Botão `+`, escolhe driver, preenche host/porta/credenciais. Testa antes de salvar.
3. **Query** — `Ctrl+T` nova aba SQL, `Ctrl+Enter` executa.
4. **Editar tabela** — Duplo-click na tabela → aba Dados. Edições ficam em pending, `Ctrl+S` aplica.
5. **Transfer** — Menu conexão → Data Transfer. Seleciona origem/destino e tabelas, configura paralelismo.
6. **AI** — Settings → AI, configura provider e API key. Botão de chat abre na sidebar.
7. **Import Navicat** — File → Import `.ncx`, preenche master password se o arquivo tiver uma.

### Atalhos

| Atalho | Ação |
|--------|------|
| `Ctrl+K` | Command palette |
| `Ctrl+T` | Nova aba SQL |
| `Ctrl+W` | Fecha aba |
| `Ctrl+Enter` | Executa query |
| `Ctrl+Shift+F` | Formata SQL |
| `Ctrl+D` | Estrutura da tabela ativa |
| `F2` | Rename (coluna, tabela, conexão) |
| `Ctrl+/` | Cheat-sheet completa |

## Roadmap

| Versão | Status | Escopo |
|--------|--------|--------|
| **v0.1** | **Em progresso** | Drivers MySQL/MariaDB/Postgres/SQLite, SQL editor, grid editável, schema editor, data transfer V1.2, import/export, AI chat, MCP server, Docker discovery |
| **v0.2** | Planejado | Visualizador de `EXPLAIN`, diff de schemas, biometric unlock, jump hosts SSH encadeados |
| **v0.3** | Planejado | ER diagram, refactor visual de schema, sync entre instalações via QUIC |

## Contribuindo

PRs são bem-vindas. Abra uma issue antes de mudanças grandes pra alinhar escopo.

## Licença

[MIT](LICENSE) — Free e open-source.

---

<p align="center">
  Feito com Rust e SQL pra quem vive em bancos de dados.
</p>
