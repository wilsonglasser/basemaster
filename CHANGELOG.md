# Changelog

All notable changes to BaseMaster are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely; versioning is
[SemVer](https://semver.org/) at the app level.

## [0.3.0] — 2026-04-25

The big "production-grade polish" release: real query cancel, MITM-resistant
SSH, footgun guards, multi-language UI, importers from the most popular
clients, and a heavily reworked tab bar.

### Added
- **Server-side query cancel.** Stop button issues `KILL QUERY <pid>` (MySQL)
  / `pg_cancel_backend(pid)` (Postgres) via a sideband connection — the
  server actually stops the statement, not just the UI. Implemented by
  embedding a hidden `/* bm-cancel-<uuid> */` comment in the SQL and
  matching it against `information_schema.PROCESSLIST` / `pg_stat_activity`.
- **SSH host-key verification.** Per-app `known_hosts` at
  `<app_data_dir>/ssh_known_hosts`. First connect prompts a dialog with
  the SHA-256 fingerprint (TOFU); a key change later is **rejected** with
  a clear MITM warning. Manage trusted hosts under
  Settings → Security.
- **UPDATE / DELETE without WHERE guard.** Confirm dialog before running
  statements that would affect every row of a table. Opt-out checkbox
  ("don't ask again") with a toggle to re-enable in Settings → Security.
- **Top slow queries shortcut.** Connection context menu opens a pre-filled
  query tab against `performance_schema.events_statements_summary_by_digest`
  (MySQL/MariaDB) or `pg_stat_statements` (Postgres).
- **Query history filters.** Status pills (all / success / error), schema
  dropdown, "Clear filters" button, and live highlight of the search match
  in the list.
- **Undo / redo of pending grid edits** via `Ctrl+Z` / `Ctrl+Shift+Z`.
  History captures cell edits, row deletes, and new rows as one unit;
  cleared whenever the underlying rows reload (apply / page / refresh).
- **6 new languages**, total of 8: Español, 简体中文, 日本語, Deutsch,
  Français, Русский (joining English and Português BR). Browser locale
  is auto-detected on first run.
- **Connection importers** for the top other clients:
  - **DBeaver** (`data-sources.json`) — connections + folders, all engines.
  - **HeidiSQL** (`portable_settings.txt`) — passwords decrypted via the
    descending-shift algorithm.
  - **DataGrip / IntelliJ** (`dataSources.xml`) — driver and host
    extracted from `<jdbc-url>`.
  - All three sit alongside the existing Navicat `.ncx` importer.
- **Welcome page** got a recent-connections list (top 3 by `last_used_at`),
  feature highlight cards (multi-engine / AI / SSH / data transfer), and
  a `Ctrl+K` keyboard tip.
- **Sidebar empty state** now suggests "Detect from Docker" as a
  one-click alternative to manual setup.
- **Tables list view**:
  - Toolbar reorganized to `Open · Design · New · Delete | Import · Export`.
  - **Multi-table open / design** — selecting N tables and clicking opens
    N tabs at once. Mirrored in the context menu.
  - **Toggle-on-click** selection: clicking a sole-selected row deselects it.
  - **Click on empty area** clears the whole selection.
  - Selection count and item totals moved to the global StatusBar.
- **Tab bar** got a Termius-inspired redesign:
  - Native scrollbar hidden; mouse wheel (vertical or horizontal) scrolls
    smoothly via an animated target accumulator.
  - **Floating close button** — `×` and the tab icon share the same slot;
    `×` fades in on hover or when the tab is active.
  - **Active tab is never shrunk** — keeps its full label visible while
    inactive tabs collapse responsively.
  - **Jump dialog** (`Ctrl+J` or the `…` button) — modal with searchable
    list of every open tab, arrow-key navigation, Enter to activate.
- **Sentry plumbing** — `VITE_SENTRY_DSN` / `SENTRY_DSN` are now passed
  through `release.yml` at build time. Adding the secret in GitHub
  enables crash reporting on the next release tag.

### Changed
- Tables grid view now uses column-major flow with horizontal scroll
  (cards descend in columns, not wrap rows). Borders are transparent
  when deselected; `conn-accent` only on selection.
- `--font-sans` simplified to `system-ui, -apple-system, sans-serif`
  (Inter / Segoe UI removed from the cascade).
- Welcome action grid is now a 2×2 layout instead of a single column.
- README and basemaster.org reflect the new feature set.

### Dependencies
- `russh` pinned to `0.60.1` (was `0.60`).

### Notes
- Procedures / functions / triggers inspection and tab persistence were
  already implemented in earlier versions; previous documentation flagged
  them incorrectly as missing.
