import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import spawn from "cross-spawn";

const cliPath = fileURLToPath(new URL("../bin/create-template.mjs", import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), "create-vanilla-vite-smoke-"));
const preloadPath = join(tempRoot, "mock-tty.mjs");
const guardPackagePath = join(tempRoot, "smoke-guard-package");
const keepSmokeFiles = process.env.SMOKE_KEEP === "1";
const smokeFilter = process.env.SMOKE_FILTER;

await mkdir(guardPackagePath);
await writeFile(
  join(guardPackagePath, "package.json"),
  JSON.stringify({ name: "smoke-guard-package", version: "1.0.0" }),
);

await writeFile(
  preloadPath,
  `import { stdin } from "node:process";
if (process.argv[1]?.replaceAll("\\\\", "/").includes("scripts/add-dependency.mjs")) {
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
  stdin.setRawMode = () => stdin;
  const on = stdin.on.bind(stdin);
  stdin.on = (event, listener) => {
    const result = on(event, listener);
    if (event === "keypress") {
      setImmediate(() => listener("", { name: process.env.SMOKE_ADD_KEY ?? "return" }));
    }
    return result;
  };
}
`,
);

function run(command, args, cwd, env = process.env, timeout = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out.\n${output}`));
    }, timeout);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        if (output.length > 100_000) output = output.slice(-100_000);
      });
    }
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
}

async function verifyDevRunner(projectRoot, packageManager) {
  const [port, clientPort] = await findFreePorts(2);
  const projectName = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).name;
  const clientRoot = join(projectRoot, `${projectName}-client`);
  const clientEnvPath = join(clientRoot, ".env.local");
  const serverEnvPath = join(projectRoot, `${projectName}-server`, ".env");
  const serverEnvExamplePath = join(projectRoot, `${projectName}-server`, ".env.example");
  const viteConfig = (await readdir(clientRoot)).find((file) =>
    /^vite\.config\.(?:[cm]?[jt]s)$/.test(file),
  );
  assert(viteConfig, "Dev runner smoke project does not have a Vite config.");
  const viteConfigPath = join(clientRoot, viteConfig);
  const config = await readFile(viteConfigPath, "utf8");
  const testConfig = config.replace(
    /strictPort:\s*true\b,?/,
    `strictPort: true, port: ${clientPort}`,
  );
  assert(testConfig !== config, "Could not set a free Vite port for the dev runner smoke test.");
  await writeFile(viteConfigPath, testConfig);
  const serverEnvExample = (await readFile(serverEnvExamplePath, "utf8"))
    .replace(/^PORT=\d+$/m, `PORT=${port}`);
  await writeFile(serverEnvExamplePath, serverEnvExample);
  const logFilePath = join(projectRoot, ".dev.log");
  await rm(clientEnvPath, { force: true });
  await rm(serverEnvPath, { force: true });
  await writeFile(logFilePath, "stale session marker\n");
  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      npm_config_user_agent: `${packageManager}/10.0.0`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }

  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(clientEnvPath) && Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Dev runner exited with code ${child.exitCode}.\n${output}`);
      }
      await delay(100);
    }
    const initializedClientEnv = await readFile(clientEnvPath, "utf8");
    const apiUrl = /^VITE_API_URL=(.+)$/m.exec(initializedClientEnv)?.[1];
    assert(apiUrl, `Dev runner did not initialize the client environment.\n${output}`);
    const origin = "http://localhost:5173";
    let healthResponse;
    const healthDeadline = Date.now() + 30_000;
    while (Date.now() < healthDeadline) {
      try {
        healthResponse = await fetch(`${apiUrl}/api/health`, {
          headers: { Origin: origin },
        });
      } catch {
        await delay(100);
        continue;
      }
      break;
    }
    assert(healthResponse, `Timed out waiting for the local backend.\n${output}`);
    const healthBody = await healthResponse.json();
    assert(
      healthResponse.ok && healthBody.status === "ok",
      `Dev runner backend returned an unexpected health response.\n${output}`,
    );
    assert(
      healthResponse.headers.get("access-control-allow-origin") === origin,
      "Local frontend origin could not access the backend API.",
    );
    const initializedServerEnv = await readFile(serverEnvPath, "utf8");
    assert(
      initializedClientEnv.includes(`VITE_API_URL=http://localhost:${port}`),
      "Dev runner did not reset the client API URL to localhost.",
    );
    assert(
      initializedServerEnv.includes(`PORT=${port}`) &&
        initializedServerEnv.includes("HOST=localhost"),
      "Dev runner did not initialize local backend host settings.",
    );
    let localClient;
    const localClientDeadline = Date.now() + 30_000;
    while (Date.now() < localClientDeadline) {
      try {
        localClient = await fetch(`http://localhost:${clientPort}/`);
      } catch {
        await delay(100);
        continue;
      }
      break;
    }
    assert(localClient, `Local frontend did not become reachable.\n${output}`);
    assert(localClient.ok, "Frontend did not serve successfully in local-host mode.");
    let devLog = await readFile(logFilePath, "utf8");
    assert(
      !devLog.includes("stale session marker") &&
        devLog.includes("[client]") &&
        devLog.includes("[server]"),
      "Dev runner did not clear and record the current session logs.",
    );
    const logBeforeConcurrentRunner = await readFile(logFilePath, "utf8");
    const concurrentRunner = await run(process.execPath, ["scripts/dev.mjs"], projectRoot, {
      ...process.env,
      npm_config_user_agent: `${packageManager}/10.0.0`,
    });
    const logAfterConcurrentRunner = await readFile(logFilePath, "utf8");
    assert(
      concurrentRunner.code !== 0 &&
        concurrentRunner.output.includes("already active") &&
        logAfterConcurrentRunner.startsWith(logBeforeConcurrentRunner),
      "A second dev runner did not preserve the active session log.",
    );
    const serverSourcePath = join(projectRoot, `${projectName}-server`, "src", "server.ts");
    const initialServerLogCount = devLog.match(/Backend listening/g)?.length ?? 0;
    const serverSource = await readFile(serverSourcePath, "utf8");
    await writeFile(serverSourcePath, `${serverSource}\n// trigger a watcher restart\n`);
    const restartDeadline = Date.now() + 10_000;
    let restartedLog = devLog;
    while (
      Date.now() < restartDeadline &&
      (restartedLog.match(/Backend listening/g)?.length ?? 0) <= initialServerLogCount
    ) {
      await delay(50);
      restartedLog = await readFile(logFilePath, "utf8");
    }
    assert(
      (restartedLog.match(/Backend listening/g)?.length ?? 0) > initialServerLogCount,
      "Dev runner did not record backend watcher restarts.",
    );
    assert(
      !output.includes("\u001bc") && !restartedLog.includes("\u001bc"),
      "Backend watcher reset the terminal instead of preserving the log view.",
    );
    const bannerDeadline = Date.now() + 5_000;
    while (
      Date.now() < bannerDeadline &&
      (!output.includes("ADD DEPENDENCIES LATER") ||
        !output.includes("DEVELOPMENT CONTROLS"))
    ) {
      await delay(50);
    }
    assert(
      output.includes("ADD DEPENDENCIES LATER") &&
        output.includes("DEVELOPMENT CONTROLS"),
      "Dev runner did not display dependency and shortcut banners.",
    );
    const dependencyBannerIndex = output.indexOf("ADD DEPENDENCIES LATER");
    const shortcutsBannerIndex = output.indexOf("DEVELOPMENT CONTROLS");
    assert(
      dependencyBannerIndex < shortcutsBannerIndex,
      "Dev runner displayed banners in the wrong order.",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], projectRoot).catch(
          () => {},
        );
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        delay(10_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], projectRoot).catch(
            () => {},
          );
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await new Promise((resolve) => child.once("close", resolve));
      }
    }
  }
  await verifyHostMode(projectRoot, packageManager, clientPort);

  async function verifyHostMode(projectRoot, packageManager, clientPort) {
    const projectName = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).name;
    const clientEnvPath = join(projectRoot, `${projectName}-client`, ".env.local");
    const serverEnvPath = join(projectRoot, `${projectName}-server`, ".env");
    const child = spawn(process.execPath, ["scripts/dev.mjs", "--host"], {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, npm_config_user_agent: `${packageManager}/10.0.0` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    try {
      const deadline = Date.now() + 30_000;
      let apiUrl;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`Host-mode dev runner exited with code ${child.exitCode}.\n${output}`);
        }
        if (existsSync(clientEnvPath)) {
          const hostClientEnv = await readFile(clientEnvPath, "utf8");
          const candidate = /^VITE_API_URL=(.+)$/m.exec(hostClientEnv)?.[1];
          if (candidate && !candidate.includes("localhost")) {
            apiUrl = candidate;
            break;
          }
        }
        await delay(100);
      }
      assert(
        apiUrl && !apiUrl.includes("localhost"),
        `Host mode did not set a LAN API URL.\n${output}`,
      );
      const host = new URL(apiUrl).hostname;
      const serverEnv = await readFile(serverEnvPath, "utf8");
      assert(serverEnv.includes("HOST=0.0.0.0"), "Host mode did not bind the backend to all interfaces.");
      const origin = `http://${host}:5173`;
      let response;
      const apiDeadline = Date.now() + 30_000;
      while (Date.now() < apiDeadline) {
        try {
          response = await fetch(`${apiUrl}/api/health`, { headers: { Origin: origin } });
        } catch {
          await delay(100);
          continue;
        }
        break;
      }
      assert(response, `Host-mode backend did not become reachable.\n${output}`);
      const result = await response.json();
      assert(
        response.ok &&
          result.status === "ok" &&
          response.headers.get("access-control-allow-origin") === origin,
        `Host-mode frontend could not access the backend API.\n${output}`,
      );
      let frontend;
      const frontendDeadline = Date.now() + 30_000;
      while (Date.now() < frontendDeadline) {
        try {
          frontend = await fetch(`http://${host}:${clientPort}/`);
        } catch {
          await delay(100);
          continue;
        }
        break;
      }
      assert(frontend, "Network-hosted frontend did not become reachable.");
      assert(frontend.ok, "Frontend did not serve successfully in network-host mode.");
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === "win32") {
          await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], projectRoot).catch(
            () => {},
          );
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          delay(10_000),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") {
            await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], projectRoot).catch(
              () => {},
            );
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          await new Promise((resolve) => child.once("close", resolve));
        }
      }
    }
  }
}

