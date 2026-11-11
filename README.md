# Vanilla Vite

Create a Vite app with the official interactive setup. Choose React or any other offered template, and optionally add a Node.js or Express backend in the same npm or pnpm workspace.

[![npm version](https://img.shields.io/npm/v/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![npm downloads](https://img.shields.io/npm/dm/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![GitHub repository](https://img.shields.io/badge/GitHub-Wasib--2005%2FVanilla--Vite-181717?logo=github)](https://github.com/Wasib-2005/Vanilla-Vite)

**Links:** [npm package](https://www.npmjs.com/package/create-vanilla-vite) · [GitHub repository](https://github.com/Wasib-2005/Vanilla-Vite) · [Report an issue](https://github.com/Wasib-2005/Vanilla-Vite/issues)

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
`--structure=simple|module`; and `--pm=npm|pnpm`. `--no-tailwind` opts out of
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

Always use one of these commands to add dependencies. The prompt lets you
choose the project root, client, or server (if you created one); the client is
selected by default, including when you press Esc:

```bash
pnpm adD <package>
pnpm add-dependency <package>
npm run adD -- <package>
npm run add-dependency -- <package>
```

Do not use `npm install`, `npm add`, `pnpm install`, or `pnpm add` directly to
add packages. They bypass the location prompt or may be blocked by the
workspace install guard. The guard runs only when the package manager invokes
the root `preinstall` hook; direct `npm install <package>` behavior varies by
npm version and is not blocked by versions that skip that hook. A failed or
aborted install can leave `node_modules` behind, causing a plain reinstall to
be blocked. Use one of the `adD` commands above to add dependencies.

## Development

To test from the source:

```bash
git clone https://github.com/Wasib-2005/Vanilla-Vite

pnpm exec node [Stored Path]/Vanilla-Vite/bin/create-template.mjs my-app
# or
npm exec -- node [Stored Path]/Vanilla-Vite/bin/create-template.mjs my-app
```

Run the scaffold smoke matrix (npm and pnpm, JavaScript and TypeScript,
frontend-only/basic Node/Express backends, with and without Tailwind) with:

```bash
npm install
npm run test:smoke
```

Use `npm run test:smoke -- --quick` for a smaller publish-time check,
`SMOKE_FILTER=<text> npm run test:smoke` to select matching cases, or
`SMOKE_KEEP=1 npm run test:smoke` to keep generated test projects for inspection.

## License

ISC
