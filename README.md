# Vanilla Vite

Create a Vite app with the official interactive setup. Choose React or any other offered template, and optionally add a Node.js or Express backend in the same npm or pnpm workspace.

[![npm version](https://img.shields.io/npm/v/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![npm downloads](https://img.shields.io/npm/dm/create-vanilla-vite)](https://www.npmjs.com/package/create-vanilla-vite)
[![GitHub repository](https://img.shields.io/badge/GitHub-Wasib--2005%2FVanilla--Vite-181717?logo=github)](https://github.com/Wasib-2005/Vanilla-Vite)

**Links:** [npm package](https://www.npmjs.com/package/create-vanilla-vite) · [GitHub repository](https://github.com/Wasib-2005/Vanilla-Vite) · [Report an issue](https://github.com/Wasib-2005/Vanilla-Vite/issues)

## Requirements

- Node.js 20 or newer
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

The optional backend supports JavaScript or TypeScript, either basic Node.js or Express, and a simple or module-based folder layout. Express and the module-based layout are preselected by default; Express adds Express and dotenv, enables JSON parsing, and provides `GET /api/health`, returning `{ "status": "ok" }`. Both layouts create the `src/app` and `src/server` entry points. The simple layout has `routes`, `controllers`, `middleware`, and `config` folders; the module-based layout has `module`, `config`, `middleware`, and `utils` folders plus `mainRouter`. The `--default` flag selects the simple layout without prompting.

Pass `--default` after the project name to use the simple backend folder layout without prompting:

```bash
pnpm create vanilla-vite@latest my-app --default
npm create vanilla-vite@latest my-app --default
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

The frontend gets a `.env.local` file with `VITE_API_URL=http://localhost:4000`. If you choose a backend, it gets a `.env` file with `PORT=4000`. Both are ignored by Git.

## Run the project

The generator starts the development server automatically after creating the
project. To start it again later, run this from the project root:

```bash
pnpm dev
# or
npm run dev
```

This starts the frontend (bound to network interfaces with Vite's `--host` flag) and, if selected, the backend together. In an interactive terminal, press `r` to restart both apps, `c` to clear the terminal, or Ctrl+C to stop.

Run one workspace individually:

```bash
pnpm client
pnpm server
```

Or with npm:

```bash
npm run client
npm run server
```

The server commands are only available if you chose a backend. Add `-dev` to run a workspace in development mode, for example `pnpm client -dev` or `pnpm server -dev`.

## Add dependencies

Always use one of these commands to add dependencies. The prompt lets you
choose the project root, client, or server (if you created one):

```bash
pnpm adD <package>
pnpm add-dependency <package>
npm run adD -- <package>
npm run add-dependency -- <package>
```

Do not use `npm install`, `npm add`, `pnpm install`, or `pnpm add` directly to
add packages. They bypass the location prompt or are blocked by the workspace
install guard. npm requires `run` to invoke a project script, so `npm adD`
without `run` is not valid.

## Development

To test from the source:

```bash
git clone https://github.com/Wasib-2005/Vanilla-Vite

pnpm exec node [Stored Path]/Vanilla-Vite/bin/create-template.mjs my-app
# or
npm exec -- node [Stored Path]/Vanilla-Vite/bin/create-template.mjs my-app
```

## License

ISC
