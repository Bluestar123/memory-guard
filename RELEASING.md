# Releasing

## One-time setup

1. Add `TAURI_SIGNING_PRIVATE_KEY` to the repository secrets.
2. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the repository secrets.
3. Keep the matching public key in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).

The local signing files were generated under `.tauri/`, which is gitignored.

## Release flow

1. Run one of these commands:
   - `npm run release`
     This bumps the current patch version, for example `0.1.0 -> 0.1.1`.
   - `npm run release:push`
     This bumps the current patch version, creates the release commit and tag, then pushes both automatically. If the push fails, the script rolls back the local version bump, commit, and tag.
   - `npm run release -- -v 0.2.0`
     This releases an explicit version.
   - `npm run release:push -- -v 0.2.0`
     This releases an explicit version and pushes it immediately. If the push fails, the script rolls back the local version bump, commit, and tag.
2. Before releasing, add the user-facing or developer-facing changes to [`CHANGELOG.md`](CHANGELOG.md) under `Unreleased`.
3. The script updates:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
4. The script creates:
   - a commit: `release vX.Y.Z`
   - a tag: `vX.Y.Z`
5. If you used `npm run release`, push both:
   - `git push origin main`
   - `git push origin vX.Y.Z`
6. GitHub Actions runs `.github/workflows/release.yml`.
7. The workflow publishes a GitHub Release with:
   - `Memory Guard.app`
   - `Memory Guard.dmg`
   - updater artifacts such as `latest.json` and signed archives

## Local builds

- `npm run tauri build`
  This produces a local `.app` bundle without updater artifacts.
- GitHub release builds use `src-tauri/tauri.release.conf.json` so local packaging does not require updater signing secrets.
