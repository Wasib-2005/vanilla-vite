import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (process.env.VANILLA_VITE_ALLOW_INSTALL !== "1") {
  console.error(
    "\nDirect installs are disabled to keep dependencies in the intended workspace.\n" +
      "Use `pnpm adD <package>` or `pnpm add-dependency <package>`; with npm, use `npm run adD -- <package>` or `npm run add-dependency -- <package>`.",
  );
  process.exit(1);
}

console.log("Installing workspace dependencies:");
for (const workspace of project.workspaces) {
  const manifest = JSON.parse(
    await readFile(join(root, workspace, "package.json"), "utf8"),
  );
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  console.log(`\n${manifest.name} (${workspace}):`);
  if (!Object.keys(dependencies).length) {
    console.log("  No dependencies declared.");
    continue;
  }
  for (const [name, version] of Object.entries(dependencies)) {
    console.log(`  - ${name}@${version}`);
  }
}
