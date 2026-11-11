#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const allowedOptions = [
  "--yes",
  "--default",
  "--host",
  "--tailwind",
  "--no-tailwind",
  "--axios",
  "--no-axios",
  "--router",
  "--no-router",
  "--icons",
  "--backend",
  "--ts",
  "--js",
  "--structure",
  "--pm",
  "--template",
  "--no-start",
  "--no-update-check",
  "--no-git",
];
const valueOptions = new Set(["--icons", "--backend", "--structure", "--pm", "--template"]);
const optionNames = new Set(allowedOptions);
const positionalArgs = [];
const optionErrors = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!argument.startsWith("--")) {
    positionalArgs.push(argument);
    continue;
  }
  const separator = argument.indexOf("=");
  const name = separator === -1 ? argument : argument.slice(0, separator);
  if (!optionNames.has(name)) {
    optionErrors.push(`Unknown option: ${name}`);
    continue;
  }
  if (valueOptions.has(name)) {
    if (separator === -1 || !argument.slice(separator + 1)) {
      optionErrors.push(`${name} requires a value in the form ${name}=<value>`);
      if (separator === -1 && args[index + 1] && !args[index + 1].startsWith("--")) {
        index += 1;
      }
    }
  } else if (separator !== -1) {
    optionErrors.push(`${name} does not accept a value`);
  }
}
const readOption = (name) =>
  args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const hasOption = (name) => args.includes(`--${name}`);
const yes = hasOption("yes");
let activeChild;
let creationCancelled = false;
const useDefaultStructure =
  hasOption("default") || process.env.npm_config_default === "true";
const exposeClient = hasOption("host");
const noTailwind = hasOption("no-tailwind");
const noAxios = hasOption("no-axios");
const noStart = hasOption("no-start");
const skipUpdateCheck =
  hasOption("no-update-check") || yes || process.env.CI !== undefined;
const backendOption = readOption("backend");
const languageOption = hasOption("ts") ? "ts" : hasOption("js") ? "js" : null;
const structureOption = readOption("structure");
const requestedPackageManager = readOption("pm");
const templateOption = readOption("template");
const iconsOption = readOption("icons");
if (backendOption !== undefined && !["none", "basic", "express"].includes(backendOption)) {
  optionErrors.push("--backend must be none, basic, or express");
}
if (hasOption("ts") && hasOption("js")) {
  optionErrors.push("Use only one of --ts or --js");
}
if (hasOption("router") && hasOption("no-router")) {
  optionErrors.push("Use only one of --router or --no-router");
}
if (structureOption !== undefined && !["simple", "module"].includes(structureOption)) {
  optionErrors.push("--structure must be simple or module");
}
if (
  requestedPackageManager !== undefined &&
  !["npm", "pnpm"].includes(requestedPackageManager)
) {
  optionErrors.push("--pm must be npm or pnpm");
}
if (noTailwind && hasOption("tailwind")) {
  optionErrors.push("Use only one of --tailwind or --no-tailwind");
}
if (noAxios && hasOption("axios")) {
  optionErrors.push("Use only one of --axios or --no-axios");
}
if (
  iconsOption !== undefined &&
  !["react-icons", "animateicons", "none"].includes(iconsOption)
) {
  optionErrors.push("--icons must be react-icons, animateicons, or none");
}
if (args.some((argument) => argument.startsWith("--template=")) && !templateOption) {
  optionErrors.push("--template must include a template name");
}
if (optionErrors.length) {
  console.error(
    `${optionErrors.join("\n")}\nAllowed options: ${allowedOptions.join(", ")}`,
  );
  process.exit(1);
}
let projectName = positionalArgs[0];
const validProjectName = (name) => /^[a-z0-9][a-z0-9_-]*$/.test(name);

if (!projectName && stdin.isTTY) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    do {
      projectName = (await prompt.question("Project name: ")).trim();
      if (!validProjectName(projectName)) {
        console.error("Use lowercase letters, numbers, hyphens, or underscores.");
      }
    } while (!validProjectName(projectName));
  } finally {
    prompt.close();
  }
}

if (!projectName || !validProjectName(projectName)) {
  console.error("Usage: create-vanilla-vite <lowercase-project-name>");
  if (!projectName && !stdin.isTTY) {
    console.error("Run this command in an interactive terminal to be prompted for a name.");
  }
  process.exit(1);
}

const packageManager =
  requestedPackageManager ??
  (process.env.npm_config_user_agent?.startsWith("pnpm/") ? "pnpm" : "npm");
const root = resolve(process.cwd(), projectName);
let rootCreated = false;
const clientFolder = `${projectName}-client`;
const serverFolder = `${projectName}-server`;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptRoot = fileURLToPath(new URL("../scripts/", import.meta.url));
const cliPackage = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const removeIncompleteProject = async () => {
  process.off("SIGINT", handleCreationSignal);
  process.off("SIGTERM", handleCreationSignal);
  if (!rootCreated) return;
  rootCreated = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY"].includes(error.code) || attempt === 5) {
        console.error(`Unable to remove the incomplete project directory: ${error.message}`);
        return;
      }
      await delay(100 * (attempt + 1));
    }
  }
};
const handleCreationSignal = async () => {
  if (creationCancelled) return;
  creationCancelled = true;
  const child = activeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveClose) => child.once("close", resolveClose)),
      delay(3000),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolveClose) => child.once("close", resolveClose));
    }
  }
  await removeIncompleteProject();
  process.exit(130);
};

function parseSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const component of ["major", "minor", "patch"]) {
    if (a[component] !== b[component]) {
      return a[component] < b[component] ? -1 : 1;
    }
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length
        ? -1
        : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined || rightId === undefined) {
      return leftId === rightId ? 0 : leftId === undefined ? -1 : 1;
    }
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftId) < BigInt(rightId) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