const cases = [];
for (const packageManager of ["npm", "pnpm"]) {
  for (const language of ["js", "ts"]) {
    for (const backend of ["none", "basic", "express"]) {
      for (const tailwind of [false, true]) {
        cases.push({ packageManager, language, backend, tailwind });
      }
    }
  }
}
cases.push(
  {
    packageManager: "npm",
    language: "js",
    backend: "express",
    tailwind: true,
    template: "react",
    router: true,
    structure: "module",
    axios: true,
    icons: "react-icons",
  },
  {
    packageManager: "npm",
    language: "ts",
    backend: "express",
    tailwind: false,
    template: "react",
    router: false,
    axios: false,
    icons: "none",
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: false,
    template: "react",
    router: false,
    axios: true,
    icons: "animateicons",
  },
  {
    packageManager: "npm",
    language: "ts",
    backend: "basic",
    tailwind: false,
    structure: "module",
    verifyDevRunner: true,
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "express",
    tailwind: false,
    structure: "module",
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: false,
    template: "react-ts",
    router: true,
    quick: true,
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: false,
    template: "react-ts",
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: false,
    template: "vanilla-ts",
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: true,
    template: "vanilla-ts",
    quick: true,
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "none",
    tailwind: false,
    template: "react",
    router: true,
    quick: true,
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "basic",
    tailwind: false,
    defaultFlag: true,
  },
  {
    packageManager: "npm",
    language: "js",
    backend: "basic",
    tailwind: false,
    npmDefaultEnv: true,
  },
);

