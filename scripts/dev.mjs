import spawn from "cross-spawn";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const logFile = join(root, ".dev.log");
const lockFile = join(root, ".dev.lock");
const maxLogLines = 2000;
const maxLogBytes = 1_000_000;
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const children = [];
let lockDescriptor;

function forceKillChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 1000,
        });
      } catch (error) {
        console.error(`Unable to force-stop process tree ${child.pid}: ${error.message}`);
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error(`Unable to kill process ${child.pid}: ${error.message}`);
        }
      }
    }
  }
}

for (;;) {
  try {
    lockDescriptor = openSync(lockFile, "wx");
    writeFileSync(lockDescriptor, `${process.pid}\n`);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let activePid;
    try {
      activePid = Number(readFileSync(lockFile, "utf8").trim());
    } catch (readError) {
      if (readError.code === "ENOENT") continue;
      throw readError;
    }
    let runnerActive = Number.isInteger(activePid) && activePid > 0;
    if (runnerActive) {
      try {
        process.kill(activePid, 0);
      } catch (processError) {
        if (processError.code === "ESRCH") runnerActive = false;
        else if (processError.code !== "EPERM") throw processError;
      }
    }
    if (runnerActive) {
      console.error(`A development runner is already active (PID ${activePid}).`);
      process.exit(1);
    }
    try {
      unlinkSync(lockFile);
    } catch (unlinkError) {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    }
  }
}
process.on("exit", () => {
  forceKillChildren();
  try {
    closeSync(lockDescriptor);
  } catch (error) {
    if (error.code !== "EBADF") console.error(`Unable to close runner lock: ${error.message}`);
  }
  try {
    if (readFileSync(lockFile, "utf8") === `${process.pid}\n`) unlinkSync(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Unable to remove runner lock: ${error.message}`);
  }
});
writeFileSync(logFile, "");
const packageManager = process.env.npm_config_user_agent?.startsWith("pnpm/")
  ? "pnpm"
  : "npm";
const apps = project.workspaces.map((workspace) => ({
  name: workspace.endsWith("-client") ? "client" : "server",
  workspace,
}));
const colors = { client: 36, server: 35, dev: 90 };
let stopping = false;
let restarting = false;
let hostEnabled = process.argv.includes("--host");
const hasServer = apps.some((app) => app.name === "server");
const logLayouts = hasServer
  ? ["combined", "side-by-side", "stacked"]
  : ["combined", "stacked"];
let logLayoutIndex = 0;

function getNetworkAddress() {
  const addresses = getNetworkAddresses();
  const privateAddress = addresses.find(({ address }) => {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second >= 16 && second <= 31)
    );
  });
  return (privateAddress ?? addresses[0])?.address;
}

function getNetworkAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal);
}

async function updateEnvValue(path, key, value) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    contents = "";
  }
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (expression.test(contents)) {
    contents = contents.replace(expression, `${key}=${value}`);
  } else {
    contents += `${contents.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  await writeFile(path, contents);
}

async function ensureEnvFiles() {
  for (const app of apps) {
    const workspaceRoot = join(root, app.workspace);
    const envName = app.name === "client" ? ".env.local" : ".env";
    const envPath = join(workspaceRoot, envName);
    try {
      await readFile(envPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await copyFile(join(workspaceRoot, ".env.example"), envPath);
      } catch (exampleError) {
        if (exampleError.code !== "ENOENT") throw exampleError;
        await writeFile(envPath, "");
      }
    }
  }
}

async function updateNetworkEnvironment(enabled, address) {
  const client = apps.find((app) => app.name === "client");
  const server = apps.find((app) => app.name === "server");
  if (!client) return;

  const serverPort = server
    ? (await readFile(join(root, server.workspace, ".env"), "utf8"))
        .match(/^PORT=(\d+)$/m)?.[1] ?? "4000"
    : "4000";
  await updateEnvValue(
    join(root, client.workspace, ".env.local"),
    "VITE_API_URL",
    enabled ? `http://${address}:${serverPort}` : `http://localhost:${serverPort}`,
  );
  if (server) {
    await updateEnvValue(
      join(root, server.workspace, ".env"),
      "HOST",
      enabled ? "0.0.0.0" : "localhost",
    );
    const allowedOrigins = enabled
      ? [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          ...new Set(
            getNetworkAddresses().map(({ address }) => `http://${address}:5173`),
          ),
        ]
      : ["http://localhost:5173", "http://127.0.0.1:5173"];
    await updateEnvValue(
      join(root, server.workspace, ".env"),
      "CORS_ORIGIN",
      allowedOrigins.join(","),
    );
  }
  return serverPort;
}

function log(name, message, write = console.log) {
  displayLog(name, message, write);
}

function formatLog(name, message) {
  const prefix = `[${name}]`;
  return `${process.env.NO_COLOR === undefined && process.stdout.isTTY ? `\x1b[${colors[name]}m${prefix}\x1b[0m` : prefix} ${message}`;
}

function showDependencyCommands() {
  const commands =
    packageManager === "pnpm"
      ? ["  > pnpm adD <package>", "  > pnpm add-dependency <package>"]
      : ["  > npm run adD -- <package>", "  > npm run add-dependency -- <package>"];
  const lines = [">>> ADD DEPENDENCIES LATER <<<", ...commands];
  const width = Math.max(...lines.map((line) => line.length));
  const border = "+".repeat(width);
  const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  console.log(paint("1;33", border));
  console.log(paint("1;33", lines[0].padEnd(width)));
  for (const line of lines.slice(1)) console.log(paint("1;36", line.padEnd(width)));
  console.log(paint("1;33", border));
}

function showShortcuts() {
  const layoutHelp = hasServer
    ? " [g] Change log layout: combined / split / stacked "
    : " [g] Toggle combined / divided client logs ";
  const lines = [
    " VANILLA VITE · DEVELOPMENT CONTROLS ",
    " [r] Restart   [h] Network host   [c] Clear   [Ctrl+C] Stop ",
    layoutHelp,
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const border = "+".repeat(width);
  const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const paint = (text) => color ? `\x1b[1;36m${text}\x1b[0m` : text;
  console.log(paint(border));
  for (const line of lines) console.log(paint(line.padEnd(width)));
  console.log(paint(border));
}

function clippedLine(value, width) {
  const plain = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const content = plain.length > width ? `${plain.slice(0, Math.max(0, width - 1))}…` : plain;
  return `${content}${" ".repeat(Math.max(0, width - content.length))}`;
}

function panelLines(name, width, lines) {
  return [
    name.toUpperCase(),
    "-".repeat(width),
    ...lines.map((line) => clippedLine(line, width)),
  ];
}

function sideBySideRow(name, formatted, panelWidth) {
  const line = clippedLine(formatted, panelWidth);
  const empty = " ".repeat(panelWidth);
  const left = name === "client" ? line : empty;
  const right = name === "server" ? line : empty;
  return `${left} | ${right}\n`;
}

function renderLogLayout() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[2J\x1b[H");
  showDependencyCommands();
  showShortcuts();

  const layout = logLayouts[logLayoutIndex];
  const entries = readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLogLines)
    .map((line) => {
      const match = /^\[(client|server|dev)\]\s?(.*)$/.exec(line);
      return match ? { name: match[1], message: match[2] } : null;
    })
    .filter(Boolean);
  if (layout === "combined") {
    for (const entry of entries) {
      process.stdout.write(`${formatLog(entry.name, entry.message)}\n`);
    }
    return;
  }

  const columns = Math.max(40, process.stdout.columns ?? 80);
  if (layout === "side-by-side" && columns >= 80) {
    const panelWidth = Math.floor((columns - 3) / 2);
    process.stdout.write(`${"CLIENT".padEnd(panelWidth)} | SERVER\n`);
    process.stdout.write(`${"-".repeat(panelWidth)} | ${"-".repeat(panelWidth)}\n`);
    for (const entry of entries) {
      const formatted = formatLog(entry.name, entry.message);
      process.stdout.write(
        entry.name === "dev"
          ? `${formatted}\n`
          : sideBySideRow(entry.name, formatted, panelWidth),
      );
    }
    return;
  }

  const clientLogs = entries
    .filter((entry) => entry.name === "client")
    .map((entry) => formatLog(entry.name, entry.message));
  const serverLogs = entries
    .filter((entry) => entry.name === "server")
    .map((entry) => formatLog(entry.name, entry.message));
  const runnerLogs = entries.filter((entry) => entry.name === "dev");

  for (const entry of runnerLogs) {
    process.stdout.write(`${formatLog("dev", entry.message)}\n`);
  }

  const panelWidth = columns;
  for (const [index, { name }] of apps.entries()) {
    const lines = panelLines(
      name,
      panelWidth,
      name === "client" ? clientLogs : serverLogs,
    );
    if (index > 0) process.stdout.write(`${"-".repeat(panelWidth)}\n`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

function displayRunnerLog(message) {
  displayLog("dev", message);
}

function appendLogInLayout(name, formatted) {
  const layout = logLayouts[logLayoutIndex];
  if (layout === "side-by-side" && (process.stdout.columns ?? 80) >= 80) {
    if (name !== "client" && name !== "server") {
      process.stdout.write(`${formatted}\n`);
      return;
    }
    const panelWidth = Math.floor(((process.stdout.columns ?? 80) - 3) / 2);
    process.stdout.write(sideBySideRow(name, formatted, panelWidth));
    return;
  }

  process.stdout.write(`${formatted}\n`);
}

function displayLog(name, message, write = console.log) {
  const cleanMessage = message
    .replace(/\x1Bc/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[JKH]/g, "");
  const formatted = formatLog(name, cleanMessage);
  const plain = formatted.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  appendFileSync(logFile, `${plain}\n`);
  if (statSync(logFile).size > maxLogBytes - 1) {
    const lines = readFileSync(logFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLogLines);
    let content = lines.join("\n");
    let bytes = Buffer.from(content);
    if (bytes.length > maxLogBytes - 1) {
      let start = bytes.length - (maxLogBytes - 1);
      while (start < bytes.length && (bytes[start] & 0b11000000) === 0b10000000) {
        start += 1;
      }
      content = bytes.subarray(start).toString("utf8");
      const firstLineBreak = content.indexOf("\n");
      if (firstLineBreak !== -1) content = content.slice(firstLineBreak + 1);
      bytes = Buffer.from(content);
      if (bytes.length > maxLogBytes - 1) {
        content = bytes.subarray(-(maxLogBytes - 1)).toString("utf8");
      }
    }
    writeFileSync(logFile, content ? `${content}\n` : "");
  }

  if (
    write === console.log &&
    process.stdout.isTTY &&
    logLayouts[logLayoutIndex] !== "combined"
  ) {
    appendLogInLayout(name, formatted);
  } else {
    write(formatted);
  }
}

function displayAppLog(name, message) {
  displayLog(name, message);
}

function cycleLogLayout() {
  logLayoutIndex = (logLayoutIndex + 1) % logLayouts.length;
  renderLogLayout();
}

function start({ name, workspace }) {
  const args =
    packageManager === "pnpm"
      ? ["--filter", workspace, "run", "dev", ...(name === "client" && hostEnabled ? ["--host"] : [])]
      : [
          "run",
          "dev",
          "--workspace",
          workspace,
          ...(name === "client" && hostEnabled ? ["--", "--host"] : []),
        ];
  const child = spawn(packageManager, args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.appName = name;
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let pending = "";
    const displayChildLine = (line) => {
      if (!line) return;
      const expectedPnpmStop =
        packageManager === "pnpm" &&
        (stopping || restarting) &&
        (line.includes("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL") ||
          line.includes('"pnpm recursive run" failed'));
      if (!expectedPnpmStop) displayAppLog(name, line);
    };
    stream.on("data", (chunk) => {
      const lines = `${pending}${chunk}`.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) displayChildLine(line);
    });
    stream.once("end", () => displayChildLine(pending));
  }
  child.once("error", (error) => {
    log(name, `Unable to start: ${error.message}`, console.error);
    process.exitCode = 1;
    void stop();
  });
  child.once("close", (code) => {
    if (!stopping && !restarting) {
      if (code !== 0) {
        log(name, `Process exited with code ${code ?? "unknown"}.`, console.error);
      }
      process.exitCode = code ?? 1;
      void stop();
    }
  });
}

function signalChild(child, signal) {
  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function waitForClose(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve();
    }, timeout);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
  });
}

async function stopChildren(name) {
  const running = children.filter((child) => !name || child.appName === name);
  if (process.platform === "win32") {
    for (const child of running) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 1000,
        });
      } catch (error) {
        log("dev", `Unable to force-stop process tree ${child.pid}: ${error.message}`, console.error);
      }
    }
    await Promise.all(running.map((child) => waitForClose(child, 750)));
    for (const child of running) {
      const index = children.indexOf(child);
      if (index !== -1) children.splice(index, 1);
    }
    return;
  }
  for (const child of running) signalChild(child, "SIGINT");
  await Promise.all(running.map((child) => waitForClose(child, 3000)));
  for (const child of running) signalChild(child, "SIGTERM");
  await Promise.all(running.map((child) => waitForClose(child, 1000)));
  for (const child of running) signalChild(child, "SIGKILL");
  await Promise.all(running.map((child) => waitForClose(child, 1000)));
  for (const child of running) {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await stopChildren();
}

async function restart() {
  if (restarting || stopping) return;
  restarting = true;
  displayRunnerLog("Restarting application processes...");
  await stopChildren();
  if (stopping) return;
  restarting = false;
  for (const app of apps) start(app);
}

async function toggleHost() {
  if (restarting || stopping) return;
  if (!apps.some((app) => app.name === "client")) {
    log("dev", "No frontend workspace is available to host.");
    return;
  }
  const nextHostEnabled = !hostEnabled;
  const address = nextHostEnabled ? getNetworkAddress() : undefined;
  if (nextHostEnabled && !address) {
    log("dev", "Unable to find a network IPv4 address; hosting mode was not changed.", console.error);
    return;
  }
  restarting = true;
  let serverPort;
  try {
    serverPort = await updateNetworkEnvironment(nextHostEnabled, address);
  } catch (error) {
    restarting = false;
    log("dev", `Unable to update network environment: ${error.message}`, console.error);
    return;
  }
  hostEnabled = nextHostEnabled;
  await stopChildren();
  if (stopping) return;
  for (const app of apps) start(app);
  restarting = false;
  log(
    "dev",
    hostEnabled
      ? `Frontend is available at http://${address}:5173; backend API is http://${address}:${serverPort}.`
      : "Frontend and backend are using localhost.",
  );
}

let environmentSetupFailed = false;
try {
  await ensureEnvFiles();
} catch (error) {
  log("dev", `Unable to initialize workspace environment files: ${error.message}`, console.error);
  process.exit(1);
}

const startupAddress = hostEnabled ? getNetworkAddress() : undefined;
if (hostEnabled && !startupAddress) {
  log("dev", "Unable to find a network IPv4 address; API URL remains on localhost.", console.error);
  hostEnabled = false;
}
try {
  await updateNetworkEnvironment(hostEnabled, startupAddress);
} catch (error) {
  log("dev", `Unable to update network environment: ${error.message}`, console.error);
  environmentSetupFailed = true;
  process.exitCode = 1;
}

if (environmentSetupFailed) process.exit(1);
showDependencyCommands();
showShortcuts();
for (const app of apps) start(app);

let signalCount = 0;
const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    signalCount += 1;
    if (signalCount === 1) {
      process.exitCode = signalExitCodes[signal];
      void stop();
    } else {
      forceKillChildren();
      process.exit(signalExitCodes[signal]);
    }
  });
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    if (key.includes("\u0003")) void stop();
    else if (key.toString().toLowerCase() === "r") void restart();
    else if (key.toString().toLowerCase() === "h") void toggleHost();
    else if (key.toString().toLowerCase() === "g") cycleLogLayout();
    else if (key.toString().toLowerCase() === "c") {
      writeFileSync(logFile, "");
      renderLogLayout();
    }
  });
}
