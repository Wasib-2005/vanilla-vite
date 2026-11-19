#!/usr/bin/env node

import spawn from "cross-spawn";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(version) {
  if (typeof version !== "string") {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  const clean = version.startsWith("v") ? version.slice(1) : version;
  const match = SEMVER_REGEX.exec(clean);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  const prerelease = match[4]?.split(".") ?? [];
  return {
    version: clean,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const component of ["major", "minor", "patch"]) {
    if (a[component] !== b[component]) {
      return a[component] < b[component] ? -1 : 1;
    }
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
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

export function getDistTag(version) {
  const parsed = parseSemver(version);
  if (parsed.prerelease.length === 0) return "latest";
  const firstAlpha = parsed.prerelease.find((part) => /[a-zA-Z]/.test(part));
  if (firstAlpha) {
    const cleaned = firstAlpha.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (cleaned) return cleaned;
  }
  return "next";
}

export function checkRootExecution(env = process.env) {
  if (env.ALLOW_ROOT_PUBLISH === "1") return false;
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  return false;
}

export async function fetchRegistryPackage(packageName, registryUrl = "https://registry.npmjs.org") {
  const cleanUrl = registryUrl.replace(/\/$/, "");
  const response = await fetch(`${cleanUrl}/${packageName}`, {
    signal: AbortSignal.timeout(6000),
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return { latest: "none", versions: [] };
  }
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  const data = await response.json();
  const latest = data["dist-tags"]?.latest ?? "none";
  const versions = Object.keys(data.versions ?? {});
  return { latest, versions, distTags: data["dist-tags"] ?? {} };
}

export function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdoutOutput = "";
    let stderrOutput = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutOutput += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrOutput += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutOutput, stderr: stderrOutput });
      } else {
        const error = new Error(`${command} ${args.join(" ")} exited with code ${code}`);
        error.code = code;
        error.stdout = stdoutOutput;
        error.stderr = stderrOutput;
        reject(error);
      }
    });
  });
}

export async function checkNpmAuth(registryUrl) {
  if (process.env.MOCK_NPM_AUTH === "1") return true;
  if (process.env.MOCK_NPM_AUTH === "0") return false;
  try {
    const args = ["whoami"];
    if (registryUrl) args.push(`--registry=${registryUrl}`);
    const result = await execCommand("npm", args, { timeout: 10_000 });
    return Boolean(result.stdout?.trim());
  } catch {
    return false;
  }
}

export async function runValidationChecks() {
  if (process.env.SKIP_TESTS === "1") return true;
  console.log("\nRunning validation checks (smoke test suite)...");
  const timeout = process.env.VPUBLISH_TEST_TIMEOUT_MS
    ? Number(process.env.VPUBLISH_TEST_TIMEOUT_MS)
    : 20 * 60 * 1000;
  try {
    await execCommand("pnpm", ["run", "test:smoke", "--", "--quick"], {
      cwd: root,
      timeout,
    });
    return true;
  } catch (error) {
    console.error("Validation checks failed:\n", error.stderr || error.stdout || error.message);
    return false;
  }
}

export function hasChangelogEntry(changelogContent, version) {
  if (!changelogContent) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^##\\s+\\[?${escaped}(\\]|\\s|$)`, "m");
  return pattern.test(changelogContent);
}