async function updateIfOutdated() {
  if (skipUpdateCheck) return;
  const { version: installedVersion } = cliPackage;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org")
    .replace(/\/$/, "");

  let latestVersion;
  try {
    const response = await fetch(`${registry}/create-vanilla-vite/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
    latestVersion = (await response.json()).version;
    if (typeof latestVersion !== "string") {
      throw new Error("registry response did not include a version");
    }
  } catch (error) {
    console.warn(`\nCould not check for CLI updates: ${error.message}`);
    return;
  }

  try {
    if (compareSemver(latestVersion, installedVersion) <= 0) return;
  } catch (error) {
    console.warn(`\nCould not compare CLI versions: ${error.message}`);
    return;
  }
  if (!stdin.isTTY) {
    console.warn(
      `\nA newer version of create-vanilla-vite is available (${latestVersion}; current: ${installedVersion}). Run ${packageManager} create vanilla-vite@latest to use it.`,
    );
    return;
  }

  console.warn(
    `\nA newer version of create-vanilla-vite is available (${latestVersion}; current: ${installedVersion}).`,
  );
  const useLatest = await selectOption("Which version would you like to use?", [
    { label: `Use the latest version (${latestVersion})`, value: true },
    { label: `Continue with the current version (${installedVersion})`, value: false },
  ]);
  if (!useLatest) return;

  const relaunchArgs = [
    ...args.filter((arg) => arg !== "--no-update-check"),
    ...(args.some((arg) => !arg.startsWith("--")) ? [] : [projectName]),
    "--no-update-check",
  ];
  const updateArgs =
    packageManager === "pnpm"
      ? ["dlx", "create-vanilla-vite@latest", ...relaunchArgs]
      : [
          "exec",
          "--yes",
          "--package=create-vanilla-vite@latest",
          "--",
          "create-vanilla-vite",
          ...relaunchArgs,
        ];
  try {
    await run(packageManager, updateArgs, process.cwd());
  } catch (error) {
    console.error(`Unable to start the latest CLI version: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

function run(command, commandArgs, cwd, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { cwd, stdio: "inherit", env });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = undefined;
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(`${command} exited ${signal ? `from ${signal}` : `with code ${code}`}`),
        );
      }
    });
  });
}