function getCaseName(testCase) {
  const structure = testCase.structure ?? "simple";
  const template = testCase.template ?? "vanilla";
  return `smoke-${testCase.packageManager}-${testCase.language}-${testCase.backend}-${testCase.tailwind ? "tw" : "plain"}-${template}${structure === "module" ? "-module" : ""}${testCase.router === undefined ? "" : `-${testCase.router ? "router" : "no-router"}`}${testCase.defaultFlag ? "-default" : ""}${testCase.npmDefaultEnv ? "-npm-default" : ""}`;
}

async function verifyCliArguments() {
  const unknownFlag = await run(
    process.execPath,
    [cliPath, "invalid-flags", "--unknown-option"],
    tempRoot,
  );
  assert(
    unknownFlag.code !== 0 &&
      unknownFlag.output.includes("Unknown option: --unknown-option") &&
      unknownFlag.output.includes("Allowed options:"),
    "Generator did not reject unknown options or list the allowed options.",
  );
  const missingTemplate = await run(
    process.execPath,
    [cliPath, "--template", "react"],
    tempRoot,
  );
  assert(
    missingTemplate.code !== 0 &&
      missingTemplate.output.includes("--template requires a value") &&
      !missingTemplate.output.includes("Creating the frontend"),
    "Generator did not reject --template without =value or consumed its value as a project name.",
  );
  const existingPath = join(tempRoot, "existing-destination");
  await mkdir(existingPath);
  const markerPath = join(existingPath, "preserve-me.txt");
  await writeFile(markerPath, "existing project data\n");
  const existingDestination = await run(
    process.execPath,
    [
      cliPath,
      "existing-destination",
      "--template=vanilla",
      "--yes",
      "--backend=none",
      "--no-git",
      "--no-update-check",
    ],
    tempRoot,
  );
  assert(
    existingDestination.code !== 0 &&
      existingDestination.output.includes("destination already exists") &&
      (await readFile(markerPath, "utf8")) === "existing project data\n",
    "Generator did not preserve an existing destination directory.",
  );
}

