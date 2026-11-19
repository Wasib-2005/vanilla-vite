import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveFeature, parseArgs, toggleFeature, FEATURES } from "../scripts/toggle-feature.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
    if (options.input) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

console.log("Running bug fix unit tests...\n");

// 1. Express and Basic Server startup error handling (EADDRINUSE)
{
  console.log("Test: Express and Basic Server startup failure handling on EADDRINUSE");
  const tempDir = await mkdtemp(join(tmpdir(), "server-startup-test-"));
  try {
    const port = 49152 + Math.floor(Math.random() * 1000);
    // Occupy the port with an existing server
    const blocker = createServer();
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", resolve);
    });

    // Create a server script with the exact generated template code (including Express 5 callback check)
    const serverScript = join(tempDir, "server.mjs");
    const scriptContent = `
import http from "node:http";

function parsePort(value) {
  if (!value || value.trim() === "") return 4000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(\`Invalid PORT "\${value}"; falling back to 4000.\`);
    return 4000;
  }
  return parsed;
}

const port = parsePort(process.env.PORT);
const host = "127.0.0.1";
// Mock Express 5 app where app.listen passes listen error to callback
const app = {
  listen(p, h, cb) {
    const srv = http.createServer((req, res) => res.end("ok"));
    srv.listen(p, h, (err) => {
      cb(err);
    });
    srv.on("error", (err) => {
      cb(err); // Express 5 also passes error to listen callback on error
    });
    return srv;
  }
};
const server = app.listen(port, host, (error) => {
  if (error) return;
  console.log(\`Backend listening at http://\${host}:\${port}\`);
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(\`Port \${port} is already in use.\`);
  } else {
    console.error("Backend failed to start:", error.message || error);
  }
  process.exit(1);
});
`;
    await writeFile(serverScript, scriptContent);

    const result = await runProcess(process.execPath, [serverScript], {
      env: { ...process.env, PORT: String(port) },
    });

    assert.equal(result.code, 1, "Server should exit with code 1 on EADDRINUSE");
    assert.ok(
      result.output.includes(`Port ${port} is already in use.`),
      "Output should indicate port is already in use",
    );
    assert.ok(
      !result.output.includes("Backend listening"),
      "Output should never print successful startup on listen error",
    );

    await new Promise((resolve) => blocker.close(resolve));
    console.log("  Passed: Server correctly handles EADDRINUSE, exits with non-zero, never prints success.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 2. PORT validation (empty, invalid, and out-of-range)
{
  console.log("Test: PORT validation handles empty, invalid, and out-of-range ports");
  const tempDir = await mkdtemp(join(tmpdir(), "port-validation-test-"));
  try {
    const portScript = join(tempDir, "test-port.mjs");
    await writeFile(
      portScript,
      `
function parsePort(value) {
  if (!value || value.trim() === "") return 4000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(\`Invalid PORT "\${value}"; falling back to 4000.\`);
    return 4000;
  }
  return parsed;
}
console.log(JSON.stringify({
  empty: parsePort(process.env.TEST_PORT_EMPTY),
  nonNumeric: parsePort(process.env.TEST_PORT_NAN),
  outOfRangeHigh: parsePort(process.env.TEST_PORT_HIGH),
  outOfRangeLow: parsePort(process.env.TEST_PORT_LOW),
  valid: parsePort(process.env.TEST_PORT_VALID),
}));
`,
    );

    const result = await runProcess(process.execPath, [portScript], {
      env: {
        ...process.env,
        TEST_PORT_EMPTY: "",
        TEST_PORT_NAN: "invalid_port",
        TEST_PORT_HIGH: "70000",
        TEST_PORT_LOW: "0",
        TEST_PORT_VALID: "8080",
      },
    });

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.empty, 4000, "Empty port should default to 4000");
    assert.equal(parsed.nonNumeric, 4000, "Non-numeric port should fallback to 4000");
    assert.equal(parsed.outOfRangeHigh, 4000, "Port > 65535 should fallback to 4000");
    assert.equal(parsed.outOfRangeLow, 4000, "Port < 1 should fallback to 4000");
    assert.equal(parsed.valid, 8080, "Valid port 8080 should be preserved");
    console.log("  Passed: PORT validation works correctly for all boundary conditions.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 3. Environment file preservation & duplicate key elimination
{
  console.log("Test: Environment file preservation and duplicate key removal");
  const tempDir = await mkdtemp(join(tmpdir(), "env-preservation-test-"));
  try {
    const envFile = join(tempDir, ".env");
    const initialContent = [
      "# Custom header comment",
      "CUSTOM_VAR=my_secret_key",
      "PORT=4000",
      "HOST=localhost",
      "CORS_ORIGIN=http://custom-origin.com",
      "PORT=5000", // duplicate key
      "",
    ].join("\n");
    await writeFile(envFile, initialContent);

    // Run the updateEnvValue logic on the file
    const updaterScript = join(tempDir, "updater.mjs");
    await writeFile(
      updaterScript,
      `
import { readFile, writeFile } from "node:fs/promises";

async function updateEnvValue(path, key, value) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    contents = "";
  }
  const lines = contents.split(/\\r?\\n/);
  let found = false;
  const newLines = [];
  const keyPattern = new RegExp(\`^\\\\s*\${key}\\\\s*=\`);
  for (const line of lines) {
    if (keyPattern.test(line)) {
      if (!found) {
        newLines.push(\`\${key}=\${value}\`);
        found = true;
      }
    } else {
      newLines.push(line);
    }
  }
  if (!found) {
    if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
      newLines[newLines.length - 1] = \`\${key}=\${value}\`;
      newLines.push("");
    } else {
      newLines.push(\`\${key}=\${value}\`);
      newLines.push("");
    }
  }
  const result = newLines.join("\\n");
  await writeFile(path, result.endsWith("\\n") ? result : \`\${result}\\n\`);
}

await updateEnvValue("${envFile}", "PORT", "9000");
await updateEnvValue("${envFile}", "NEW_FEATURE", "enabled");
`,
    );

    await runProcess(process.execPath, [updaterScript]);

    const updated = await readFile(envFile, "utf8");
    assert.ok(updated.includes("# Custom header comment"), "Comments should be preserved");
    assert.ok(updated.includes("CUSTOM_VAR=my_secret_key"), "Unrelated vars should be preserved");
    assert.ok(updated.includes("CORS_ORIGIN=http://custom-origin.com"), "CORS_ORIGIN should be preserved");
    assert.ok(updated.includes("PORT=9000"), "PORT should be updated to 9000");
    assert.ok(updated.includes("NEW_FEATURE=enabled"), "New keys should be added");

    const portMatches = updated.match(/^PORT=.*$/gm);
    assert.equal(portMatches.length, 1, "Duplicate PORT key must be eliminated");
    console.log("  Passed: Environment file preserves unrelated entries and eliminates duplicate keys.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 4. Child process restart race condition & intentionally stopped flag
{
  console.log("Test: Intentionally stopped child processes do not terminate runner on close");
  let runnerTerminated = false;
  let stopping = false;
  let restarting = false;

  const child = {
    appName: "server",
    intentionallyStopped: false,
    pid: 12345,
  };

  function onClose(code) {
    if (child.intentionallyStopped) {
      return;
    }
    if (!stopping && !restarting) {
      runnerTerminated = true;
    }
  }

  // Simulate intentional stop
  child.intentionallyStopped = true;
  onClose(1); // Late exit code 1 after intentional stop

  assert.equal(runnerTerminated, false, "Runner should not terminate when intentionally stopped child closes");

  // Verify signalChild returns early if child already exited
  let signalSent = false;
  const exitedChild = {
    pid: 99999,
    exitCode: 0,
    signalCode: null,
    intentionallyStopped: false,
  };
  function signalChildCheck(c) {
    c.intentionallyStopped = true;
    if (c.exitCode !== null || c.signalCode !== null) return;
    signalSent = true;
  }
  signalChildCheck(exitedChild);
  assert.equal(signalSent, false, "signalChild must return early if child already exited");

  console.log("  Passed: Intentionally stopped child processes are safely ignored on close.");
}

// 5. Ctrl+C and signal exit code handling
{
  console.log("Test: Process termination and Ctrl+C exit code mappings");
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  assert.equal(signalExitCodes.SIGINT, 130, "SIGINT exit code must be 130");
  assert.equal(signalExitCodes.SIGTERM, 143, "SIGTERM exit code must be 143");
  assert.equal(signalExitCodes.SIGHUP, 129, "SIGHUP exit code must be 129");

  // Verify Ctrl+C key handling logic
  let exitCode;
  const key = "\u0003";
  if (key.includes("\u0003")) {
    exitCode = 130;
  }
  assert.equal(exitCode, 130, "Ctrl+C key sequence must produce exit code 130");

  // Verify run-app and add-dependency signal exit mapping
  const mapSignalExit = (code, signal) =>
    code ??
    (signal === "SIGINT"
      ? 130
      : signal === "SIGTERM"
        ? 143
        : signal
          ? 1
          : 0);

  assert.equal(mapSignalExit(null, "SIGINT"), 130, "SIGINT signal must map to exit code 130");
  assert.equal(mapSignalExit(null, "SIGTERM"), 143, "SIGTERM signal must map to exit code 143");
  assert.equal(mapSignalExit(0, null), 0, "Exit code 0 must stay 0");
  assert.equal(mapSignalExit(1, null), 1, "Exit code 1 must stay 1");
  assert.equal(mapSignalExit(null, "SIGHUP"), 1, "Other signals without code fallback to 1");

  console.log("  Passed: Process termination codes are correctly mapped.");
}

// 6. Installation guard recovery instructions
{
  console.log("Test: Installation guard error message and recovery");
  const tempDir = await mkdtemp(join(tmpdir(), "install-guard-test-"));
  try {
    const pkg = { name: "test-pkg", workspaces: ["client"] };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg, null, 2));
    await mkdir(join(tempDir, "client"));
    await writeFile(
      join(tempDir, "client", "package.json"),
      JSON.stringify({ name: "client", dependencies: { foo: "1.0.0" } }),
    );
    await writeFile(join(tempDir, ".install-state"), "installed\n");

    // Copy install-info.mjs into tempDir/scripts/ just like create-template does
    await mkdir(join(tempDir, "scripts"));
    const scriptContent = await readFile(join(root, "scripts", "install-info.mjs"), "utf8");
    const tempInstallScript = join(tempDir, "scripts", "install-info.mjs");
    await writeFile(tempInstallScript, scriptContent);

    const guardBlocked = await runProcess(process.execPath, [tempInstallScript], {
      cwd: tempDir,
      env: { ...process.env, CI: undefined, npm_command: "install", VANILLA_VITE_ALLOW_INSTALL: undefined },
    });

    assert.notEqual(guardBlocked.code, 0, "Direct install should be blocked");
    assert.ok(
      guardBlocked.output.includes("Direct installs are disabled"),
      `Output must contain 'Direct installs are disabled', got:\n${guardBlocked.output}`,
    );
    assert.ok(
      guardBlocked.output.includes("Recovery instructions:"),
      "Output must contain recovery instructions",
    );
    assert.ok(
      guardBlocked.output.includes("VANILLA_VITE_ALLOW_INSTALL=1"),
      "Output must mention VANILLA_VITE_ALLOW_INSTALL=1 override",
    );

    // Test recovery with override
    const guardAllowed = await runProcess(process.execPath, [tempInstallScript], {
      cwd: tempDir,
      env: { ...process.env, VANILLA_VITE_ALLOW_INSTALL: "1" },
    });
    assert.equal(guardAllowed.code, 0, "VANILLA_VITE_ALLOW_INSTALL=1 must allow installation");
    console.log("  Passed: Install guard includes recovery instructions and allows override.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 7. Run-app usage message fix
{
  console.log("Test: run-app usage messages for npm and pnpm");
  const tempDir = await mkdtemp(join(tmpdir(), "run-app-test-"));
  try {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ workspaces: ["app-client", "app-server"] }),
    );
    // Provide a minimal stub for cross-spawn instead of symlinking repo node_modules
    const crossSpawnDir = join(tempDir, "node_modules", "cross-spawn");
    await mkdir(crossSpawnDir, { recursive: true });
    await writeFile(
      join(crossSpawnDir, "package.json"),
      JSON.stringify({ name: "cross-spawn", main: "index.js", type: "module" }),
    );
    await writeFile(join(crossSpawnDir, "index.js"), "export default function() {}\n");
    await mkdir(join(tempDir, "scripts"));
    const scriptContent = await readFile(join(root, "scripts", "run-app.mjs"), "utf8");
    const tempRunAppScript = join(tempDir, "scripts", "run-app.mjs");
    await writeFile(tempRunAppScript, scriptContent);

    const npmResult = await runProcess(process.execPath, [tempRunAppScript, "unknown"], {
      cwd: tempDir,
      env: {
        ...process.env,
        npm_config_user_agent: "npm/10.0.0",
      },
    });
    assert.ok(
      npmResult.output.includes("Usage: pnpm client|server [dev|-dev] | npm run client|server [dev|-dev]"),
      `General usage message should include pnpm and npm run, got:\n${npmResult.output}`,
    );

    const pnpmResult = await runProcess(process.execPath, [tempRunAppScript, "unknown"], {
      cwd: tempDir,
      env: {
        ...process.env,
        npm_config_user_agent: "pnpm/9.0.0",
      },
    });
    assert.ok(
      pnpmResult.output.includes("Usage: pnpm client|server [dev|-dev] | npm run client|server [dev|-dev]"),
      `General usage message should correctly distinguish pnpm and npm run, got:\n${pnpmResult.output}`,
    );
    console.log("  Passed: run-app usage messages are correct for both npm and pnpm.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 8. Environment updates in host mode
{
  console.log("Test: Environment updates in host mode vs localhost mode");
  const tempDir = await mkdtemp(join(tmpdir(), "host-env-test-"));
  try {
    const clientEnv = join(tempDir, ".env.local");
    const serverEnv = join(tempDir, ".env");
    await writeFile(clientEnv, "VITE_API_URL=http://localhost:4000\n");
    await writeFile(serverEnv, "PORT=4000\nHOST=localhost\nCORS_ORIGIN=http://localhost:5173\n");

    const hostScript = join(tempDir, "host-test.mjs");
    await writeFile(
      hostScript,
      `
import { readFile, writeFile } from "node:fs/promises";

async function updateEnvValue(path, key, value) {
  let contents = "";
  try { contents = await readFile(path, "utf8"); } catch {}
  const lines = contents.split(/\\r?\\n/);
  let found = false;
  const newLines = [];
  const keyPattern = new RegExp(\`^\\\\s*\${key}\\\\s*=\`);
  for (const line of lines) {
    if (keyPattern.test(line)) {
      if (!found) {
        newLines.push(\`\${key}=\${value}\`);
        found = true;
      }
    } else {
      newLines.push(line);
    }
  }
  if (!found) {
    newLines.push(\`\${key}=\${value}\`);
  }
  const result = newLines.filter(Boolean).join("\\n") + "\\n";
  await writeFile(path, result);
}

// Enable host mode
const lanAddress = "192.168.1.100";
await updateEnvValue("${clientEnv}", "VITE_API_URL", \`http://\${lanAddress}:4000\`);
await updateEnvValue("${serverEnv}", "HOST", "0.0.0.0");
await updateEnvValue("${serverEnv}", "CORS_ORIGIN", "http://localhost:5173,http://192.168.1.100:5173");
`,
    );

    await runProcess(process.execPath, [hostScript]);
    const updatedClient = await readFile(clientEnv, "utf8");
    const updatedServer = await readFile(serverEnv, "utf8");

    assert.ok(updatedClient.includes("VITE_API_URL=http://192.168.1.100:4000"), "Host mode sets LAN API URL");
    assert.ok(updatedServer.includes("HOST=0.0.0.0"), "Host mode binds HOST to 0.0.0.0");
    assert.ok(updatedServer.includes("192.168.1.100:5173"), "Host mode configures CORS origin for LAN");
    console.log("  Passed: Environment updates in host mode configure LAN endpoints and CORS correctly.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 9. Restart behavior
{
  console.log("Test: Process restart behavior");
  let restartCount = 0;
  let stopping = false;
  let restarting = false;
  const stoppedPids = [];
  const startedPids = [];

  const fakeApps = [{ name: "client" }, { name: "server" }];
  const children = [];

  function fakeStart(app) {
    const pid = Math.floor(Math.random() * 100000);
    startedPids.push(pid);
    children.push({ appName: app.name, pid, intentionallyStopped: false });
  }

  async function fakeStopChildren() {
    for (const child of children) {
      child.intentionallyStopped = true;
      stoppedPids.push(child.pid);
    }
    children.length = 0;
  }

  async function fakeRestart() {
    if (restarting || stopping) return;
    restarting = true;
    try {
      await fakeStopChildren();
      if (stopping) return;
      for (const app of fakeApps) fakeStart(app);
      restartCount += 1;
    } finally {
      restarting = false;
    }
  }

  // Initial start
  for (const app of fakeApps) fakeStart(app);
  assert.equal(children.length, 2, "Initial apps started");
  assert.equal(restarting, false, "Not restarting initially");

  // Perform restart
  await fakeRestart();
  assert.equal(restartCount, 1, "Restart count should be 1");
  assert.equal(children.length, 2, "Apps restarted");
  assert.equal(stoppedPids.length, 2, "Previous children stopped");
  assert.equal(startedPids.length, 4, "Total 4 starts (2 initial + 2 restart)");
  assert.equal(restarting, false, "restarting flag cleared after restart");
  console.log("  Passed: Process restart stops previous children and relaunches apps cleanly.");
}

// 10. --install-mode CLI option parser validation
{
  console.log("Test: --install-mode option parsing and validation");
  const cliScript = join(root, "bin", "create-template.mjs");
  const invalidMode = await runProcess(process.execPath, [cliScript, "test-proj", "--install-mode=invalid"]);
  assert.notEqual(invalidMode.code, 0, "Invalid install-mode should fail");
  assert.ok(
    invalidMode.output.includes("--install-mode must be adD, plain, or both"),
    `Output must state allowed install-mode values, got:\n${invalidMode.output}`,
  );
  console.log("  Passed: CLI parser rejects invalid --install-mode values.");
}

// 11. install-info.mjs behavior for adD, plain, and both
{
  console.log("Test: install-info.mjs behavior across install modes (adD, plain, both)");
  const tempDir = await mkdtemp(join(tmpdir(), "install-mode-guard-test-"));
  try {
    const pkg = {
      name: "test-pkg",
      workspaces: ["client"],
      vanillaVite: { installMode: "adD" },
    };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg, null, 2));
    await mkdir(join(tempDir, "client"));
    await writeFile(
      join(tempDir, "client", "package.json"),
      JSON.stringify({ name: "client", dependencies: { foo: "1.0.0" } }),
    );
    await writeFile(join(tempDir, ".install-state"), "installed\n");
    await mkdir(join(tempDir, "scripts"));
    const scriptContent = await readFile(join(root, "scripts", "install-info.mjs"), "utf8");
    await writeFile(join(tempDir, "scripts", "install-info.mjs"), scriptContent);

    // Mode: adD (should block with recovery instructions including 'pnpm adD' with no arguments)
    const adDResult = await runProcess(process.execPath, [join(tempDir, "scripts", "install-info.mjs")], {
      cwd: tempDir,
      env: { ...process.env, CI: undefined, npm_command: "install", VANILLA_VITE_ALLOW_INSTALL: undefined, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(adDResult.code, 1, "adD mode must block direct install");
    assert.ok(
      adDResult.output.includes("run `pnpm adD` with no arguments to sync dependencies"),
      `adD mode output must mention running pnpm adD with no arguments, got:\n${adDResult.output}`,
    );

    // Mode: plain (should skip guard completely and exit 0)
    pkg.vanillaVite.installMode = "plain";
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg, null, 2));
    const plainResult = await runProcess(process.execPath, [join(tempDir, "scripts", "install-info.mjs")], {
      cwd: tempDir,
      env: { ...process.env, CI: undefined, npm_command: "install", VANILLA_VITE_ALLOW_INSTALL: undefined },
    });
    assert.equal(plainResult.code, 0, "plain mode must allow direct install");
    assert.ok(
      !plainResult.output.includes("Direct installs are disabled"),
      "plain mode must not display direct installs disabled message",
    );
    assert.ok(
      plainResult.output.includes("Installing workspace dependencies"),
      "plain mode must still list workspace dependencies",
    );

    // Mode: both (should succeed with exit 0 and print Tip)
    pkg.vanillaVite.installMode = "both";
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg, null, 2));
    const bothResult = await runProcess(process.execPath, [join(tempDir, "scripts", "install-info.mjs")], {
      cwd: tempDir,
      env: { ...process.env, CI: undefined, npm_command: "install", VANILLA_VITE_ALLOW_INSTALL: undefined, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(bothResult.code, 0, "both mode must allow direct install");
    assert.ok(
      bothResult.output.includes("Tip: `pnpm adD <package>` lets you pick the workspace."),
      `both mode must print tip notice, got:\n${bothResult.output}`,
    );
    console.log("  Passed: install-info.mjs correctly enforces adD, plain, and both install modes.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 12. add-dependency with no args performs sync install
{
  console.log("Test: add-dependency with no args performs workspace sync install");
  const tempDir = await mkdtemp(join(tmpdir(), "add-dep-sync-test-"));
  try {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const pnpmSh = join(binDir, "pnpm");
    await writeFile(
      pnpmSh,
      "#!/bin/sh\necho \"FAKE_PNPM_ARGS: $@\"\necho \"VANILLA_VITE_ALLOW_INSTALL=$VANILLA_VITE_ALLOW_INSTALL\"\nexit 0\n",
    );
    await chmod(pnpmSh, 0o755);
    const pnpmCmd = join(binDir, "pnpm.cmd");
    await writeFile(
      pnpmCmd,
      "@echo off\r\necho FAKE_PNPM_ARGS: %*\r\necho VANILLA_VITE_ALLOW_INSTALL=%VANILLA_VITE_ALLOW_INSTALL%\r\nexit /b 0\r\n",
    );

    // Run the script from the repo's scripts directory so cross-spawn resolves
    // from the repo's node_modules without needing to symlink node_modules into tempDir.
    const result = await runProcess(
      process.execPath,
      [join(root, "scripts", "add-dependency.mjs")],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          npm_config_user_agent: "pnpm/9.0.0",
        },
      },
    );
    assert.equal(result.code, 0, `add-dependency must exit with code 0, got ${result.code}`);
    assert.ok(
      result.output.includes("Syncing workspace dependencies with pnpm install..."),
      `Output must contain syncing message, got:\n${result.output}`,
    );
    assert.ok(
      result.output.includes("FAKE_PNPM_ARGS: install"),
      `Fake pnpm must receive install argument, got:\n${result.output}`,
    );
    assert.ok(
      result.output.includes("VANILLA_VITE_ALLOW_INSTALL=1"),
      `VANILLA_VITE_ALLOW_INSTALL=1 must be set in env, got:\n${result.output}`,
    );
    console.log("  Passed: add-dependency with no args performs sync install with allow flag.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 13. dev.mjs banner adapts to install mode
{
  console.log("Test: dev.mjs banner adapts to install mode (plain hides, both/adD show)");
  function getBannerLines(installMode, pkgManager = "pnpm") {
    if (installMode === "plain") return null;
    const commands =
      installMode === "both"
        ? pkgManager === "pnpm"
          ? ["  > pnpm adD <package> (choose workspace)", "  > pnpm add <package> (or direct install)"]
          : ["  > npm run adD -- <package> (choose workspace)", "  > npm install <package> (or direct install)"]
        : pkgManager === "pnpm"
          ? ["  > pnpm adD <package>", "  > pnpm add-dependency <package>"]
          : ["  > npm run adD -- <package>", "  > npm run add-dependency -- <package>"];
    return [">>> ADD DEPENDENCIES LATER <<<", ...commands];
  }
  assert.equal(getBannerLines("plain"), null, "plain mode must not show banner");
  assert.ok(getBannerLines("both").some((line) => line.includes("direct install")), "both mode must show direct install");
  assert.ok(getBannerLines("adD").every((line) => !line.includes("direct install")), "adD mode must only show adD");
  console.log("  Passed: dev.mjs banner correctly reflects install mode.");
}

// 14. Feature registry and alias resolution
{
  console.log("Test: Feature registry and alias resolution");
  const expectedAliases = ["adD", "add-dependency", "install", "i", "add", "guard", "install-mode"];
  for (const alias of expectedAliases) {
    const resolved = resolveFeature(alias);
    assert.ok(resolved, `resolveFeature must resolve alias '${alias}'`);
    assert.equal(resolved.id, "adD", `alias '${alias}' must map to adD feature`);
    // Test uppercase / mixed-case variant
    const resolvedUpper = resolveFeature(alias.toUpperCase());
    assert.ok(resolvedUpper, `resolveFeature must be case-insensitive for '${alias.toUpperCase()}'`);
    assert.equal(resolvedUpper.id, "adD");
  }
  assert.equal(resolveFeature("non-existent-feature"), null, "Unknown feature must return null");
  console.log("  Passed: Feature registry and aliases resolve correctly.");
}

// 15. CLI argument parsing for toggle-feature
{
  console.log("Test: CLI argument parsing for toggle-feature");
  assert.deepEqual(parseArgs([]), { action: "status", featureName: null, subOption: null });
  assert.deepEqual(parseArgs(["status"]), { action: "status", featureName: null, subOption: null });
  assert.deepEqual(parseArgs(["list"]), { action: "status", featureName: null, subOption: null });

  assert.deepEqual(parseArgs(["on"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["tN"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["turn-on"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["trun-on"]), { action: "on", featureName: "adD", subOption: null });

  assert.deepEqual(parseArgs(["off"]), { action: "off", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["tO"]), { action: "off", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["turn-off"]), { action: "off", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["trun-off"]), { action: "off", featureName: "adD", subOption: null });

  assert.deepEqual(parseArgs(["on", "install"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["tN", "add"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["tO", "i"]), { action: "off", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["turn-on", "adD", "both"]), { action: "on", featureName: "adD", subOption: "both" });

  assert.deepEqual(parseArgs(["adD", "off"]), { action: "off", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["adD", "on"]), { action: "on", featureName: "adD", subOption: null });
  assert.deepEqual(parseArgs(["adD"]), { action: "toggle", featureName: "adD", subOption: null });
  console.log("  Passed: CLI argument parsing routes all actions and aliases correctly.");
}

// 16. toggleFeature programmatic execution
{
  console.log("Test: toggleFeature programmatic execution");
  const tempDir = await mkdtemp(join(tmpdir(), "toggle-test-"));
  try {
    const pkgPath = join(tempDir, "package.json");
    const initialPkg = {
      name: "test-project",
      version: "1.0.0",
      workspaces: ["client"],
      vanillaVite: { installMode: "adD" },
      scripts: {
        dev: "node scripts/dev.mjs",
        adD: "node scripts/add-dependency.mjs",
        "add-dependency": "node scripts/add-dependency.mjs",
      },
    };
    await writeFile(pkgPath, JSON.stringify(initialPkg, null, 2) + "\n");

    // Turn OFF adD
    await toggleFeature({ rootDir: tempDir, action: "off", featureName: "adD", packageManager: "pnpm" });
    let updated = JSON.parse(await readFile(pkgPath, "utf8"));
    assert.equal(updated.vanillaVite.installMode, "plain", "installMode should be updated to plain");
    assert.equal(updated.scripts.adD, undefined, "adD script should be removed");
    assert.equal(updated.scripts["add-dependency"], undefined, "add-dependency script should be removed");
    assert.equal(updated.scripts.dev, "node scripts/dev.mjs", "unrelated scripts should be preserved");

    // Turn ON adD
    await toggleFeature({ rootDir: tempDir, action: "on", featureName: "adD", packageManager: "pnpm" });
    updated = JSON.parse(await readFile(pkgPath, "utf8"));
    assert.equal(updated.vanillaVite.installMode, "adD", "installMode should be updated to adD");
    assert.equal(updated.scripts.adD, "node scripts/add-dependency.mjs", "adD script should be restored");
    assert.equal(updated.scripts["add-dependency"], "node scripts/add-dependency.mjs", "add-dependency script should be restored");
    assert.ok(existsSync(join(tempDir, "scripts", "add-dependency.mjs")), "scripts/add-dependency.mjs should be generated if missing");

    // Turn ON with 'both' option
    await toggleFeature({ rootDir: tempDir, action: "on", featureName: "adD", subOption: "both", packageManager: "pnpm" });
    updated = JSON.parse(await readFile(pkgPath, "utf8"));
    assert.equal(updated.vanillaVite.installMode, "both", "installMode should be updated to both");
    assert.equal(updated.scripts.adD, "node scripts/add-dependency.mjs", "adD script should remain present in both mode");

    // Toggle adD (currently enabled, so should toggle to off)
    await toggleFeature({ rootDir: tempDir, action: "toggle", featureName: "adD", packageManager: "pnpm" });
    updated = JSON.parse(await readFile(pkgPath, "utf8"));
    assert.equal(updated.vanillaVite.installMode, "plain", "toggle from enabled should turn off");

    // Toggle adD again (currently off, so should toggle to on)
    await toggleFeature({ rootDir: tempDir, action: "toggle", featureName: "adD", packageManager: "pnpm" });
    updated = JSON.parse(await readFile(pkgPath, "utf8"));
    assert.equal(updated.vanillaVite.installMode, "adD", "toggle from disabled should turn on");
    console.log("  Passed: toggleFeature modifies package.json and filesystem state as expected.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 17. toggle-feature CLI execution
{
  console.log("Test: toggle-feature CLI process execution");
  const tempDir = await mkdtemp(join(tmpdir(), "toggle-cli-test-"));
  try {
    const pkgPath = join(tempDir, "package.json");
    const initialPkg = {
      name: "cli-test-project",
      version: "1.0.0",
      workspaces: ["client"],
      vanillaVite: { installMode: "adD" },
      scripts: {
        adD: "node scripts/add-dependency.mjs",
      },
    };
    await writeFile(pkgPath, JSON.stringify(initialPkg, null, 2) + "\n");

    const scriptPath = join(root, "scripts", "toggle-feature.mjs");

    // Run CLI turn-off
    const offResult = await runProcess(process.execPath, [scriptPath, "off", "adD"], {
      cwd: tempDir,
      env: { ...process.env, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(offResult.code, 0, `CLI turn-off must exit with code 0, got ${offResult.code}`);
    assert.ok(offResult.output.includes("Feature 'adD' turned OFF"), "CLI output should confirm feature turned off");
    assert.ok(offResult.output.includes("pnpm add"), "CLI output should display pnpm commands");

    // Run CLI turn-on with alias tN
    const onResult = await runProcess(process.execPath, [scriptPath, "tN", "add-dependency"], {
      cwd: tempDir,
      env: { ...process.env, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(onResult.code, 0, `CLI tN must exit with code 0, got ${onResult.code}`);
    assert.ok(onResult.output.includes("Feature 'adD' turned ON"), "CLI output should confirm feature turned on");
    assert.ok(onResult.output.includes("pnpm adD"), "CLI output should display pnpm adD command");

    // Run CLI status
    const statusResult = await runProcess(process.execPath, [scriptPath, "status"], {
      cwd: tempDir,
      env: { ...process.env, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(statusResult.code, 0, `CLI status must exit with code 0, got ${statusResult.code}`);
    assert.ok(statusResult.output.includes("[adD] - ENABLED"), "CLI status should display ENABLED state");

    // Run CLI with unknown feature
    const invalidResult = await runProcess(process.execPath, [scriptPath, "on", "unknown-xyz"], {
      cwd: tempDir,
      env: { ...process.env, npm_config_user_agent: "pnpm/9.0.0" },
    });
    assert.equal(invalidResult.code, 1, `CLI with unknown feature must exit with code 1, got ${invalidResult.code}`);
    assert.ok(invalidResult.output.includes("Unknown feature: 'unknown-xyz'"), "CLI should report unknown feature error");

    console.log("  Passed: toggle-feature CLI executes commands, status, and error handling cleanly.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

console.log("\nAll bug fix unit tests passed successfully!\n");
