// Builds `basemaster-cli` and drops it in src-tauri/binaries/ under the
// `<name>-<target-triple>` filename Tauri's `bundle.externalBin` expects.
// Runs before `tauri dev` / `tauri build` (see tauri.conf.json) and before
// `cargo check` in CI: tauri-build fails the GUI build when the sidecar
// file is missing.
//
//   node scripts/build-cli.mjs            # release profile (what ships)
//   node scripts/build-cli.mjs --dev      # debug profile (fast, dev store)
//   BM_CLI_TARGET=<triple>                # cross target (also --target=<triple>;
//                                         # TAURI_ENV_TARGET_TRIPLE is honoured too)
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const host = hostTriple();
// Tauri exports the triple it builds for to before*Command; only pass
// `--target` when it differs from the host so the common case shares the
// plain target/<profile> dir (and its cache) with the rest of the workspace.
const requested =
  (targetArg && targetArg.slice("--target=".length)) ||
  process.env.BM_CLI_TARGET ||
  process.env.TAURI_ENV_TARGET_TRIPLE;
const explicitTarget = requested && requested !== host ? requested : undefined;
const target = explicitTarget || host;

function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const m = out.match(/^host:\s*(\S+)/m);
  if (!m) throw new Error("could not read host triple from `rustc -vV`");
  return m[1];
}

function targetDir() {
  const meta = JSON.parse(
    execSync("cargo metadata --format-version 1 --no-deps", { encoding: "utf8", cwd: root }),
  );
  return meta.target_directory;
}

const cargoArgs = ["cargo", "build", "-p", "basemaster-cli"];
if (!dev) cargoArgs.push("--release");
if (explicitTarget) cargoArgs.push("--target", target);
execSync(cargoArgs.join(" "), { stdio: "inherit", cwd: root });

const exe = target.includes("windows") ? ".exe" : "";
const profile = dev ? "debug" : "release";
const src = join(targetDir(), ...(explicitTarget ? [target] : []), profile, `basemaster-cli${exe}`);
const dstDir = join(root, "src-tauri", "binaries");
mkdirSync(dstDir, { recursive: true });
const dst = join(dstDir, `basemaster-cli-${target}${exe}`);
copyFileSync(src, dst);
console.log(`cli sidecar ready: ${dst}`);
