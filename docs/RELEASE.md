# Release checklist — BaseMaster

Guia pra distribuir binários assinados e livres de SmartScreen/Gatekeeper.

## Windows

### 1. Code signing grátis — SignPath Foundation

[SignPath](https://signpath.org/) oferece code signing gratuito pra projetos OSS. O cert é EV-equivalente, ou seja, **bypassa o SmartScreen imediatamente** (sem fase de "reputation" como certs OV).

**Passos:**

1. Criar conta: <https://app.signpath.io/Web/SignUp>
2. Submeter aplicação OSS: <https://signpath.org/apply-for-open-source>
   - Repo público no GitHub
   - License OSI-aprovada (MIT/Apache/GPL/etc)
   - Descrição curta do projeto
3. Aguardar aprovação (dias).
4. Configurar uma **Project** e uma **Signing Policy** (ex: `release-signing` com step `tauri-msi` + `tauri-exe`).
5. Gerar um **CI user** e token.
6. Adicionar secrets no GitHub Actions:
   - `SIGNPATH_API_TOKEN`
   - `SIGNPATH_ORG_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`

**Workflow exemplo** (`.github/workflows/release.yml`):

```yaml
- name: Build
  run: pnpm tauri build

- name: Sign via SignPath
  uses: signpath/github-action-submit-signing-request@v1
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: ${{ secrets.SIGNPATH_ORG_ID }}
    project-slug: ${{ secrets.SIGNPATH_PROJECT_SLUG }}
    signing-policy-slug: ${{ secrets.SIGNPATH_SIGNING_POLICY_SLUG }}
    artifact-configuration-slug: main
    github-artifact-id: "${{ steps.upload.outputs.artifact-id }}"
    wait-for-completion: true
    output-artifact-directory: signed
```

### 2. winget (Microsoft Package Manager)

winget instala direto do repositório `microsoft/winget-pkgs` (manifests YAML). Binários assinados + hash verificado → SmartScreen libera.

**Após o primeiro release assinado:**

1. Fork <https://github.com/microsoft/winget-pkgs>
2. Criar manifest em `manifests/k/Kelvin/BaseMaster/<versão>/`:
   - `Kelvin.BaseMaster.yaml` (root)
   - `Kelvin.BaseMaster.installer.yaml` (URL do `.msi`/`.exe` + SHA256)
   - `Kelvin.BaseMaster.locale.en-US.yaml` (descrição)
3. PR. CI do winget valida; aprovação manual do time da MS.

Automação: [winget-create](https://github.com/microsoft/winget-create) (`wingetcreate update Kelvin.BaseMaster --version X.Y.Z --urls <url>`).

### 3. Alternativas sem assinatura

- **Scoop**: adicionar a um bucket (`Kelvin/basemaster-bucket`). `scoop install basemaster`.
- **Chocolatey**: pacote comunitário. Requer uploads a cada versão. Menos barreiras que winget, sem assinatura obrigatória.

## macOS

### Code signing obrigatório

Sem escape do Gatekeeper sem [Apple Developer Program](https://developer.apple.com/programs/) (**US$ 99/ano**).

1. Inscrever-se no Apple Developer.
2. Gerar **Developer ID Application** cert no Keychain.
3. Exportar `.p12`, adicionar aos secrets:
   - `APPLE_CERTIFICATE` (base64 do .p12)
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_ID` (seu email Apple)
   - `APPLE_TEAM_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD` (gerado em <https://appleid.apple.com>)
4. Tauri v2 tem [notarização integrada](https://v2.tauri.app/distribute/sign/macos/).

### Distribuição

- **Homebrew Cask**: PR em `homebrew/cask` ou bucket próprio.
- **GitHub Releases**: com `.dmg` assinado + notarizado.

## Linux

Sem assinatura obrigatória.

- **AppImage**: `tauri build --target appimage` → GH Releases.
- **Flathub**: PR em `flathub/flathub`. Sandbox-friendly.
- **snap**: `snapcraft.io`. Requer yaml manifest + review.

## Sentry (crash reporting)

Criar projeto em <https://sentry.io/> e pegar o DSN. Injetar via env nos builds:

```yaml
env:
  VITE_SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
```

- Frontend: `VITE_SENTRY_DSN` (build-time).
- Backend: `SENTRY_DSN` (runtime env var — bundle com `.env` ou setar via installer).

**Free tier**: 5k errors/mês + 10k performance events. OK pra OSS.

## Checklist de release

- [ ] Bump version no `Cargo.toml` (workspace) e `package.json`.
- [ ] Commit + tag `vX.Y.Z`.
- [ ] Push tag → GitHub Actions builda todas plataformas.
- [ ] Binários Windows → SignPath assina.
- [ ] Binários macOS → notarização Apple.
- [ ] Release notes no GH Releases.
- [ ] `wingetcreate update` (Windows).
- [ ] Atualizar Homebrew Cask (macOS).
- [ ] Anunciar em canais relevantes.
