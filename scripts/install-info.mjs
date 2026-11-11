import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const installStatePath = join(root, ".install-state");
if (process.argv.includes("--complete")) {
  await writeFile(installStatePath, "installed\n");
  process.exit(0);
}
const workspaces = await Promise.all(
  project.workspaces.map(async (workspace) => ({
    path: join(root, workspace),
    manifest: JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8")),
  })),
);
const declaredDependencies = [
  ...Object.keys(project.dependencies ?? {}),
  ...Object.keys(project.devDependencies ?? {}),
  ...workspaces.flatMap(({ manifest }) => [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]),
];
const hasInstalledDependencies = declaredDependencies.some(
  (dependency) =>
    existsSync(join(root, "node_modules", dependency)) ||
    workspaces.some(({ path }) => existsSync(join(path, "node_modules", dependency))),
);
let installState;
try {
  installState = (await readFile(installStatePath, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const freshInstall = installState === undefined && process.env.npm_command === "install";

if (
  process.env.VANILLA_VITE_ALLOW_INSTALL !== "1" &&
  process.env.CI === undefined &&
  process.env.npm_command !== "ci" &&
  !freshInstall &&
  (installState === "installing" || installState === "installed" || hasInstalledDependencies)
) {
  console.error(
    "\nDirect installs are disabled to keep dependencies in the intended workspace.\n" +
      "Use `pnpm adD <package>` or `pnpm add-dependency <package>`; with npm, use `npm run adD -- <package>` or `npm run add-dependency -- <package>`.\n" +
      "The adD commands are the supported way to add packages.",
  );
  process.exit(1);
}

if (
  process.env.VANILLA_VITE_ALLOW_INSTALL === "1" ||
  process.env.CI !== undefined ||
  process.env.npm_command === "ci" ||
  freshInstall
) {
  await writeFile(installStatePath, "installing\n");
}

console.log("Installing workspace dependencies:");
for (const { path, manifest } of workspaces) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  console.log(`\n${manifest.name} (${relative(root, path)}):`);
  if (!Object.keys(dependencies).length) {
    console.log("  No dependencies declared.");
    continue;
  }
  for (const [name, version] of Object.entries(dependencies)) {
    console.log(`  - ${name}@${version}`);
  }
}
