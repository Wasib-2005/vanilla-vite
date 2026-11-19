import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const ADD_DEPENDENCY_TEMPLATE = `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import spawn from "cross-spawn";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packages = process.argv.slice(2);
const packageManager = process.env.npm_config_user_agent?.startsWith("pnpm/")
  ? "pnpm"
  : "npm";

if (packages.length === 0) {
  console.log(\`Syncing workspace dependencies with \${packageManager} install...\`);
  const child = spawn(packageManager, ["install"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VANILLA_VITE_ALLOW_INSTALL: "1" },
  });
  child.once("error", (error) => {
    console.error(\`Unable to run \${packageManager}: \${error.message}\`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode =
      code ??
      (signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : signal
            ? 1
            : 0);
  });
  await new Promise((resolve) => child.once("close", resolve));
  process.exit(process.exitCode ?? 0);
}

if (!stdin.isTTY) {
  console.error("Choose an install location in an interactive terminal.");
  process.exit(1);
}

const targets = [
  { label: \`Project root (\${project.name})\`, workspace: null },
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
      ? \`\\x1b[1;36m\${question}\\x1b[0m\`
      : question;
    stdout.write(\`\\r\\x1b[2K\${prompt}\\n\`);
    targets.forEach((target, index) => {
      stdout.write(\`  \${index === selectedIndex ? ">" : " "} \${target.label}\\n\`);
    });
    stdout.write("  Use ↑/↓ to select, Enter to confirm, or Esc to keep the default.\\n");
    stdout.write(\`\\x1b[\${targets.length + 2}A\`);
  }

  function finish(target) {
    stdin.off("keypress", onKeypress);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(\`\\x1b[\${targets.length + 2}B\\n\`);
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
      stdout.write("\\n");
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
  console.error(\`Unable to run \${packageManager}: \${error.message}\`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    code ??
    (signal === "SIGINT"
      ? 130
      : signal === "SIGTERM"
        ? 143
        : signal
          ? 1
          : 0);
});
`;

export const FEATURES = {
  adD: {
    id: "adD",
    name: "adD",
    description: "Workspace dependency selector and direct install guard",
    aliases: ["add", "add-dependency", "install", "i", "guard", "install-mode"],
    isEnabled(project) {
      return (project.vanillaVite?.installMode ?? "adD") !== "plain";
    },
    getStatus(project) {
      const mode = project.vanillaVite?.installMode ?? "adD";
      const hasScript = Boolean(project.scripts?.adD);
      return {
        enabled: mode !== "plain",
        mode,
        hasScript,
      };
    },
    async turnOn({ rootDir, project, subOption, packageManager }) {
      const targetMode = subOption === "both" || subOption === "--both" ? "both" : "adD";
      project.vanillaVite = project.vanillaVite ?? {};
      project.vanillaVite.installMode = targetMode;

      project.scripts = project.scripts ?? {};
      project.scripts.adD = "node scripts/add-dependency.mjs";
      project.scripts["add-dependency"] = "node scripts/add-dependency.mjs";

      const scriptsDir = join(rootDir, "scripts");
      await mkdir(scriptsDir, { recursive: true });
      const scriptPath = join(scriptsDir, "add-dependency.mjs");
      if (!existsSync(scriptPath)) {
        await writeFile(scriptPath, ADD_DEPENDENCY_TEMPLATE, "utf8");
      }

      await writeFile(
        join(rootDir, "package.json"),
        `${JSON.stringify(project, null, 2)}\n`,
        "utf8",
      );

      const isPnpm = packageManager === "pnpm";
      const addCmd = isPnpm ? "pnpm adD <package>" : "npm run adD -- <package>";
      const addDepCmd = isPnpm
        ? "pnpm add-dependency <package>"
        : "npm run add-dependency -- <package>";
      const turnOffCmd = isPnpm ? "pnpm tO adD" : "npm run tO -- adD";

      console.log(`[feature] Feature 'adD' turned ON (mode: ${targetMode}).`);
      console.log(`  - Scripts enabled: ${addCmd}, ${addDepCmd}`);
      if (targetMode === "both") {
        console.log("  - Direct installs also permitted alongside adD.");
      } else {
        console.log("  - Direct root installs are guarded to preserve monorepo workspace structure.");
      }
      console.log("  - Development runner banner '>>> ADD DEPENDENCIES LATER <<<' is active.");
      console.log(`  To turn off: ${turnOffCmd}\n`);
    },
    async turnOff({ rootDir, project, packageManager }) {
      project.vanillaVite = project.vanillaVite ?? {};
      project.vanillaVite.installMode = "plain";

      if (project.scripts) {
        delete project.scripts.adD;
        delete project.scripts["add-dependency"];
      }

      await writeFile(
        join(rootDir, "package.json"),
        `${JSON.stringify(project, null, 2)}\n`,
        "utf8",
      );

      const isPnpm = packageManager === "pnpm";
      const directInstall = isPnpm ? "pnpm add <package>" : "npm install <package>";
      const turnOnCmd = isPnpm ? "pnpm tN adD" : "npm run tN -- adD";

      console.log("[feature] Feature 'adD' turned OFF (mode: plain).");
      console.log(`  - Direct installs enabled: ${directInstall}`);
      console.log("  - Removed 'adD' and 'add-dependency' scripts.");
      console.log("  - Development runner banner '>>> ADD DEPENDENCIES LATER <<<' is hidden.");
      console.log(`  To turn on: ${turnOnCmd}\n`);
    },
  },
};

