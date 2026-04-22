# AGENTS.md

## Project overview
This project is a lightweight macOS menu bar app for monitoring memory usage.
The app should help non-technical users identify memory-heavy apps and take action.

## Tech stack
- Rust
- Tauri 2
- React + TypeScript

## Product constraints
- Keep the app lightweight
- Do not build a full system monitor
- Focus only on memory usage
- Default to simple UI and minimal settings
- Do not implement Chrome tab-level monitoring in v1

## Performance constraints
- In background mode, only poll total memory usage
- Do not scan and sort the full process list unless:
  - the user opens the panel, or
  - memory exceeds the threshold and a one-time top-app scan is needed
- Avoid blocking the UI thread
- Prefer simple and maintainable code over over-engineering

## Development rules
- Build incrementally
- After each major step, explain what was changed
- Keep files organized and avoid unnecessary dependencies
- Ask before adding a heavy third-party dependency
- Prefer safe app termination over force quit by default