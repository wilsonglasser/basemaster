# Changelog

All notable changes to BaseMaster are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely; versioning is
[SemVer](https://semver.org/) at the app level.

## [0.4.2] - 2026-05-05

Bug fix + filter quality-of-life. Strings on `_bin`-collated MySQL columns
no longer render as `[N bytes]` in the grid, sidebar gains a Delete
shortcut, filters get a per-rule case-insensitive toggle.

### Added
- **Case-insensitive filter toggle** ("Aa" pill) on each filter chip for
  textual ops (eq / not_eq / contains / begins_with / ends_with / in).
  MySQL and SQLite wrap operands with `LOWER()`; Postgres uses `ILIKE`
  for LIKE-class ops and `LOWER()` for the rest. Disabled by default since
  it skips the column index. Persists per-rule in the saved filter tree.
- **Delete shortcut on the sidebar.** Pressing `Delete` with a sidebar
  selection drops the connection / database / schema / table / saved
  query (with the same destructive-confirm flow as the context menus).
  Honors multi-select on tables.
- **"Edit query" action on the table toolbar.** Opens a SQL tab
  pre-populated with the current page's effective `SELECT` (filters,
  sort, limit/offset). New `src/lib/build-table-sql.ts` helper builds
  it cross-dialect.
- **Optimistic schema/table drop in the tree.** Dropped items hide
  immediately instead of waiting for the schema list refresh.
- **Horizontal scroll preservation** on table refresh: paging or
  changing sort no longer snaps the grid back to column 0.

### Fixed
- **MySQL `_bin` collation columns showing `[N bytes]`** instead of
  text. `crates/driver-mysql/src/value_decode.rs` now falls back to raw
  bytes + UTF-8 decode when `_bin` collations make sqlx reject the
  `String` decode (the BINARY column flag is set on `_bin` by the
  server protocol).

## [0.4.1] - 2026-05-04

Polish on top of 0.4.0.

### Added
- **Schema/table folder navigation** in the sidebar with a multi-table
  ZIP export.
- **Drop-schema flow** parity between the menu and the new shortcut,
  with the same destructive confirm dialog.
- **Filter bar:** new rule chips auto-enter edit mode and the footer
  exposes Apply/Reset buttons.
- **Disconnect button** on the connection tree turns orange and prompts
  before closing tabs tied to that connection.
- **TERMS.md** disclaimer and a link from the README.

### Changed
- SQL import flow redirects directly to the relevant tab.
- Menu parity: every sidebar destructive action shares the same confirm
  primitive.

## [0.4.0] - 2026-05-01

Grid stability + query-tab polish.

### Added
- **Keep-mounted tabs.** Switching tabs no longer remounts the table
  view, so scroll position, selection, and pending edits survive.
- **Schema rename progress screen** with cancel/pause.
- **SQL alias autocomplete** in the query editor and persisted result
  grid state per query tab (column widths, sort, scroll position).
- **Manual F12** in production builds to open DevTools when troubleshooting.

### Fixed
- **Grid cursor pinning on Enter** so the next keypress stays on the
  edited cell instead of jumping. Required forking glide-data-grid for
  the `keepFocusOnAccept` prop.
- **DirtyFooter reflow:** float the footer over the grid so the first
  edit no longer triggers a layout-induced scroll reset.
- **JSON / boolean typing in the grid:** JSON5 leniency on parse,
  proper `tinyint(1)` boolean detection on MySQL, and a refresh after
  ALTER so the grid picks up new column types.
- **Data-transfer regressions:** progress UX, intra-table copy when the
  primary key is orderable, and the filter bar scope.
- Multiple `scrollAfterLayout` and `flushSync` workarounds removed in
  favor of the forked grid's native pin support.

## [0.3.0] - 2026-04-25

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
