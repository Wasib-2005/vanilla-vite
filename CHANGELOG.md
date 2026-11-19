# Changelog

## 1.2.3 - 2026-11-19

- Added feature toggle commands (`turn-on`, `trun-on`, `tN` and `turn-off`, `trun-off`, `tO`) to switch features like `adD` / install guard on and off dynamically.
- Added modular feature manager `scripts/toggle-feature.mjs` with alias resolution (`adD`, `add-dependency`, `install`, `i`, `add`, `guard`, `install-mode`) and status reporting.
- Fixed CLI update relaunch to target the exact new version instead of `@latest`, preventing pnpm and npm dlx/exec cache reuse of stale versions.
- Added a pre-publish changelog check in `pnpm vpublish` to verify an entry exists for the target version or prompt for changelog items.
- Extended `vpublish` to support passing changelog items non-interactively via `--changelog="<entry>"`.
- Raised pre-publish smoke validation timeout in version manager to 20 minutes with `VPUBLISH_TEST_TIMEOUT_MS` override.
- Replaced root node_modules symlinking in test suite with isolated fake binaries and minimal stubs.
- Fixed ReferenceError for file extensions in Express smoke tests.

## 1.2.2 - 2026-11-19

- Added `--install-mode=adD|plain|both` option and interactive prompt to choose dependency installation behavior.
- Added dependency synchronization when running `adD` with no package arguments.
- Fixed Express 5 server listen callback to prevent printing success message on startup errors.
- Fixed `--dry-run` in version manager to never write package files.
- Added full rollback on publish failure to restore original package files.
- Switched version manager command execution to cross-spawn for Windows compatibility and interactive 2FA/OTP publishing.
- Updated release workflow to derive dist-tag using version-manager and skip duplicate versions on npm.
- Added unit tests step to CI workflow.
- Mapped signal exit codes to 130 for SIGINT and 143 for SIGTERM in runner and dependency scripts.
- Guarded dev runner process signaling to avoid sending signals to terminated child processes.
- Excluded internal version-manager script from published package files.

## 1.2.1 - 2026-11-12

- Made the npm install-guard smoke check account for npm versions that skip the root preinstall lifecycle on direct package installs.
- Updated CI to install dependencies from the pnpm lockfile.
- Verified all 36 scaffold smoke-test scenarios pass on Linux and Windows.

## 1.2.0 - 2026-11-11

- Added non-interactive scaffold options and optional Git initialization.
- Added the npm/pnpm scaffold smoke-test matrix and GitHub Actions CI.
- Added graceful backend shutdown and JSON error handling.
- Preserved child-process colors in the combined development runner.
- Made the `h` shortcut update LAN API and CORS environment settings for both workspaces.
- Added a frontend backend-health control when a backend is scaffolded.
- Preserved completed projects when cancelling the Git prompt and restored ignored env files from examples.
- Loaded backend `.env` files with dotenv and corrected TypeScript basic-server commands.
- Restricted Vite to port 5173 and added explicit Axios and icon-library selections.
- Shared basic Node routing/CORS logic across layouts and added JSON Express module routes and 404s.
- Defaulted dependency installation to the client and aligned pnpm build approvals with CI.
- Added highlighted dependency and shortcut banners to `npm run dev` / `pnpm dev`.
- Added `g` to cycle combined, side-by-side, and stacked log layouts; moved the dependency reminder out of scaffolding output.
- Replaced framed log panels with headings and simple dividers.
- Retained full development logs for the runner session across layout changes and app restarts.
- Recorded each development session in a root `.dev.log`, cleared at startup and used to redraw alternate log layouts.
- Cleaned up incomplete scaffolds on interruption and kept Vite config-shape mismatches non-fatal.
- Added bounded log replay, missing-env-template fallback, and consistent specific-origin CORS variation.
- Kept backend status controls development-only and documented strict-port and `--yes` update-check behavior.
- Expanded smoke checks for generated feature installs, CORS variation, and both pnpm build-approval keys.
- Changed the `c` development shortcut to clear the terminal and the current `.dev.log` contents.
- Added stricter CLI option validation, safe scaffold cancellation, install retry guidance, and Git-worktree detection.
- Added backend host binding and environment resets for reliable local and network hosting; protected active development logs with a runner lock.
- Expanded smoke coverage for frontend templates, fresh installs, CLI argument errors, and React lint scripts.
- Added bounded CI runs and release checks, smoke validation, pnpm version alignment, and npm provenance publishing.
