# Changelog

All notable changes to this project should be recorded here.

## Unreleased

### Added

- Added a GitHub Releases based updater pipeline with signed updater assets and `latest.json`.
- Added a dedicated release workflow under `.github/workflows/release.yml`.
- Added a local release helper script at `scripts/release.mjs`.
- Added `npm run release`, `npm run release:push`, and `npm run bundle:dmg` scripts.
- Added a lightweight self-memory readout to the overview panel.

### Changed

- Changed threshold notifications to show only a high-memory warning and ask the user to open the panel for details.
- Changed app scanning so heavy process scans only happen when the overview panel is open.
- Changed local default bundling to generate `.app` by default, while GitHub release builds use a separate release config.
- Changed the release flow so `release:push` rolls back the local version bump, commit, and tag if the push fails.

## 0.1.0

- Initial public release.