async function selectOption(question, options, defaultIndex = 0, color = "cyan") {
  if (!stdin.isTTY) return options[defaultIndex].value;
  let selected = defaultIndex;
  emitKeypressEvents(stdin);

  return new Promise((resolveSelection) => {
    function render() {
      const prompt = stdout.isTTY && process.env.NO_COLOR === undefined
        ? `\x1b[1;${color === "cyan" ? "36" : "33"}m${question}\x1b[0m`
        : question;
      stdout.write(`\r\x1b[2K${prompt}\n`);
      for (const [index, option] of options.entries()) {
        stdout.write(`  ${index === selected ? "❯" : " "} ${option.label}\n`);
      }
      stdout.write("  Use ↑/↓ to select, Enter to confirm, or Esc to keep the default.\n");
      stdout.write(`\x1b[${options.length + 2}A`);
    }

    function finish(value) {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`\x1b[${options.length + 2}B\n`);
      resolveSelection(value);
    }

    function onKeypress(_input, key) {
      if (key?.name === "up" || key?.name === "down") {
        selected =
          (selected + (key.name === "down" ? 1 : options.length - 1)) %
          options.length;
        render();
      } else if (key?.name === "return") finish(options[selected].value);
      else if (key?.name === "escape") {
        finish(options[defaultIndex].value);
      } else if (key?.ctrl && key.name === "c") {
        stdin.off("keypress", onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write(`\x1b[${options.length + 2}B\n`);
        void handleCreationSignal();
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

function chooseOption(question, options, defaultIndex = 0, color = "cyan") {
  return yes
    ? Promise.resolve(options[defaultIndex].value)
    : selectOption(question, options, defaultIndex, color);
}

async function configureTailwind(clientRoot) {
  let viteConfigName = (await readdir(clientRoot)).find((file) =>
    /^vite\.config\.(?:[cm]?[jt]s)$/.test(file),
  );
  if (!viteConfigName) {
    const isTypeScript = (await readdir(clientRoot)).includes("tsconfig.json");
    viteConfigName = `vite.config.${isTypeScript ? "ts" : "js"}`;
    await writeFile(
      join(clientRoot, viteConfigName),
      'import { defineConfig } from "vite";\n' +
        'import tailwindcss from "@tailwindcss/vite";\n\n' +
        "export default defineConfig({\n" +
        "  plugins: [tailwindcss()],\n" +
        "});\n",
    );
  }

  const viteConfigPath = join(clientRoot, viteConfigName);
  let viteConfig = await readFile(viteConfigPath, "utf8");
  if (!viteConfig.includes("@tailwindcss/vite")) {
    viteConfig = `import tailwindcss from "@tailwindcss/vite";\n${viteConfig}`;
    const plugins = /(\bplugins\s*:\s*\[)/;
    if (plugins.test(viteConfig)) {
      viteConfig = viteConfig.replace(plugins, "$1tailwindcss(), ");
    } else {
      const configObject = /(\bdefineConfig\s*\(\s*\{)/;
      if (!configObject.test(viteConfig)) {
        throw new Error("Could not add Tailwind CSS to the Vite config.");
      }
      viteConfig = viteConfig.replace(configObject, "$1\n  plugins: [tailwindcss()],");
    }
  }
  await writeFile(viteConfigPath, viteConfig);

  let entryPath;
  for (const directory of [join(clientRoot, "src"), clientRoot]) {
    let files;
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const entryFile = files.find((file) => /^main\.[cm]?[jt]sx?$/.test(file));
    if (entryFile) {
      entryPath = join(directory, entryFile);
      break;
    }
  }
  if (!entryPath) {
    throw new Error("Could not find the frontend entry file to configure Tailwind CSS.");
  }
  const entry = await readFile(entryPath, "utf8");
  let cssImport = entry.match(/import\s+["']([^"']+\.css)["']/);
  if (!cssImport) {
    const cssPath = join(dirname(entryPath), "style.css");
    await writeFile(cssPath, '@import "tailwindcss";\n');
    await writeFile(entryPath, `import "./style.css";\n${entry}`);
    cssImport = ['import "./style.css";', "./style.css"];
  }
  const cssPath = resolve(dirname(entryPath), cssImport[1]);
  const css = await readFile(cssPath, "utf8");
  if (!css.includes('@import "tailwindcss";')) {
    await writeFile(cssPath, `@import "tailwindcss";\n${css}`);
  }
}

async function configureStrictPort(clientRoot) {
  let configName = (await readdir(clientRoot)).find((file) =>
    /^vite\.config\.(?:[cm]?[jt]s)$/.test(file),
  );
  if (!configName) {
    const isTypeScript = (await readdir(clientRoot)).includes("tsconfig.json");
    configName = `vite.config.${isTypeScript ? "ts" : "js"}`;
    await writeFile(
      join(clientRoot, configName),
      'import { defineConfig } from "vite";\n\nexport default defineConfig({});\n',
    );
  }

  const configPath = join(clientRoot, configName);
  let config = await readFile(configPath, "utf8");
  if (/\bstrictPort\s*:/.test(config)) {
    config = config.replace(/\bstrictPort\s*:\s*(?:true|false)/, "strictPort: true");
  } else if (/\bserver\s*:\s*\{/.test(config)) {
    config = config.replace(/\bserver\s*:\s*\{/, "server: { strictPort: true,");
  } else {
    const configObject = /(\bdefineConfig\s*\(\s*\{|\bexport\s+default\s*\{)/;
    if (!configObject.test(config)) {
      console.warn(
        `Could not configure strictPort in ${configName}; the Vite config shape was not recognized.`,
      );
      return;
    }
    config = config.replace(configObject, "$1\n  server: { strictPort: true },");
  }
  await writeFile(configPath, config);
}

async function scaffoldReactRouter(clientRoot, useTailwind) {
  const sourceRoot = join(clientRoot, "src");
  const sourceFiles = await readdir(sourceRoot);
  const appFile = sourceFiles.find((file) => /^App\.(?:jsx|tsx)$/.test(file));
  const entryFile = sourceFiles.find((file) => /^main\.(?:jsx|tsx)$/.test(file));
  if (!appFile || !entryFile) {
    throw new Error("Could not find the React app and entry files to configure routing.");
  }

  const typed = appFile.endsWith(".tsx");
  const extension = typed ? "tsx" : "jsx";
  const appPath = join(sourceRoot, appFile);
  const entryPath = join(sourceRoot, entryFile);
  const entry = await readFile(entryPath, "utf8");
  const cssImport = entry.match(/import\s+["']([^"']+\.css)["']/);
  if (!cssImport) {
    throw new Error("Could not find a CSS import for the React Router starter.");
  }

  const cssPath = resolve(sourceRoot, cssImport[1]);
  const tailwindImport = (await readFile(cssPath, "utf8"))
    .includes('@import "tailwindcss";')
    ? '@import "tailwindcss";\n'
    : "";
  const styles = useTailwind
    ? {
        shell: "min-h-screen flex flex-col bg-[#f5f7f4] text-[#17231f]",
        container: "w-[calc(100%_-_2rem)] sm:w-[calc(100%_-_3rem)] max-w-[1040px] mx-auto",
        header: "min-h-[72px] sm:min-h-[84px] flex items-center justify-between border-b border-[#dfe6df]",
        brand: "flex items-center gap-[10px] text-sm font-bold text-[#17231f] no-underline",
        brandMark: "w-[30px] h-[30px] grid place-items-center rounded-[9px] bg-[#315d4a] text-white",
        nav: "flex items-center gap-2",
        navLink: "min-h-10 flex items-center px-[10px] sm:px-[14px] rounded-lg text-sm text-[#5b6861] no-underline hover:bg-[#e7eee8] hover:text-[#244b39]",
        navActive: "bg-[#e7eee8] text-[#244b39]",
        page: "flex-1",
        footer: "py-6 border-t border-[#dfe6df] text-[13px] text-[#78857d]",
        home: "py-[72px] sm:pt-[clamp(72px,12vw,132px)] sm:pb-[84px]",
        eyebrow: "text-xs font-bold tracking-[0.12em] text-[#557663]",
        title: "max-w-[680px] my-[18px] text-[clamp(40px,7vw,68px)] font-semibold leading-[1.05] tracking-[-0.055em]",
        authTitle: "max-w-[680px] my-[18px] text-[clamp(38px,7vw,52px)] font-semibold leading-[1.05] tracking-[-0.055em]",
        copy: "max-w-[550px] mb-7 text-[17px] leading-[1.7] text-[#627068]",
        button: "min-h-[46px] inline-flex items-center justify-center gap-[14px] px-[18px] rounded-lg font-semibold no-underline cursor-pointer",
        buttonPrimary: "bg-[#315d4a] text-white hover:bg-[#244b39]",
        grid: "grid grid-cols-1 sm:grid-cols-2 gap-4 mt-14 sm:mt-[72px]",
        card: "min-h-[164px] p-6 border border-[#dfe6df] rounded-xl bg-[#fbfcfa]",
        cardIndex: "text-xs font-bold tracking-[0.12em] text-[#557663]",
        cardTitle: "mt-4 mb-2 text-lg",
        cardCopy: "m-0 leading-[1.6] text-[#627068]",
        code: "text-[#315d4a]",
        auth: "w-full max-w-[440px] mx-auto py-[88px] pb-[72px]",
        authIntro: "",
        authCopy: "max-w-[550px] mb-8 text-[17px] leading-[1.7] text-[#627068]",
        form: "grid gap-[10px]",
        label: "mt-2 text-sm font-semibold text-[#35443c]",
        input: "w-full min-h-[46px] px-[13px] border border-[#ccd7ce] rounded-lg bg-white text-[#17231f] focus:border-[#557663] focus:outline-3 focus:outline-[#dce8df]",
        formButton: "mt-3",
        notice: "min-h-6 m-0 text-sm leading-[1.5] text-[#557663]",
        back: "inline-block mt-[18px] text-sm text-[#486353] hover:underline",
      }
    : {
        shell: "app-shell",
        container: "layout-container",
        header: "site-header",
        brand: "brand",
        brandMark: "brand-mark",
        nav: "site-nav",
        navLink: "nav-link",
        navActive: "is-active",
        page: "page-content",
        footer: "site-footer",
        home: "home-page",
        eyebrow: "eyebrow",
        title: "",
        authTitle: "",
        copy: "hero-copy",
        button: "button",
        buttonPrimary: "button-primary",
        grid: "route-grid",
        card: "route-card",
        cardIndex: "card-index",
        cardTitle: "",
        cardCopy: "",
        code: "",
        auth: "auth-page",
        authIntro: "auth-intro",
        authCopy: "hero-copy",
        form: "login-form",
        label: "",
        input: "",
        formButton: "",
        notice: "form-notice",
        back: "back-link",
      };
  const appCssImport = useTailwind ? "" : 'import "./App.css";\n';
  const homeDirectory = join(sourceRoot, "Pages", "Home");
  const authDirectory = join(sourceRoot, "Pages", "Auth");
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(authDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(sourceRoot, `MainRouter.${extension}`),
      `import { createBrowserRouter } from "react-router";
import App from "./App";
import Home from "./Pages/Home/Home";
import AuthPage from "./Pages/Auth/AuthPage";

const MainRouter = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: "login", element: <AuthPage /> },
    ],
  },
]);

// eslint-disable-next-line react-refresh/only-export-components
export default MainRouter;
`,
    ),
    writeFile(
      appPath,
      `import { NavLink, Outlet } from "react-router";
${appCssImport}

function App() {
  return (
    <div className="${styles.shell}">
      <header className="${styles.container} ${styles.header}">
        <NavLink className="${styles.brand}" to="/" end>
          <span className="${styles.brandMark}" aria-hidden="true">V</span>
          <span>Workspace starter</span>
        </NavLink>
        <nav className="${styles.nav}" aria-label="Main navigation">
          <NavLink to="/" end className={({ isActive }) => isActive ? "${styles.navLink} ${styles.navActive}" : "${styles.navLink}"}>
            Home
          </NavLink>
          <NavLink to="/login" className={({ isActive }) => isActive ? "${styles.navLink} ${styles.navActive}" : "${styles.navLink}"}>
            Login
          </NavLink>
        </nav>
      </header>
      <main className="${styles.container} ${styles.page}">
        <Outlet />
      </main>
      <footer className="${styles.container} ${styles.footer}">A small starting point for your next project.</footer>
    </div>
  );
}

export default App;
`,
    ),
    writeFile(
      join(homeDirectory, `Home.${extension}`),
      `import { Link } from "react-router";

function Home() {
  return (
    <section className="${styles.home}">
      <p className="${styles.eyebrow}">YOUR PROJECT STARTS HERE</p>
      <h1 className="${styles.title}">A faster start for your next project.</h1>
      <p className="${styles.copy}">
        This starter makes setting up your development environment quick and
        straightforward. React Router is ready with Home and Login pages so you
        can test navigation right away.
      </p>
      <Link className="${styles.button} ${styles.buttonPrimary}" to="/login">Visit the login page <span aria-hidden="true">→</span></Link>
      <div className="${styles.grid}">
        <article className="${styles.card}">
          <span className="${styles.cardIndex}">01</span>
          <h2 className="${styles.cardTitle}">Home</h2>
          <p className="${styles.cardCopy}">An example landing page at <code className="${styles.code}">/</code> to help you get started.</p>
        </article>
        <article className="${styles.card}">
          <span className="${styles.cardIndex}">02</span>
          <h2 className="${styles.cardTitle}">Login</h2>
          <p className="${styles.cardCopy}">A sample page at <code className="${styles.code}">/login</code> for checking route navigation.</p>
        </article>
      </div>
    </section>
  );
}

export default Home;
`,
    ),
    writeFile(
      join(authDirectory, `AuthPage.${extension}`),
      `import { useState${typed ? ", type FormEvent" : ""} } from "react";
import { Link } from "react-router";

function AuthPage() {
  const [notice, setNotice] = useState("");

  function handleSubmit(event${typed ? ": FormEvent<HTMLFormElement>" : ""}) {
    event.preventDefault();
    setNotice("This starter form is ready to connect to your authentication service.");
  }

  return (
    <section className="${styles.auth}">
      <div className="${styles.authIntro}">
        <p className="${styles.eyebrow}">WELCOME BACK</p>
        <h1 className="${styles.authTitle}">Login</h1>
        <p className="${styles.authCopy}">Sign in to continue to your workspace.</p>
      </div>
      <form className="${styles.form}" onSubmit={handleSubmit}>
        <label className="${styles.label}" htmlFor="email">Email address</label>
        <input className="${styles.input}" id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
        <label className="${styles.label}" htmlFor="password">Password</label>
        <input className="${styles.input}" id="password" name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required />
        <button className="${styles.button} ${styles.buttonPrimary} ${styles.formButton}" type="submit">Continue</button>
        <p className="${styles.notice}" role="status">{notice}</p>
      </form>
      <Link className="${styles.back}" to="/">← Back to home</Link>
    </section>
  );
}

export default AuthPage;
`,
    ),
    writeFile(
      cssPath,
      useTailwind
        ? tailwindImport
        : `${tailwindImport}:root {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #17231f;
  background: #f5f7f4;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
}

button,
input {
  font: inherit;
}

a {
  color: inherit;
}
`,
    ),
    ...(!useTailwind
      ? [
          writeFile(
            join(sourceRoot, "App.css"),
            `.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.layout-container,
.site-header,
.page-content,
.site-footer {
  width: min(100% - 48px, 1040px);
  margin-inline: auto;
}

.site-header {
  min-height: 84px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #dfe6df;
}

.brand,
.site-nav,
.nav-link {
  display: flex;
  align-items: center;
}

.brand {
  gap: 10px;
  color: #17231f;
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
}

.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: #315d4a;
  color: #fff;
}

.site-nav {
  gap: 8px;
}

.nav-link {
  min-height: 40px;
  padding: 0 14px;
  border-radius: 8px;
  color: #5b6861;
  font-size: 14px;
  text-decoration: none;
}

.nav-link:hover,
.nav-link.is-active {
  background: #e7eee8;
  color: #244b39;
}

.page-content {
  flex: 1;
}

.home-page {
  padding: clamp(72px, 12vw, 132px) 0 84px;
}

.eyebrow,
.card-index {
  color: #557663;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.home-page h1,
.auth-intro h1 {
  max-width: 680px;
  margin: 18px 0;
  font-size: clamp(40px, 7vw, 68px);
  font-weight: 600;
  letter-spacing: -0.055em;
  line-height: 1.05;
}

.hero-copy {
  max-width: 550px;
  margin: 0 0 28px;
  color: #627068;
  font-size: 17px;
  line-height: 1.7;
}

.button {
  min-height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0 18px;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  text-decoration: none;
}

.button-primary {
  background: #315d4a;
  color: white;
}

.button-primary:hover {
  background: #244b39;
}

.route-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 72px;
}

.route-card {
  min-height: 164px;
  padding: 24px;
  border: 1px solid #dfe6df;
  border-radius: 12px;
  background: #fbfcfa;
}

.route-card h2 {
  margin: 16px 0 8px;
  font-size: 18px;
}

.route-card p {
  margin: 0;
  color: #627068;
  line-height: 1.6;
}

.route-card code {
  color: #315d4a;
}

.auth-page {
  width: min(100%, 440px);
  margin: 0 auto;
  padding: 88px 0 72px;
}

.auth-intro h1 {
  font-size: clamp(38px, 7vw, 52px);
}

.auth-intro .hero-copy {
  margin-bottom: 32px;
}

.login-form {
  display: grid;
  gap: 10px;
}

.login-form label {
  margin-top: 8px;
  color: #35443c;
  font-size: 14px;
  font-weight: 600;
}

.login-form input {
  width: 100%;
  min-height: 46px;
  padding: 0 13px;
  border: 1px solid #ccd7ce;
  border-radius: 8px;
  background: #fff;
  color: #17231f;
}

.login-form input:focus {
  border-color: #557663;
  outline: 3px solid #dce8df;
}

.login-form .button {
  margin-top: 12px;
}

.form-notice {
  min-height: 24px;
  margin: 2px 0 0;
  color: #557663;
  font-size: 14px;
  line-height: 1.5;
}

.back-link {
  display: inline-block;
  margin-top: 18px;
  color: #486353;
  font-size: 14px;
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.site-footer {
  padding: 24px 0;
  border-top: 1px solid #dfe6df;
  color: #78857d;
  font-size: 13px;
}

@media (max-width: 560px) {
  .site-header,
  .page-content,
  .site-footer {
    width: min(100% - 32px, 1040px);
  }

  .site-header {
    min-height: 72px;
  }

  .nav-link {
    padding: 0 10px;
  }

  .route-grid {
    grid-template-columns: 1fr;
    margin-top: 56px;
  }
}
`,
          ),
        ]
      : []),
    writeFile(
      entryPath,
      `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import MainRouter from "./MainRouter";
${cssImport[0]};

createRoot(document.getElementById("root")${typed ? "!" : ""}).render(
  <StrictMode>
    <RouterProvider router={MainRouter} />
  </StrictMode>,
);
`,
    ),
  ]);

  return true;
}

async function scaffoldBackendStatus(clientRoot) {
  const indexPath = join(clientRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  if (!/<\/body\s*>/i.test(html)) {
    throw new Error("Could not find the closing body tag for the backend status control.");
  }
  await writeFile(
    indexPath,
    html.replace(
      /<\/body\s*>/i,
      '  <script type="module" src="/backend-status.js"></script>\n</body>',
    ),
  );
  await writeFile(
    join(clientRoot, "backend-status.js"),
    `if (import.meta.env.DEV) {
  import("./backend-status.css");
  const apiUrl = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\\/+$/, "");
  const panel = document.createElement("aside");
  panel.className = "backend-status";
  panel.setAttribute("aria-label", "Backend connection");
  panel.innerHTML = \`
    <span class="backend-status__dot" aria-hidden="true"></span>
    <div class="backend-status__content">
      <strong class="backend-status__title">Backend</strong>
      <span class="backend-status__message" role="status" aria-live="polite">Not checked yet</span>
    </div>
    <button class="backend-status__button" type="button">Check connection</button>
  \`;

  const message = panel.querySelector(".backend-status__message");
  const button = panel.querySelector(".backend-status__button");
  button.addEventListener("click", async () => {
    button.disabled = true;
    panel.dataset.state = "checking";
    message.textContent = "Checking…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(\`\${apiUrl}/api/health\`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.status !== "ok") {
        throw new Error("Backend health check returned an unexpected response.");
      }
      panel.dataset.state = "connected";
      message.textContent = "Connected";
    } catch {
      panel.dataset.state = "disconnected";
      message.textContent = "Unavailable — check the server and network";
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
    }
  });

  document.body.append(panel);
}
`,
  );
  await writeFile(
    join(clientRoot, "backend-status.css"),
    `.backend-status {
  position: fixed;
  z-index: 1000;
  right: 18px;
  bottom: 18px;
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: min(390px, calc(100vw - 36px));
  padding: 14px;
  border: 1px solid #dfe6df;
  border-radius: 12px;
  background: #fbfcfa;
  color: #17231f;
  box-shadow: 0 8px 28px rgb(23 35 31 / 12%);
  font: 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
}

.backend-status__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #9aa59e;
}

.backend-status[data-state="checking"] .backend-status__dot {
  background: #c28a30;
}

.backend-status[data-state="connected"] .backend-status__dot {
  background: #31835b;
}

.backend-status[data-state="disconnected"] .backend-status__dot {
  background: #bd4d43;
}

.backend-status__content {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.backend-status__title {
  font-size: 13px;
}

.backend-status__message {
  color: #627068;
  font-size: 12px;
}

.backend-status__button {
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: #315d4a;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.backend-status__button:hover:not(:disabled) {
  background: #244b39;
}

.backend-status__button:focus-visible {
  outline: 3px solid #9db9a5;
  outline-offset: 2px;
}

.backend-status__button:disabled {
  cursor: wait;
  opacity: 0.7;
}

@media (max-width: 420px) {
  .backend-status {
    right: 12px;
    bottom: 12px;
    width: calc(100vw - 24px);
  }
}
`,
  );
}

async function configureFrontend(clientRoot, clientPackage) {
  const tailwind = noTailwind
    ? false
    : hasOption("tailwind")
      ? true
      : await chooseOption("Would you like to install Tailwind CSS?", [
          { label: "Yes — add Tailwind CSS v4", value: true },
          { label: "No", value: false },
        ]);
  const axios = hasOption("axios")
    ? true
    : noAxios
      ? false
      : await chooseOption("Would you like to install Axios?", [
          { label: "Yes — add Axios", value: true },
          { label: "No", value: false },
        ]);
  const isReact = Boolean(
    clientPackage.dependencies?.react || clientPackage.devDependencies?.react,
  );
  const installRouter =
    isReact &&
    (hasOption("router")
      ? true
      : hasOption("no-router")
        ? false
        : await chooseOption("Would you like to install React Router?", [
            { label: "Yes — add Home and Login pages with navigation", value: true },
            { label: "No", value: false },
          ]));
  const iconPackages = {
    "react-icons": ["react-icons", "^5.7.0"],
    animateicons: ["@animateicons/react", "^0.13.0"],
  };
  const icons =
    !isReact || iconsOption === "none"
      ? null
      : iconsOption
        ? iconPackages[iconsOption]
        : (await chooseOption("Would you like to install an icon library?", [
              { label: "Yes", value: true },
              { label: "No", value: false },
            ]))
          ? await chooseOption("Which React icon library would you like to install?", [
              { label: "React Icons (default)", value: iconPackages["react-icons"] },
              { label: "@animateicons/react", value: iconPackages.animateicons },
            ])
          : null;

  if (tailwind) {
    clientPackage.devDependencies ??= {};
    clientPackage.devDependencies["@tailwindcss/vite"] = "^4.3.5";
    clientPackage.devDependencies.tailwindcss = "^4.3.5";
    await configureTailwind(clientRoot);
  }
  if (axios) {
    clientPackage.dependencies ??= {};
    clientPackage.dependencies.axios = "^1.21.1";
  }
  if (icons) {
    clientPackage.dependencies ??= {};
    clientPackage.dependencies[icons[0]] = icons[1];
  }
  if (installRouter) {
    clientPackage.dependencies ??= {};
    clientPackage.dependencies["react-router"] = "^7";
    await scaffoldReactRouter(clientRoot, tailwind);
  }
  await configureStrictPort(clientRoot);
}

async function copyScript(name) {
  const source = await readFile(join(scriptRoot, name), "utf8");
  await writeFile(join(root, "scripts", name), source);
}

function expressErrorHandlerParameters(language) {
  return language === "ts"
    ? `error: unknown,
    _request: import("express").Request,
    response: import("express").Response,
    _next: import("express").NextFunction`
    : "error, _request, response, _next";
}

function backendFiles(language, framework) {
  const extension = language;
  const typeAnnotation = language === "ts" ? ": number" : "";
  const app = framework === "express"
    ? `import cors from "cors";
import express from "express";

export function createApp() {
  const app = express();
  const origins = (process.env.CORS_ORIGIN ?? "*")
    .split(",")
    .map((origin) => origin.trim());
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !origins.includes("*") && origins.includes(origin)) {
      response.vary("Origin");
    }
    next();
  });
  app.use(cors({ origin: origins.includes("*") ? "*" : origins }));
  app.use(express.json());
  app.get("/", (_request, response) => response.json({ message: "Backend is running" }));
  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.use((${expressErrorHandlerParameters(language)}) => {
    console.error(error);
    response.status(500).json({ error: "Internal Server Error" });
  });
  return app;
}
`
      : `import { createServer } from "node:http";
import { handleRequest } from "./basicHandler.${extension}";

export function createApp() {
  return createServer(handleRequest);
}
`;
  const basicHandler =
    framework === "basic"
      ? `export function handleRequest(
  request${language === "ts" ? ": import('node:http').IncomingMessage" : ""},
  response${language === "ts" ? ": import('node:http').ServerResponse" : ""},
) {
  const origins = (process.env.CORS_ORIGIN ?? "*")
    .split(",")
    .map((origin) => origin.trim());
  const requestOrigin = request.headers.origin;
  const allowedOrigin = origins.includes("*")
    ? "*"
    : typeof requestOrigin === "string" && origins.includes(requestOrigin)
      ? requestOrigin
      : undefined;
  const corsHeaders = {
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin } : {}),
    ...(allowedOrigin && allowedOrigin !== "*" ? { vary: "Origin" } : {}),
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const payload =
      request.method === "GET" && path === "/"
        ? { status: 200, body: { message: "Backend is running" } }
        : request.method === "GET" && path === "/api/health"
          ? { status: 200, body: { status: "ok" } }
          : { status: 404, body: { message: "Not Found" } };

    response.writeHead(payload.status, {
      ...corsHeaders,
      "content-type": "application/json",
    });
    response.end(JSON.stringify(payload.body));
  } catch (error) {
    console.error(error);
    response.writeHead(500, {
      ...corsHeaders,
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}
`
      : null;
  const server = `import "dotenv/config";
import { createApp } from "./app.${extension}";

const port${typeAnnotation} = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "localhost";
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(\`Backend listening at http://\${host}:\${port}\`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error("Unable to close the backend server:", error);
        process.exitCode = 1;
      }
    });
  });
}
`;
  return { app, server, basicHandler };
}

async function createBackend(serverRoot) {
  const language =
    languageOption ??
    (await chooseOption("Select a language for the backend:", [
      { label: "JavaScript", value: "js" },
      { label: "TypeScript", value: "ts" },
    ], 0, "yellow"));
  const framework =
    backendOption && backendOption !== "none"
      ? backendOption
      : await chooseOption("Select a backend framework:", [
          { label: "Basic Node.js — no additional framework", value: "basic" },
          { label: "Express — install Express, CORS, and dotenv (default)", value: "express" },
        ], 1, "yellow");
  const structure = structureOption
    ? structureOption
    : useDefaultStructure
      ? "simple"
      : await chooseOption("Select a backend folder structure:", [
          { label: "Simple — standard folders", value: "simple" },
          { label: "Module-based — organized by feature (default)", value: "module" },
        ], 1, "yellow");
  const typed = language === "ts";
  let { app, server, basicHandler } = backendFiles(language, framework);
  const sourceRoot = join(serverRoot, "src");
  const folders =
    structure === "simple"
      ? ["routes", "controllers", "middleware", "config"]
      : ["module", "config", "middleware", "utils"];
  for (const folder of folders) {
    const folderPath = join(sourceRoot, folder);
    await mkdir(folderPath, { recursive: true });
    await writeFile(join(folderPath, ".gitkeep"), "");
  }
  if (structure === "module") {
    const router =
      framework === "express"
        ? `import { Router } from "express";

export const mainRouter = Router();
mainRouter.get("/", (_request, response) => {
  response.json({ message: "Backend is running" });
});
mainRouter.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});
`
        : `export { handleRequest } from "./basicHandler.${language}";
`;
    await writeFile(join(sourceRoot, `mainRouter.${language}`), router);
    app =
      framework === "express"
        ? `import cors from "cors";
import express from "express";
import { mainRouter } from "./mainRouter.${language}";

export function createApp() {
  const app = express();
  const origins = (process.env.CORS_ORIGIN ?? "*")
    .split(",")
    .map((origin) => origin.trim());
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !origins.includes("*") && origins.includes(origin)) {
      response.vary("Origin");
    }
    next();
  });
  app.use(cors({ origin: origins.includes("*") ? "*" : origins }));
  app.use(express.json());
  app.use(mainRouter);
  app.use((_request, response) => {
    response.status(404).json({ error: "Not Found" });
  });
  app.use((${expressErrorHandlerParameters(language)}) => {
    console.error(error);
    response.status(500).json({ error: "Internal Server Error" });
  });
  return app;
}
`
        : `import { createServer } from "node:http";
import { handleRequest } from "./mainRouter.${language}";

export function createApp() {
  return createServer(handleRequest);
}
`;
  }
  if (basicHandler) {
    await writeFile(join(sourceRoot, `basicHandler.${language}`), basicHandler);
  }
  await writeFile(join(sourceRoot, `app.${language}`), app);
  await writeFile(join(sourceRoot, `server.${language}`), server);

  const scripts = typed
    ? framework === "basic"
      ? {
          dev: `tsx watch src/server.${language}`,
          start: `tsx src/server.${language}`,
        }
      : { dev: `tsx watch src/server.${language}`, start: `tsx src/server.${language}` }
    : framework === "basic"
      ? {
          dev: `node --watch src/server.${language}`,
          start: `node src/server.${language}`,
        }
      : { dev: `node --watch src/server.${language}`, start: `node src/server.${language}` };
  const dependencies =
    framework === "express"
      ? { express: "^5", cors: "^2.8.5", dotenv: "^16" }
      : { dotenv: "^16" };
  const packageJson = {
    name: serverFolder,
    version: "1.0.0",
    private: true,
    type: "module",
    scripts,
    ...(typed
      ? {
          dependencies: { ...dependencies, tsx: "^4" },
          devDependencies: {
            ...(framework === "express"
              ? { "@types/cors": "^2.8.19", "@types/express": "^5" }
              : {}),
            "@types/node": "^22",
            typescript: "^5",
          },
        }
      : Object.keys(dependencies).length
        ? { dependencies }
        : {}),
  };
  await writeFile(join(serverRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  if (typed) {
    await writeFile(
      join(serverRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeFile(
    join(serverRoot, ".env"),
    "# Local backend environment variables\nPORT=4000\nHOST=localhost\nCORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173\n",
    { flag: "wx" },
  );
  await writeFile(
    join(serverRoot, ".env.example"),
    "# Backend environment variables\nPORT=4000\nHOST=localhost\nCORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173\n",
  );
}

await updateIfOutdated();

try {
  await mkdir(root);
  rootCreated = true;
  process.on("SIGINT", handleCreationSignal);
  process.on("SIGTERM", handleCreationSignal);
} catch (error) {
  if (error.code === "EEXIST") console.error(`The destination already exists: ${root}`);
  else console.error(`Unable to create project directory: ${error.message}`);
  process.exit(1);
}

let installFailed = false;
try {
  console.log(`\nCreating the frontend in ${clientFolder} with create-vite...\n`);
  const viteArgs =
    packageManager === "pnpm"
      ? [
          "create",
          "vite@latest",
          clientFolder,
          "--no-immediate",
          ...(templateOption ? ["--template", templateOption] : []),
        ]
      : [
          "create",
          "vite@latest",
          "--",
          clientFolder,
          "--no-immediate",
          ...(templateOption ? ["--template", templateOption] : []),
        ];
  await run(packageManager, viteArgs, root);

  const clientRoot = join(root, clientFolder);
  await Promise.all(
    [".git", "node_modules", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].map(
      (entry) => rm(join(clientRoot, entry), { recursive: true, force: true }),
    ),
  );
  const clientPackagePath = join(clientRoot, "package.json");
  const clientPackage = JSON.parse(await readFile(clientPackagePath, "utf8"));
  clientPackage.scripts ??= {};
  clientPackage.scripts.start ??= clientPackage.scripts.dev;
  await configureFrontend(clientRoot, clientPackage);
  await writeFile(clientPackagePath, `${JSON.stringify(clientPackage, null, 2)}\n`);
  await writeFile(
    join(clientRoot, ".env.local"),
    "# Local frontend environment variables\nVITE_API_URL=http://localhost:4000\n",
    { flag: "wx" },
  );
  await writeFile(
    join(clientRoot, ".env.example"),
    "# Frontend environment variables\nVITE_API_URL=http://localhost:4000\n",
  );

  const includeServer =
    backendOption !== undefined
      ? backendOption !== "none"
      : await chooseOption(
          "Would you like to add a separate backend server?",
          [
            { label: "Yes — include a backend workspace", value: true },
            { label: "No — create a frontend-only project", value: false },
          ],
          0,
          "yellow",
        );
  const workspaces = [clientFolder];
  if (includeServer) {
    await scaffoldBackendStatus(clientRoot);
    await createBackend(join(root, serverFolder));
    workspaces.push(serverFolder);
  }

  await mkdir(join(root, "scripts"), { recursive: true });
  await Promise.all(
    ["dev.mjs", "run-app.mjs", "install-info.mjs", "add-dependency.mjs"].map(copyScript),
  );
  const rootPackage = {
    name: projectName,
    version: "1.0.0",
    private: true,
    engines: { node: ">=20.6" },
    workspaces,
    scripts: {
      preinstall: "node scripts/install-info.mjs",
      postinstall: "node scripts/install-info.mjs --complete",
      dev: `node scripts/dev.mjs${exposeClient ? " --host" : ""}`,
      build:
        packageManager === "pnpm"
          ? "pnpm -r --if-present run build"
          : "npm run build --workspaces --if-present",
      lint:
        packageManager === "pnpm"
          ? "pnpm -r --if-present run lint"
          : "npm run lint --workspaces --if-present",
      client: "node scripts/run-app.mjs client",
      adD: "node scripts/add-dependency.mjs",
      "add-dependency": "node scripts/add-dependency.mjs",
      ...(includeServer ? { server: "node scripts/run-app.mjs server" } : {}),
    },
    type: "module",
    dependencies: {
      "cross-spawn": cliPackage.dependencies["cross-spawn"],
    },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(rootPackage, null, 2)}\n`);
  if (packageManager === "pnpm") {
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        ...workspaces.map((workspace) => `  - ${workspace}`),
        "",
        "onlyBuiltDependencies: [esbuild]",
        "",
        "allowBuilds:",
        "  esbuild: true",
        "  sharp: false",
        "  unrs-resolver: false",
        "",
      ].join("\n"),
    );
  }
  await writeFile(
    join(root, ".gitignore"),
    [
      "# Dependencies",
      "node_modules/",
      "",
      "# Build output",
      "**/dist/",
      "**/coverage/",
      "",
      "# Local environment files",
      "**/.env*",
      "!**/.env.example",
      "",
      "# Logs",
      "npm-debug.log*",
      "pnpm-debug.log*",
      "yarn-debug.log*",
      ".dev.log",
      ".dev.lock",
      ".install-state",
      "",
    ].join("\n"),
  );

  console.log(`\nInstalling dependencies for ${workspaces.join(" and ")}...`);
  try {
    await run(packageManager, ["install"], root, {
      ...process.env,
      VANILLA_VITE_ALLOW_INSTALL: "1",
    });
  } catch (error) {
    installFailed = true;
    await rm(join(root, ".install-state"), { force: true });
    console.error(
      `Dependency installation failed: ${error.message}\nRetry with:\n  cd "${projectName}" && ${packageManager} install`,
    );
  }
  rootCreated = false;
  process.off("SIGINT", handleCreationSignal);
  process.off("SIGTERM", handleCreationSignal);
  if (!hasOption("no-git")) {
    const repositoryCheck = spawnSync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (repositoryCheck.status === 0 && repositoryCheck.stdout.trim() === "true") {
      console.log("Skipping Git initialization because this project is already inside a Git work tree.");
    } else {
      const initializeGit = await chooseOption(
        "Would you like to initialize Git and create an initial commit?",
        [
          { label: "Yes — initialize Git and commit the project", value: true },
          { label: "No", value: false },
        ],
        0,
      );
      if (initializeGit) {
        try {
          await run("git", ["init"], root);
          await run("git", ["add", "-A"], root);
          await run("git", ["commit", "-m", "Initial commit"], root);
        } catch (error) {
          console.error(`Unable to create the initial Git commit: ${error.message}`);
        }
      }
    }
  }
  console.log(
    `\nProject created successfully: ${projectName}/\n${
      installFailed
        ? "Install dependencies with the retry command above.\n"
        : noStart
          ? "Skipping the development server.\n"
          : "Starting the development server...\n"
    }`,
  );
} catch (error) {
  if (!creationCancelled) {
    await removeIncompleteProject();
    console.error(`\nProject creation failed: ${error.message}`);
    process.exit(1);
  }
}

if (!creationCancelled && !noStart && !installFailed) {
  try {
    await run(
      packageManager,
      packageManager === "pnpm" ? ["dev"] : ["run", "dev"],
      root,
    );
  } catch (error) {
    console.error(
      `\nProject created successfully, but the development server could not be started: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
