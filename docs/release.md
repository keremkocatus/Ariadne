# Release process

Ariadne ships as native installers (Windows/macOS/Linux) built and published by a
GitHub Actions workflow, with an in-app updater that checks GitHub Releases for new
versions.

## One-time setup (already done for this repo)

- **`tauri-plugin-updater` + `tauri-plugin-process`** are registered in
  [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) and granted via
  `updater:default` / `process:default` in
  [`capabilities/default.json`](../src-tauri/capabilities/default.json).
- **Signing keypair**: generated with `npm run tauri signer generate`. The private
  key lives at `~/.tauri/ariadne.key` on the machine that generated it — **never
  commit it**. The public key is embedded in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`; the app refuses to install an update whose manifest
  isn't signed by the matching private key.
- **Updater endpoint**: `plugins.updater.endpoints` points at
  `https://github.com/keremkocatus/Ariadne/releases/latest/download/latest.json`,
  the manifest the release workflow publishes on every release.
- **GitHub Actions secrets** (repo Settings → Secrets and variables → Actions) —
  required before the workflow can produce signed updater artifacts:
  - `TAURI_SIGNING_PRIVATE_KEY` — full contents of `~/.tauri/ariadne.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen when the key was
    generated
  - `GITHUB_TOKEN` is provided automatically by Actions, no setup needed.

If the private key or its password is ever lost, past releases keep working but
you can no longer sign new updates against the same pubkey — existing installs
won't trust a release signed by a new key. Regenerating requires shipping a new
pubkey in `tauri.conf.json`, which itself has to reach users through one last
release signed by the old key (or manual reinstall).

## Cutting a release

1. Bump the version in all three places (they must match):
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package].version`
2. Run the full gate locally (see `CLAUDE.md`) and commit the version bump.
3. Tag and push:
   ```
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. The `release` workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
   builds Windows (NSIS), macOS (arm64 + x64 `.dmg`), and Linux (`.deb`/`.AppImage`)
   in parallel, signs the updater artifacts, and opens a **draft** GitHub Release
   with all installers plus `latest.json` attached.
5. Review the draft, edit the release notes (the body becomes the update's
   changelog, shown by the in-app "Update available" toast), and publish it.

Publishing is the point at which the in-app updater — and anyone hitting
`.../releases/latest` — sees the new version.

## How the in-app updater works

- On startup, [`checkForUpdateOnStartup`](../src/lib/updater.ts) silently calls
  the updater plugin's `check()`. If nothing's newer, it does nothing; startup
  never nags.
- If a newer signed release exists, a toast offers "Install & restart", which
  downloads, verifies the signature, installs, and relaunches via
  `tauri-plugin-process`.
- Settings → "Check for updates" runs the same check on demand and always
  reports back (including "you're up to date" or a network error).

## Installation notes for users

- **Windows**: the NSIS `.exe` is unsigned (no code-signing certificate yet), so
  SmartScreen shows an "Unknown publisher" warning on first run — "More info" →
  "Run anyway". A future release can add a code-signing cert to remove this.
- **macOS**: unsigned/un-notarized, so Gatekeeper blocks a plain double-click —
  users need to right-click → Open the first time. Removing this needs an Apple
  Developer account ($99/yr) and notarizing the build in CI.
- **Linux**: `.deb`/`.AppImage` install and run without any warning.

## Local build (no release)

`npm run tauri build` produces the same installers under
`src-tauri/target/release/bundle/` without touching GitHub — useful for testing
packaging changes. It only builds for the host OS/arch; cross-platform builds
require the CI matrix.
