# Releasing

## One-time setup

1. Add `TAURI_SIGNING_PRIVATE_KEY` to the repository secrets.
2. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the repository secrets.
3. Keep the matching public key in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).

The local signing files were generated under `.tauri/`, which is gitignored.

## Release flow

1. Bump the version in:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Commit the version bump.
3. Create and push a tag like `v0.1.1`.
4. GitHub Actions runs `.github/workflows/release.yml`.
5. The workflow publishes a GitHub Release with:
   - `Memory Guard.app`
   - `Memory Guard.dmg`
   - updater artifacts such as `latest.json` and signed archives

## Local builds

- `npm run tauri build`
  This produces a local `.app` bundle without updater artifacts.
- GitHub release builds use `src-tauri/tauri.release.conf.json` so local packaging does not require updater signing secrets.
