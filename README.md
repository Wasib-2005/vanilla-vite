# Vanilla Vite

Create a Vite app with the official interactive setup. Choose React or any other offered template, and optionally add a Node.js or Express backend in the same npm or pnpm workspace.

[![npm version](https://img.shields.io/npm/v/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![npm downloads](https://img.shields.io/npm/dm/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![GitHub repository](https://img.shields.io/badge/GitHub-Wasib--2005%2Fvanilla--vite-181717?logo=github)](https://github.com/Wasib-2005/vanilla-vite)

**Links:** [npm package](https://www.npmjs.com/package/create-vanilla-vite) · [GitHub repository](https://github.com/Wasib-2005/vanilla-vite) · [Report an issue](https://github.com/Wasib-2005/vanilla-vite/issues)

## Requirements

- Node.js 20.6 or newer
- npm or pnpm

The commands below work in Windows PowerShell or Command Prompt as well as macOS and Linux terminals. pnpm commands require pnpm to be installed; npm is sufficient.

## Create a project

With pnpm:

```bash
pnpm create vanilla-vite@latest my-app
```

With npm:

```bash
npm create vanilla-vite@latest my-app
```

Omit the project name to enter it when prompted:

```bash
pnpm create vanilla-vite@latest
# or
npm create vanilla-vite@latest
```

The generator starts the official `create-vite@latest` wizard in `my-app-client`. Choose **React** for a React application, then select JavaScript or TypeScript. You can instead choose any other template offered by Vite. Afterward, choose whether to install Tailwind CSS v4 and Axios. For React templates, you can also choose React Router, which adds a `MainRouter` with Home and Login pages and navigation. The router starter uses Tailwind utility classes when Tailwind is selected, or a standalone stylesheet otherwise. You can also choose React Icons or `@animateicons/react`. The Yes option is preselected for each yes/no prompt, including adding a backend; choose No to skip an option. Frontend setup questions appear in cyan, and backend setup questions appear in yellow. The frontend wizard may install dependencies temporarily; the generator removes nested install files and Git metadata, configures one shared workspace, and installs all dependencies from the project root.

### Non-interactive options

Use `--yes` to accept the default answers for generator prompts. It does not
answer the official create-vite template questions, so include `--template` to
skip those prompts as well. `--yes` also skips the npm update check. Individual
options select a value and skip that option's prompt:

```bash
pnpm create vanilla-vite@latest my-app --yes --template=react --backend=basic --ts --structure=simple --tailwind --pm=pnpm
npm create vanilla-vite@latest my-app -- --template=react --backend=express --js --axios --icons=react-icons --router
```

Available options are `--tailwind`, `--axios`, `--no-axios`, `--router`,
`--no-router`, and `--icons=react-icons|animateicons|none`;
`--backend=none|basic|express`; `--ts` or `--js` (these language flags apply
to the optional backend only);
`--structure=simple|module`; `--pm=npm|pnpm`; and
`--install-mode=adD|plain|both` (controls dependency install tooling; adD is default).
`--no-tailwind` opts out of
Tailwind when using `--yes`. `--template=vanilla` passes a template directly to
create-vite. `--no-start` creates the project without starting its dev server.
The generator offers to initialize Git and make an initial commit; use
`--no-git` to skip this step.

The CLI checks npm for a newer version before scaffolding. Skip this check with
`--no-update-check`; it is also skipped automatically in CI. To avoid any
network exposure by default, Vite binds to localhost. Pass `--host` when
creating the project to make the frontend dev server available on your network:

```bash
pnpm create vanilla-vite@latest my-app --host
npm create vanilla-vite@latest my-app -- --host
```

For npm, also forward the update-check option with `--`:

```bash
npm create vanilla-vite@latest my-app -- --no-update-check
```

The optional backend supports JavaScript or TypeScript, either basic Node.js or Express, and a simple or module-based folder layout. Express and the module-based layout are preselected by default; Express adds Express, CORS, and dotenv, enables JSON parsing, and provides `GET /api/health`, returning `{ "status": "ok" }`. The basic Node.js server uses dotenv to load `.env`, supports CORS, returns the same health response, and responds with JSON 404s for unknown paths. In the Express module layout, `/` and `/api/health` return JSON and unknown paths return a JSON 404. When a backend is selected, the generated frontend includes a **Check connection** button that requests `/api/health` and reports whether the backend is reachable. This works with or without React Router and is omitted for frontend-only projects. Both backend layouts create the `src/app` and `src/server` entry points. The simple layout has `routes`, `controllers`, `middleware`, and `config` folders; the module-based layout has `module`, `config`, `middleware`, and `utils` folders plus `mainRouter`. The `--default` flag selects the simple layout without prompting.

Pass `--default` after the project name to use the simple backend folder layout without prompting:

```bash
pnpm create vanilla-vite@latest my-app --default
npm create vanilla-vite@latest my-app -- --default
```

The generated project structure is:

```text
my-app/
├── my-app-client/       # Vite app; choose React or another Vite template
├── my-app-server/       # optional backend
├── scripts/
├── package.json
└── pnpm-workspace.yaml  # used by pnpm; npm uses package.json workspaces
```

The frontend gets a `.env.local` file with `VITE_API_URL=http://localhost:4000` and a tracked `.env.example` template. If you choose a backend, it gets a `.env` file with `PORT=4000`, `HOST=localhost`, and `CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`, plus its own `.env.example`. On startup, the development runner recreates either ignored local environment file from `.env.example` when it is missing. The local `.env` files are ignored by Git.

## Run the project

The generator starts the development server automatically after creating the
project. To start it again later, run this from the project root:

```bash
pnpm dev
# or
npm run dev
```

At startup, the runner displays the dependency commands and a highlighted shortcut panel. Only one development runner per project is supported; a second instance exits without clearing the active runner's log. Logs are combined by default. Press `g` to split client and server logs side by side with a divider, press it again to stack the logs with a horizontal divider, and once more to return to the combined view. The split layouts use headings and dividers rather than enclosing boxes. App output and runner notices are recorded in the root `.dev.log` file, which is cleared each time `dev` starts. New log lines append without clearing earlier output, including when either app restarts. Pressing `g` redraws the current view from that file. Press `r` to restart both apps, `h` to toggle network hosting, `c` to clear the terminal and empty `.dev.log`, or Ctrl+C to stop. Enabling `h` sets the client `VITE_API_URL` to the preferred LAN IPv4 address, binds the backend to `0.0.0.0`, and configures backend CORS for localhost and every detected IPv4 interface (including container bridges), then restarts both apps; disabling it restores localhost values. The selected hosting mode is kept when you later press `r`.
Pass `--host` when creating a project to start with network hosting enabled.
The generated Vite config enables `server.strictPort`; if port 5173 is already in
use, the client process stops with a port-in-use error rather than silently
switching ports.

Run one workspace individually. Add `dev` to run it in development mode:

```bash
pnpm client
pnpm server
pnpm client dev
```

Or with npm:

```bash
npm run client
npm run server
npm run client -- dev
```

The server commands are only available if you chose a backend.

Use the root `build` and `lint` scripts to run the matching script in every
workspace that defines it:

```bash
pnpm build
pnpm lint
# or
npm run build
npm run lint
```

## Add dependencies

During scaffolding, you can select how dependencies should be installed:

1. **adD only (default)**: All packages should be added using `pnpm adD <package>` or `npm run adD -- <package>`. Direct root installs are blocked by the workspace install guard to prevent placing packages in the wrong location.
2. **Plain install only**: Dependencies are installed using standard `pnpm add <package>` or `npm install <package>`. No guard is enabled and `adD` is not scaffolded.
3. **Both**: Provides the `adD` interactive workspace picker, but also allows direct `pnpm add` / `npm install` without blocking.

When using `adD` (in `adD only` or `both` mode), the prompt lets you choose the project root, client, or server (if you created one); the client is selected by default, including when you press Esc:

```bash
pnpm adD <package>
pnpm add-dependency <package>
npm run adD -- <package>
npm run add-dependency -- <package>
```

To sync or install all workspace dependencies across the monorepo, run `adD` with no package arguments:

```bash
pnpm adD
# or with npm:
npm run adD
```

In `adD only` mode, do not use `npm install <package>`, `npm add <package>`, or `pnpm add <package>` directly to add packages. They bypass the location prompt and are blocked by the workspace install guard. A failed or aborted install can leave `node_modules` behind; running `pnpm adD` with no arguments safely syncs dependencies.

### Toggle features on and off

You can dynamically toggle monorepo features on and off at any time.

To turn off `adD` / install guard (switches to plain install mode and hides the dev banner):
```bash
pnpm turn-off adD
# or using shortcuts:
pnpm tO adD
pnpm tO
# with npm:
npm run tO -- adD
```

To turn `adD` / install guard back on:
```bash
pnpm turn-on adD
# or using shortcuts:
pnpm tN adD
pnpm tN
# with npm:
npm run tN -- adD
```

Aliases supported for the `adD` feature: `adD`, `add-dependency`, `install`, `i`, `add`, `guard`, `install-mode`. When run without an argument, `tN` and `tO` target `adD` by default.

To inspect current features and their status:
```bash
node scripts/toggle-feature.mjs status
```

## Development

To test from source:

```bash
git clone https://github.com/Wasib-2005/vanilla-vite
cd vanilla-vite
pnpm install
```

Run the generator directly:

```bash
pnpm exec node bin/create-template.mjs my-app
# or
node bin/create-template.mjs my-app
```

Run the scaffold smoke matrix (npm and pnpm, JavaScript and TypeScript,
frontend-only/basic Node/Express backends, with and without Tailwind) with:

```bash
pnpm test:smoke
```

Use `pnpm test:smoke -- --quick` for a smaller publish-time check,
`SMOKE_FILTER=<text> pnpm test:smoke` to select matching cases, or
`SMOKE_KEEP=1 pnpm test:smoke` to keep generated test projects for inspection.

## Version management and publishing

Vanilla-Vite includes a version management CLI to safely bump versions and publish to the npm registry.

### With a specified version

```bash
pnpm vpublish 1.0.5
```

### Interactive prompt

If invoked without arguments, the version manager compares the latest npm version and the local package version, then prompts for the target version:

```bash
pnpm vpublish
```

Interactive example prompt:

```text
Vanilla-Vite Version Manager

Latest npm version: 1.2.1
Local repository version: 1.2.0

Enter the new version:
```

### Safety and validation checks

Before publishing, the version manager automatically performs the following safeguards:

1. **Root execution restriction**: The CLI refuses to publish when run as root on Linux or macOS to prevent accidental privilege escalation and file permission issues. To override in automated environments, set `ALLOW_ROOT_PUBLISH=1` or pass `--allow-root`.
2. **Repository verification**: Validates that the command runs from the root of `create-vanilla-vite`.
3. **SemVer validation**: Enforces strict semantic versioning (e.g. `1.0.5`, `1.1.0-beta.1`). Invalid versions such as `1.0` or `hello` are rejected.
4. **Duplicate publication prevention**: Checks the npm registry to verify the target version has not already been published.
5. **Downgrade prevention**: Rejects versions lower than the latest published npm version (override available with `--allow-downgrade`).
6. **Authentication check**: Verifies active npm registry credentials before running build and publish steps.
7. **Pre-publish test verification**: Automatically executes `pnpm test:smoke -- --quick` to guarantee all critical smoke tests pass before publishing.
8. **Prerelease tag routing**: Prerelease versions (such as `1.1.0-beta.1`, `1.1.0-rc.1`) are published with their corresponding distribution tag (`beta`, `rc`, etc.) rather than `latest`. Stable versions publish under `latest`.
9. **Changelog verification**: Checks `CHANGELOG.md` for an entry corresponding to the target version. If an entry already exists, publishing continues automatically. If no entry exists, the CLI prompts for what to add to the changelog (or accepts `--changelog="<entry>"`).
10. **Confirmation prompt**: Displays a complete publication summary and requires explicit confirmation before modifying files or uploading packages.

### Non-interactive and CI usage

```bash
pnpm vpublish 1.2.2 --yes
```

To test the publishing process without modifying the registry:

```bash
pnpm vpublish 1.2.2 --dry-run
```

## Troubleshooting

### Installation guard blocks direct install

Direct installs in the root workspace are blocked in `adD only` mode to keep dependencies organized within individual client and server workspaces.
- Add dependencies using:
  ```bash
  pnpm adD <package>
  # or with npm:
  npm run adD -- <package>
  ```
- To recover from an interrupted install or sync all workspace packages:
  ```bash
  pnpm adD
  # or with npm:
  npm run adD
  # or with the allow flag:
  VANILLA_VITE_ALLOW_INSTALL=1 pnpm install
  ```

### Publishing via CLI or GitHub Release

Package publishing is intended to be performed EITHER via the local CLI `pnpm vpublish` OR via a GitHub release, not both. The GitHub Actions release workflow automatically checks whether the version has already been published to the npm registry and skips the publish step if it already exists.

### Port conflicts

- If port 5173 is in use, Vite stops with a port error due to `strictPort: true`. Free port 5173 or modify `vite.config` to use another port.
- If backend port 4000 is in use, Express logs `Port 4000 is already in use.` and exits cleanly with non-zero exit code. Change `PORT` in `[server-folder]/.env`.

### Root execution error on publish

If you see:
```text
Refusing to run publishing operations as root.
Publishing packages with root privileges is unsafe.
```
Run `pnpm vpublish` as your regular user. In automated container environments that run as root, set `ALLOW_ROOT_PUBLISH=1` or pass `--allow-root`.

## License

ISC