export function resolveFeature(featureInput) {
  if (!featureInput) return null;
  const normalized = featureInput.trim().toLowerCase();
  for (const feature of Object.values(FEATURES)) {
    if (feature.id.toLowerCase() === normalized) return feature;
    if (feature.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return feature;
    }
  }
  return null;
}

const ACTION_ON_ALIASES = new Set(["on", "turn-on", "trun-on", "tn", "enable", "1", "true"]);
const ACTION_OFF_ALIASES = new Set(["off", "turn-off", "trun-off", "to", "disable", "0", "false"]);
const ACTION_STATUS_ALIASES = new Set(["status", "list", "info", "-s", "--status", "-l", "--list"]);
const ACTION_TOGGLE_ALIASES = new Set(["toggle", "t"]);

export function parseArgs(rawArgs) {
  if (!rawArgs || rawArgs.length === 0) {
    return { action: "status", featureName: null, subOption: null };
  }

  const normalizeFeature = (input) => {
    if (!input) return "adD";
    const matched = resolveFeature(input);
    return matched ? matched.id : input;
  };

  const first = rawArgs[0].toLowerCase();

  if (ACTION_STATUS_ALIASES.has(first)) {
    return {
      action: "status",
      featureName: rawArgs[1] ? normalizeFeature(rawArgs[1]) : null,
      subOption: rawArgs[2] ?? null,
    };
  }

  if (ACTION_ON_ALIASES.has(first)) {
    return {
      action: "on",
      featureName: normalizeFeature(rawArgs[1]),
      subOption: rawArgs[2] ?? null,
    };
  }

  if (ACTION_OFF_ALIASES.has(first)) {
    return {
      action: "off",
      featureName: normalizeFeature(rawArgs[1]),
      subOption: rawArgs[2] ?? null,
    };
  }

  if (ACTION_TOGGLE_ALIASES.has(first)) {
    return {
      action: "toggle",
      featureName: normalizeFeature(rawArgs[1]),
      subOption: rawArgs[2] ?? null,
    };
  }

  // Check if first argument is a feature identifier or alias
  const matchedFeature = resolveFeature(first);
  if (matchedFeature) {
    const second = rawArgs[1]?.toLowerCase();
    if (!second || ACTION_TOGGLE_ALIASES.has(second)) {
      return { action: "toggle", featureName: matchedFeature.id, subOption: rawArgs[2] ?? null };
    }
    if (ACTION_ON_ALIASES.has(second)) {
      return { action: "on", featureName: matchedFeature.id, subOption: rawArgs[2] ?? null };
    }
    if (ACTION_OFF_ALIASES.has(second)) {
      return { action: "off", featureName: matchedFeature.id, subOption: rawArgs[2] ?? null };
    }
    if (ACTION_STATUS_ALIASES.has(second)) {
      return { action: "status", featureName: matchedFeature.id, subOption: rawArgs[2] ?? null };
    }
    return { action: second, featureName: matchedFeature.id, subOption: rawArgs[2] ?? null };
  }

  return {
    action: rawArgs[0],
    featureName: rawArgs[1] ? normalizeFeature(rawArgs[1]) : null,
    subOption: rawArgs[2] ?? null,
  };
}

export async function toggleFeature({
  rootDir = root,
  action,
  featureName,
  subOption,
  packageManager = process.env.npm_config_user_agent?.startsWith("pnpm/") ? "pnpm" : "npm",
}) {
  const packagePath = join(rootDir, "package.json");
  let project;
  try {
    project = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    console.error(`Unable to read package.json at ${packagePath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (action === "status") {
    printStatus(project, packageManager);
    return;
  }

  const targetName = featureName ?? "adD";
  const feature = resolveFeature(targetName);
  if (!feature) {
    console.error(`Unknown feature: '${targetName}'.`);
    console.error("Available features:");
    for (const f of Object.values(FEATURES)) {
      console.error(`  - ${f.name} (aliases: ${f.aliases.join(", ")})`);
    }
    process.exitCode = 1;
    return;
  }

  let finalAction = action;
  if (finalAction === "toggle") {
    finalAction = feature.isEnabled(project) ? "off" : "on";
  }

  if (finalAction === "on") {
    await feature.turnOn({ rootDir, project, subOption, packageManager });
  } else if (finalAction === "off") {
    await feature.turnOff({ rootDir, project, packageManager });
  } else {
    console.error(`Invalid action '${action}'. Use 'on' or 'off'.`);
    process.exitCode = 1;
  }
}

function printStatus(project, packageManager) {
  const isPnpm = packageManager === "pnpm";
  console.log("Vanilla Vite Project Features:");
  for (const feature of Object.values(FEATURES)) {
    const status = feature.getStatus(project);
    const stateStr = status.enabled ? "ENABLED" : "DISABLED";
    console.log(`\n  [${feature.name}] - ${stateStr}`);
    console.log(`    Description: ${feature.description}`);
    console.log(`    Mode: ${status.mode}`);
    console.log(`    Aliases: ${feature.aliases.join(", ")}`);
    if (isPnpm) {
      console.log(`    Turn on:  pnpm tN ${feature.name}`);
      console.log(`    Turn off: pnpm tO ${feature.name}`);
    } else {
      console.log(`    Turn on:  npm run tN -- ${feature.name}`);
      console.log(`    Turn off: npm run tO -- ${feature.name}`);
    }
  }
  console.log("");
}

export async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  await toggleFeature({
    rootDir: root,
    action: parsed.action,
    featureName: parsed.featureName,
    subOption: parsed.subOption,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Feature toggle error: ${error.message}`);
    process.exit(1);
  });
}
