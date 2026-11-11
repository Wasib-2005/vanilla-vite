import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import spawn from "cross-spawn";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packages = process.argv.slice(2);

if (packages.length === 0) {
  console.error(
    "Usage: pnpm adD|add-dependency <package...> | npm run adD|add-dependency -- <package...>",
  );
  process.exit(1);
}

if (!stdin.isTTY) {
  console.error("Choose an install location in an interactive terminal.");
  process.exit(1);
}

const targets = [
  { label: `Project root (${project.name})`, workspace: null },
  ...project.workspaces.map((workspace) => ({
    label: workspace,
    workspace,
  })),
];

const defaultIndex = Math.max(
  0,
  targets.findIndex((target) => target.workspace?.endsWith("-client")),
);
let selectedIndex = defaultIndex;
emitKeypressEvents(stdin);

const selectedTarget = await new Promise((resolveSelection) => {
  function render() {
    const question = "Where should the package be installed?";
    const prompt = stdout.isTTY && process.env.NO_COLOR === undefined
      ? `\x1b[1;36m${question}\x1b[0m`
      : question;
    stdout.write(`\r\x1b[2K${prompt}\n`);
    targets.forEach((target, index) => {
      stdout.write(`  ${index === selectedIndex ? "❯" : " "} ${target.label}\n`);
    });
    stdout.write("  Use ↑/↓ to select, Enter to confirm, or Esc to keep the default.\n");
    stdout.write(`\x1b[${targets.length + 2}A`);
  }

  function finish(target) {
    stdin.off("keypress", onKeypress);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`\x1b[${targets.length + 2}B\n`);
    resolveSelection(target);
  }

  function onKeypress(_input, key) {
    if (key?.name === "up" || key?.name === "down") {
      selectedIndex =
        (selectedIndex + (key.name === "down" ? 1 : targets.length - 1)) %
        targets.length;
      render();
    } else if (key?.name === "return") finish(targets[selectedIndex]);
    else if (key?.name === "escape") finish(targets[defaultIndex]);
    else if (key?.ctrl && key.name === "c") {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolveSelection(null);
    }
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("keypress", onKeypress);
  render();
});

if (!selectedTarget) {
  process.exit(130);
}

const packageManager = process.env.npm_config_user_agent?.startsWith("pnpm/")
  ? "pnpm"
  : "npm";
const { workspace } = selectedTarget;
const commandArgs =
  packageManager === "pnpm"
    ? workspace
      ? ["--filter", workspace, "add", ...packages]
      : ["add", "--workspace-root", ...packages]
    : workspace
      ? ["install", ...packages, "--workspace", workspace]
      : ["install", ...packages];
const child = spawn(packageManager, commandArgs, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VANILLA_VITE_ALLOW_INSTALL: "1" },
});

child.once("error", (error) => {
  console.error(`Unable to run ${packageManager}: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
