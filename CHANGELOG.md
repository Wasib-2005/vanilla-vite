# Changelog

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