await verifyCliArguments();
let selectedCases = cases;
if (smokeFilter) {
  selectedCases = selectedCases.filter((testCase) => getCaseName(testCase).includes(smokeFilter));
  assert(selectedCases.length > 0, `SMOKE_FILTER matched no cases: ${smokeFilter}`);
}
if (process.argv.includes("--quick")) {
  let pnpmQuickCaseSelected = false;
  selectedCases = selectedCases.filter((testCase, index) => {
    if (index === 0 || testCase.quick) {
      if (testCase.packageManager === "pnpm") pnpmQuickCaseSelected = true;
      return true;
    }
    if (testCase.packageManager === "pnpm" && !pnpmQuickCaseSelected) {
      pnpmQuickCaseSelected = true;
      return true;
    }
    return false;
  });
}
if (selectedCases.some((testCase) => testCase.packageManager === "pnpm")) {
  const pnpmPreflight = await run("pnpm", ["--version"], tempRoot, process.env, 30_000);
  assert(pnpmPreflight.code === 0, `pnpm is required for selected smoke cases.\n${pnpmPreflight.output}`);
}

try {
  const dependencySmokeManagers = new Set();
  const freshCloneManagers = new Set();
  for (const [index, testCase] of selectedCases.entries()) {
    const { packageManager, language, backend, tailwind } = testCase;
    const structure = testCase.structure ?? "simple";
    const frontendTemplate = testCase.template ?? "vanilla";
    const name = getCaseName(testCase);
    const projectRoot = join(tempRoot, name);
    const args = [
      cliPath,
      name,
      "--yes",
      "--no-git",
      "--no-start",
      `--template=${frontendTemplate}`,
      `--pm=${packageManager}`,
      `--backend=${backend}`,
      `--${language}`,
      ...(testCase.defaultFlag || testCase.npmDefaultEnv ? [] : [`--structure=${structure}`]),
      ...(tailwind ? ["--tailwind"] : ["--no-tailwind"]),
      ...(testCase.axios === true ? ["--axios"] : testCase.axios === false ? ["--no-axios"] : []),
      ...(testCase.icons ? [`--icons=${testCase.icons}`] : []),
      ...(testCase.router === true
        ? ["--router"]
        : testCase.router === false
          ? ["--no-router"]
          : []),
      "--no-update-check",
      ...(testCase.defaultFlag ? ["--default"] : []),
    ];
    const scaffold = await run(process.execPath, args, tempRoot, {
      ...process.env,
      CI: "1",
      npm_config_default: testCase.npmDefaultEnv ? "true" : "false",
    });
    assert(
      scaffold.code === 0,
      `${name}: generator failed with ${scaffold.signal ?? scaffold.code}.\n${scaffold.output}`,
    );
    const projectCreatedIndex = scaffold.output.indexOf("Project created successfully:");
    const dependencyNoticeIndex = scaffold.output.indexOf(">>> ADD DEPENDENCIES LATER <<<");
    assert(
      projectCreatedIndex !== -1 &&
        dependencyNoticeIndex === -1,
      `${name}: dependency reminder should appear when the dev runner starts, not during scaffolding.`,
    );

    const clientRoot = join(projectRoot, `${name}-client`);
    const serverRoot = join(projectRoot, `${name}-server`);
    const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    const clientPackage = JSON.parse(
      await readFile(join(clientRoot, "package.json"), "utf8"),
    );
    const clientEnv = await readFile(join(clientRoot, ".env.local"), "utf8");
    assert(rootPackage.engines.node === ">=20.6", `${name}: missing Node engine requirement`);
    assert((await readdir(clientRoot)).includes(".env.example"), `${name}: missing client .env.example`);
    assert(
      clientEnv.includes("VITE_API_URL=http://localhost:4000"),
      `${name}: missing default client API URL`,
    );
    const clientIndex = await readFile(join(clientRoot, "index.html"), "utf8");
    const hasBackendStatus = clientIndex.includes('src="/backend-status.js"');
    assert(
      hasBackendStatus === (backend !== "none"),
      `${name}: backend connection control does not match backend selection`,
    );
    if (backend !== "none") {
      const statusScript = await readFile(join(clientRoot, "backend-status.js"), "utf8");
      assert(
        statusScript.includes("/api/health") &&
          statusScript.includes("Connected") &&
          statusScript.includes("Unavailable") &&
          statusScript.includes("if (import.meta.env.DEV)") &&
          statusScript.includes('import("./backend-status.css")'),
        `${name}: backend connection control is missing a check result state`,
      );
      assert(
        (await readdir(clientRoot)).includes("backend-status.css"),
        `${name}: backend connection control stylesheet is missing`,
      );
    }
    assert(
      Boolean(clientPackage.devDependencies?.tailwindcss) === tailwind,
      `${name}: Tailwind selection was not scaffolded`,
    );
    if (testCase.axios !== undefined) {
      assert(
        Boolean(clientPackage.dependencies?.axios) === testCase.axios,
        `${name}: Axios selection does not match the test case`,
      );
    }
    if (testCase.icons) {
      const iconPackage =
        testCase.icons === "animateicons"
          ? "@animateicons/react"
          : testCase.icons === "react-icons"
            ? "react-icons"
            : null;
      const hasAnyIconPackage = Boolean(
        clientPackage.dependencies?.["react-icons"] ||
          clientPackage.dependencies?.["@animateicons/react"],
      );
      assert(
        iconPackage
          ? Boolean(clientPackage.dependencies?.[iconPackage])
          : !hasAnyIconPackage,
        `${name}: icon selection does not match the test case`,
      );
    }
    const viteConfig = (await readdir(clientRoot)).find((file) =>
      /^vite\.config\.(?:[cm]?[jt]s)$/.test(file),
    );
    assert(viteConfig, `${name}: Vite config is missing`);
    assert(
      (await readFile(join(clientRoot, viteConfig), "utf8")).includes("strictPort: true"),
      `${name}: Vite strictPort is not enabled`,
    );
    if (frontendTemplate.startsWith("react") && testCase.router !== undefined) {
      assert(
        Boolean(clientPackage.dependencies?.["react-router"]) === testCase.router,
        `${name}: React Router selection does not match the test case`,
      );
    }
    if (frontendTemplate.startsWith("react") && testCase.router && tailwind) {
      const homeExtension = frontendTemplate.endsWith("-ts") ? "tsx" : "jsx";
      const homeSource = await readFile(
        join(clientRoot, "src", "Pages", "Home", `Home.${homeExtension}`),
        "utf8",
      );
      assert(
        homeSource.includes(
          "py-[72px] sm:pt-[clamp(72px,12vw,132px)] sm:pb-[84px]",
        ),
        `${name}: Tailwind router Home spacing classes do not match the template.`,
      );
    }
    if (packageManager === "pnpm") {
      assert(
        (await readdir(projectRoot)).includes("pnpm-workspace.yaml"),
        `${name}: pnpm workspace metadata is missing`,
      );
      const pnpmWorkspace = await readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8");
      assert(
        pnpmWorkspace.includes("onlyBuiltDependencies: [esbuild]") &&
          pnpmWorkspace.includes("allowBuilds:"),
        `${name}: pnpm build permissions do not match the target config`,
      );
    } else {
      assert(!((await readdir(projectRoot)).includes("pnpm-workspace.yaml")), `${name}: unexpected pnpm metadata`);
    }
    assert(
      (await readdir(projectRoot)).includes("node_modules"),
      `${name}: generator did not install dependencies`,
    );

    if (backend === "none") {
      assert(!rootPackage.workspaces.includes(`${name}-server`), `${name}: unexpected server workspace`);
    } else {
      const serverPackage = JSON.parse(
        await readFile(join(serverRoot, "package.json"), "utf8"),
      );
      if (backend === "basic") {
        assert(serverPackage.dependencies?.dotenv, `${name}: dotenv dependency is missing`);
        assert(
          !serverPackage.scripts.dev.includes("--env-file"),
          `${name}: backend dev script still uses Node env-file flags`,
        );
      }
      const extension = language === "ts" ? "ts" : "js";
      const serverSource = await readFile(
        join(serverRoot, "src", `server.${extension}`),
        "utf8",
      );
      const appSource = await readFile(
        join(serverRoot, "src", `app.${extension}`),
        "utf8",
      );
      const corsSource =
        backend === "basic"
          ? await readFile(join(serverRoot, "src", `basicHandler.${extension}`), "utf8")
          : appSource;
      const serverEnv = await readFile(join(serverRoot, ".env"), "utf8");
      assert(
        serverEnv.includes("CORS_ORIGIN=http://localhost:5173"),
        `${name}: missing default server CORS origin`,
      );
      assert(
        serverEnv.includes("HOST=localhost") &&
          serverSource.includes("process.env.HOST ?? \"localhost\"") &&
          serverSource.includes("app.listen(port, host"),
        `${name}: backend does not listen on its configured host`,
      );
      assert(
        corsSource.includes("process.env.CORS_ORIGIN") && corsSource.includes('.split(",")'),
        `${name}: server CORS configuration does not support multiple origins`,
      );
      if (language === "js") {
        for (const file of ["app.js", "server.js"]) {
          const syntaxCheck = await run(
            process.execPath,
            ["--check", join(serverRoot, "src", file)],
            projectRoot,
          );
          assert(
            syntaxCheck.code === 0,
            `${name}: generated ${file} is invalid JavaScript.\n${syntaxCheck.output}`,
          );
        }
      }
      const serverFolders =
        structure === "module"
          ? ["module", "config", "middleware", "utils"]
          : ["routes", "controllers", "middleware", "config"];
      for (const folder of serverFolders) {
        assert(
          (await readdir(join(serverRoot, "src", folder))).includes(".gitkeep"),
          `${name}: missing ${folder}/.gitkeep`,
        );
      }
      assert((await readdir(serverRoot)).includes(".env.example"), `${name}: missing server .env.example`);
      assert(
        serverSource.includes("SIGINT") &&
          serverSource.includes("SIGTERM") &&
          serverSource.includes("server.close"),
        `${name}: graceful shutdown handlers are missing`,
      );
      assert(
        corsSource.includes("Internal Server Error"),
        `${name}: JSON error handler is missing`,
      );
      if (structure === "module" && backend === "basic") {
        const handlerPath = join(serverRoot, "src", `basicHandler.${extension}`);
        const routerPath = join(serverRoot, "src", `mainRouter.${extension}`);
        assert(
          (await readdir(join(serverRoot, "src"))).includes(`basicHandler.${extension}`),
          `${name}: shared basic backend handler is missing`,
        );
        assert(
          (await readFile(routerPath, "utf8")).includes(`./basicHandler.${extension}`),
          `${name}: module router does not re-export the shared handler`,
        );
        assert(
          (await readFile(handlerPath, "utf8")).includes("/api/health"),
          `${name}: shared handler is missing the health route`,
        );
      }
      if (structure === "module" && backend === "express") {
        const routerSource = await readFile(
          join(serverRoot, "src", `mainRouter.${extension}`),
          "utf8",
        );
        assert(
          routerSource.includes('mainRouter.get("/",') &&
            appSource.includes('response.status(404).json({ error: "Not Found" })'),
          `${name}: Express module root or JSON 404 route is missing`,
        );
      }
      if (backend === "express") {
        assert(serverPackage.dependencies?.cors, `${name}: Express CORS dependency is missing`);
      }
      assert(serverPackage.scripts.dev, `${name}: missing backend dev script`);
      if (language === "ts") {
        assert(serverPackage.scripts.dev.includes("src/server.ts"), `${name}: TypeScript server was not generated`);
        if (backend === "basic") {
          assert(
            serverPackage.scripts.dev === "tsx watch src/server.ts" &&
              serverPackage.scripts.start === "tsx src/server.ts",
            `${name}: TypeScript basic scripts are not in runnable tsx form`,
          );
        }
        const typecheckArgs =
          packageManager === "pnpm"
            ? ["--filter", `${name}-server`, "exec", "tsc", "--noEmit", "-p", join(serverRoot, "tsconfig.json")]
            : ["exec", `--workspace=${name}-server`, "--", "tsc", "--noEmit", "-p", join(serverRoot, "tsconfig.json")];
        const typecheck = await run(
          packageManager,
          typecheckArgs,
          projectRoot,
        );
        assert(typecheck.code === 0, `${name}: backend typecheck failed.\n${typecheck.output}`);
      }
    }

    const install = await run(packageManager, ["install"], projectRoot, {
      ...process.env,
      CI: "1",
    });
    assert(install.code === 0, `${name}: package install failed.\n${install.output}`);
    const build = await run(packageManager, ["run", "build"], projectRoot, process.env);
    assert(build.code === 0, `${name}: workspace build failed.\n${build.output}`);

    if (testCase.verifyDevRunner) {
      await verifyDevRunner(projectRoot, packageManager);
    }

    if (backend !== "none" && language === "js") {
      const allowedOrigins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.1.25:5173",
        "http://172.19.0.1:5173",
      ];
      const corsCheck = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createApp } from "./src/app.js";
const origins = ${JSON.stringify(allowedOrigins)};
const checkExpressModuleRoutes = ${JSON.stringify(
            backend === "express" && testCase.structure === "module",
          )};
const server = createApp().listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  try {
    for (const origin of [...origins, "https://untrusted.example"]) {
      const response = await fetch(\`http://127.0.0.1:\${port}/api/health\`, {
        headers: { Origin: origin },
      });
      const allowed = response.headers.get("access-control-allow-origin");
      if (origins.includes(origin) ? allowed !== origin : allowed !== null) {
        throw new Error(\`Unexpected CORS response for \${origin}: \${allowed}\`);
      }
      if (origins.includes(origin) && !response.headers.get("vary")?.split(/,\\s*/).includes("Origin")) {
        throw new Error(\`CORS response for \${origin} is missing Vary: Origin.\`);
      }
    }
    if (checkExpressModuleRoutes) {
      const rootResponse = await fetch(\`http://127.0.0.1:\${port}/\`);
      const rootBody = await rootResponse.json();
      const missingResponse = await fetch(\`http://127.0.0.1:\${port}/missing\`);
      const missingBody = await missingResponse.json();
      if (!rootResponse.ok || rootBody.message !== "Backend is running") {
        throw new Error("Express module root route did not return its JSON response.");
      }
      if (missingResponse.status !== 404 || missingBody.error !== "Not Found") {
        throw new Error("Express module 404 route did not return JSON.");
      }
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});`,
        ],
        serverRoot,
        {
          ...process.env,
          CORS_ORIGIN: allowedOrigins.join(","),
        },
      );
      assert(
        corsCheck.code === 0,
        `${name}: CORS origin checks failed.\n${corsCheck.output}`,
      );
    }

    const shouldCheckGuard =
      index === 0 || (packageManager === "pnpm" && !dependencySmokeManagers.has("pnpm"));
    if (shouldCheckGuard) {
      const preinstallEnv = { ...process.env };
      delete preinstallEnv.CI;
      delete preinstallEnv.VANILLA_VITE_ALLOW_INSTALL;
      if (packageManager === "npm" && index === 0) {
        const directInstall = await run(
          "npm",
          ["install", guardPackagePath, "--dry-run", "--no-audit", "--no-fund"],
          projectRoot,
          preinstallEnv,
        );
        if (directInstall.code === 0) {
          console.warn(
            "Direct `npm install <package>` does not run the root preinstall lifecycle on this npm version; checking the preinstall guard directly instead.",
          );
        } else {
          assert(
            directInstall.output.includes("Direct installs are disabled"),
            `${name}: direct npm install failed for a reason other than the guard.\n${directInstall.output}`,
          );
        }
      }
      const guard =
        packageManager === "pnpm"
          ? await run("pnpm", ["run", "preinstall"], projectRoot, preinstallEnv)
          : await run("npm", ["run", "preinstall"], projectRoot, preinstallEnv);
      assert(
        guard.code !== 0 && guard.output.includes("Direct installs are disabled"),
        `${name}: preinstall guard did not block a direct install.\n${guard.output}`,
      );
    }
    const shouldTestAddDependency =
      index === 0 ||
      (packageManager === "pnpm" && !dependencySmokeManagers.has("pnpm"));
    if (shouldTestAddDependency) {
      const npmCommand = packageManager === "pnpm" ? "pnpm" : "npm";
      const addArgs =
        packageManager === "pnpm"
          ? ["adD", "cross-spawn@^7.0.6"]
          : ["run", "adD", "--", "cross-spawn@^7.0.6"];
      const options = process.platform === "win32" ? `--import="${pathToFileURL(preloadPath)}"` : `--import=${pathToFileURL(preloadPath)}`;
      const add = await run(npmCommand, addArgs, projectRoot, {
        ...process.env,
        ...(index === 0 ? { SMOKE_ADD_KEY: "escape" } : {}),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, options].filter(Boolean).join(" "),
      });
      assert(add.code === 0, `${name}: adD failed.\n${add.output}`);
      const installedInClient = JSON.parse(
        await readFile(join(clientRoot, "package.json"), "utf8"),
      );
      assert(
        installedInClient.dependencies?.["cross-spawn"],
        `${name}: adD did not default to the client workspace`,
      );
      dependencySmokeManagers.add(packageManager);
    }
    const shouldTestFreshClone =
      index === 0 ||
      (packageManager === "pnpm" && !freshCloneManagers.has("pnpm"));
    if (shouldTestFreshClone && !freshCloneManagers.has(packageManager)) {
      const nodeModulesPath = join(projectRoot, "node_modules");
      await rm(nodeModulesPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      await rm(join(projectRoot, ".install-state"), { force: true });
      const freshInstallEnv = { ...process.env };
      delete freshInstallEnv.CI;
      delete freshInstallEnv.VANILLA_VITE_ALLOW_INSTALL;
      const freshInstallArgs =
        packageManager === "pnpm" ? ["install"] : ["install", "--no-audit", "--no-fund"];
      const freshInstall = await run(
        packageManager,
        freshInstallArgs,
        projectRoot,
        freshInstallEnv,
      );
      assert(
        freshInstall.code === 0,
        `${name}: fresh-clone install failed without CI or the install override.\n${freshInstall.output}`,
      );
      const reinstallArgs =
        packageManager === "pnpm" ? ["install", "--force"] : freshInstallArgs;
      const reinstall = await run(packageManager, reinstallArgs, projectRoot, freshInstallEnv);
      assert(
        reinstall.code !== 0 &&
          reinstall.output.includes("Direct installs are disabled"),
        `${name}: later plain reinstall was not blocked by the install guard.\n${reinstall.output}`,
      );
      freshCloneManagers.add(packageManager);
    }
    if (frontendTemplate.startsWith("react")) {
      const lintArgs = packageManager === "pnpm" ? ["lint"] : ["run", "lint"];
      const lint = await run(packageManager, lintArgs, projectRoot, process.env);
      assert(lint.code === 0, `${name}: root lint script failed.\n${lint.output}`);
    }
    console.log(`[${index + 1}/${selectedCases.length}] ${name} passed`);
    if (!keepSmokeFiles) {
      await rm(projectRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }
} finally {
  if (keepSmokeFiles) {
    console.log(`Kept smoke test files at ${tempRoot}`);
  } else {
    await rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