export async function updatePackageVersion(newVersion, changelogEntries = []) {
  const pkgPath = join(root, "package.json");
  const pkgContent = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgContent);
  pkg.version = newVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const changelogPath = join(root, "CHANGELOG.md");
  try {
    let changelog = await readFile(changelogPath, "utf8");
    if (!hasChangelogEntry(changelog, newVersion)) {
      const today = new Date().toISOString().split("T")[0];
      const items =
        changelogEntries.length > 0
          ? changelogEntries
              .map((entry) => (entry.startsWith("- ") || entry.startsWith("* ") ? entry : `- ${entry}`))
              .join("\n")
          : `- Release version ${newVersion}.`;
      const newEntry = `## ${newVersion} - ${today}\n\n${items}\n\n`;
      const headerIndex = changelog.indexOf("\n\n");
      if (headerIndex !== -1) {
        changelog = changelog.slice(0, headerIndex + 2) + newEntry + changelog.slice(headerIndex + 2);
      } else {
        changelog = `# Changelog\n\n${newEntry}${changelog}`;
      }
      await writeFile(changelogPath, changelog);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function publishPackage(distTag, dryRun = false) {
  const publishArgs = [
    "publish",
    "--access",
    "public",
    "--tag",
    distTag,
    "--no-git-checks",
  ];
  if (dryRun) publishArgs.push("--dry-run");

  console.log(`\nExecuting: pnpm ${publishArgs.join(" ")}`);
  if (process.env.MOCK_PUBLISH === "fail") {
    throw new Error("Mock publish failed");
  }
  if (process.env.MOCK_PUBLISH === "1" || dryRun) {
    console.log("[Dry-run/mock] Package published successfully.");
    return { code: 0 };
  }
  return execCommand("pnpm", publishArgs, { cwd: root, stdio: "inherit" });
}

export async function main(cliArgs = process.argv.slice(2)) {
  const allowRoot = cliArgs.includes("--allow-root");
  const allowDowngrade = cliArgs.includes("--allow-downgrade") || process.env.ALLOW_DOWNGRADE === "1";
  const dryRun = cliArgs.includes("--dry-run");
  const autoConfirm = cliArgs.includes("-y") || cliArgs.includes("--yes");
  const skipTests = cliArgs.includes("--skip-tests") || process.env.SKIP_TESTS === "1";

  if (!allowRoot && checkRootExecution()) {
    console.error(
      "\nRefusing to run publishing operations as root.\n" +
        "Publishing packages with root privileges is unsafe.\n" +
        "Please run this command as your normal user.\n" +
        "If root execution is strictly required, pass --allow-root or set ALLOW_ROOT_PUBLISH=1.\n",
    );
    process.exit(1);
  }

  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    console.error(`Unable to read package.json: ${error.message}`);
    process.exit(1);
  }

  if (pkg.name !== "create-vanilla-vite") {
    console.error(`Unexpected package name: expected "create-vanilla-vite", found "${pkg.name}".`);
    process.exit(1);
  }

  const localVersion = pkg.version;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/$/, "");

  let registryData;
  try {
    registryData = await fetchRegistryPackage(pkg.name, registry);
  } catch (error) {
    console.error(`Failed to retrieve version information from npm registry: ${error.message}`);
    process.exit(1);
  }

  const latestPublished = registryData.latest;
  const positionalArgs = [];
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === "--changelog") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }
  let requestedVersion = positionalArgs[0];

  if (!requestedVersion) {
    console.log("Vanilla-Vite Version Manager\n");
    console.log(`Latest npm version: ${latestPublished}`);
    console.log(`Local repository version: ${localVersion}\n`);

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      requestedVersion = (await rl.question("Enter the new version: ")).trim();
    } catch {
      requestedVersion = "";
    } finally {
      rl.close();
    }
  }

  if (!requestedVersion) {
    console.error("Error: A target version is required.");
    process.exit(1);
  }

  if (requestedVersion.startsWith("v")) {
    requestedVersion = requestedVersion.slice(1);
  }

  try {
    parseSemver(requestedVersion);
  } catch (error) {
    console.error(`\nVersion validation failed: "${requestedVersion}" is not a valid semantic version.`);
    console.error("Examples of valid versions: 1.0.5, 1.1.0, 1.2.0-beta.1");
    process.exit(1);
  }

  if (registryData.versions.includes(requestedVersion)) {
    console.error(`\nError: Version ${requestedVersion} has already been published to the npm registry.`);
    console.error("Choose a higher or prerelease version.");
    process.exit(1);
  }

  if (latestPublished !== "none") {
    const cmp = compareSemver(requestedVersion, latestPublished);
    if (cmp < 0 && !allowDowngrade) {
      console.error(
        `\nError: Requested version ${requestedVersion} is a downgrade relative to the latest published version ${latestPublished}.\n` +
          "Downgrades are rejected by default. To override, provide --allow-downgrade or set ALLOW_DOWNGRADE=1.",
      );
      process.exit(1);
    }
  }

  const distTag = getDistTag(requestedVersion);

  const changelogPath = join(root, "CHANGELOG.md");
  let changelogContent = "";
  try {
    changelogContent = await readFile(changelogPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const changelogExists = hasChangelogEntry(changelogContent, requestedVersion);
  let changelogEntries = [];

  if (changelogExists) {
    console.log(`\nChangelog check: Entry found for version ${requestedVersion}. Continuing...\n`);
  } else {
    console.log(`\nChangelog check: No entry found for version ${requestedVersion} in CHANGELOG.md.`);
    let cliChangelog;
    const changelogFlag = cliArgs.find((arg) => arg.startsWith("--changelog="));
    if (changelogFlag) {
      cliChangelog = changelogFlag.slice("--changelog=".length).trim();
    } else {
      const idx = cliArgs.indexOf("--changelog");
      if (idx !== -1 && cliArgs[idx + 1] && !cliArgs[idx + 1].startsWith("-")) {
        cliChangelog = cliArgs[idx + 1].trim();
      }
    }

    if (cliChangelog) {
      changelogEntries = cliChangelog.split("\n").map((line) => line.trim()).filter(Boolean);
    } else if (process.env.CHANGELOG_ENTRY) {
      changelogEntries = process.env.CHANGELOG_ENTRY.split("\n").map((line) => line.trim()).filter(Boolean);
    } else if (!autoConfirm) {
      console.log("What would you like to add to the changelog?");
      console.log("(Enter each item and press Enter. Enter an empty line when finished):");
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        while (true) {
          const promptText = changelogEntries.length === 0 ? "Entry: " : "Entry (empty line to finish): ";
          const line = (await rl.question(promptText)).trim();
          if (!line) break;
          changelogEntries.push(line);
        }
      } catch {
        // Stream closed
      } finally {
        rl.close();
      }
    }

    if (changelogEntries.length === 0) {
      changelogEntries = [`Release version ${requestedVersion}.`];
    }
  }

  console.log("==========================================");
  console.log(` Package:            ${pkg.name}`);
  console.log(` Local version:      ${localVersion}`);
  console.log(` Latest npm version: ${latestPublished}`);
  console.log(` Proposed version:   ${requestedVersion}`);
  console.log(` Distribution tag:   ${distTag}`);
  console.log(
    ` Changelog:          ${
      changelogExists
        ? "Verified in CHANGELOG.md"
        : `${changelogEntries.length} new ${changelogEntries.length === 1 ? "entry" : "entries"} to add`
    }`,
  );
  console.log("==========================================\n");

  if (!autoConfirm) {
    const rl = createInterface({ input: stdin, output: stdout });
    let confirmed = false;
    try {
      const answer = (
        await rl.question(
          `Publish ${pkg.name}@${requestedVersion} under tag "${distTag}"? (y/N): `,
        )
      )
        .trim()
        .toLowerCase();
      confirmed = answer === "y" || answer === "yes";
    } catch {
      confirmed = false;
    } finally {
      rl.close();
    }
    if (!confirmed) {
      console.log("Publishing cancelled by user.");
      process.exit(0);
    }
  }

  if (!dryRun) {
    const isAuthed = await checkNpmAuth(registry);
    if (!isAuthed) {
      console.error(
        "\nError: Not authenticated with the npm registry.\n" +
          "Please run `npm login` or configure an auth token before publishing.",
      );
      process.exit(1);
    }
  }

  if (!skipTests) {
    const passed = await runValidationChecks();
    if (!passed) {
      console.error("\nError: Validation checks failed. Publication cancelled.");
      process.exit(1);
    }
  }

  const pkgPath = join(root, "package.json");
  const originalPkg = await readFile(pkgPath, "utf8");
  let originalChangelog = null;
  try {
    originalChangelog = await readFile(changelogPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!dryRun) {
    try {
      await updatePackageVersion(requestedVersion, changelogEntries);
      console.log(`Updated package.json version to ${requestedVersion}`);
    } catch (error) {
      console.error(`Failed to update local version files: ${error.message}`);
      process.exit(1);
    }
  }

  try {
    await publishPackage(distTag, dryRun);
    console.log(`\nSuccessfully published ${pkg.name}@${requestedVersion} (${distTag})!`);
  } catch (error) {
    console.error(`\nPublishing failed: ${error.message}`);
    if (!dryRun) {
      console.error("Reverting package.json and CHANGELOG.md to original contents...");
      try {
        await writeFile(pkgPath, originalPkg);
        if (originalChangelog !== null) {
          await writeFile(changelogPath, originalChangelog);
        }
      } catch {
        // ignore rollback errors
      }
    }
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Unexpected error: ${error.message}`);
    process.exit(1);
  });
}
