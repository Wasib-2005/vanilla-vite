import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseSemver,
  compareSemver,
  getDistTag,
  checkRootExecution,
  fetchRegistryPackage,
  hasChangelogEntry,
} from "../scripts/version-manager.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const vpublishScript = join(root, "scripts", "version-manager.mjs");

function runCLI(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vpublishScript, ...args], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
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
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

console.log("Running version manager unit and integration tests...\n");

// 1. SemVer parsing and comparison unit tests
{
  console.log("Test: SemVer parsing and comparison logic");
  assert.equal(compareSemver("1.0.5", "1.0.4"), 1);
  assert.equal(compareSemver("1.0.5", "1.0.5"), 0);
  assert.equal(compareSemver("1.0.4", "1.0.5"), -1);
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-beta.1"), 1);

  assert.throws(() => parseSemver("1.0"), /Invalid semantic version/);
  assert.throws(() => parseSemver("hello"), /Invalid semantic version/);
  assert.throws(() => parseSemver(""), /Invalid semantic version/);
  console.log("  Passed: SemVer parsing and comparison conform to SemVer 2.0.");
}

// 2. Prerelease dist-tag extraction unit tests
{
  console.log("Test: Dist-tag extraction for stable and prerelease versions");
  assert.equal(getDistTag("1.0.5"), "latest");
  assert.equal(getDistTag("2.0.0"), "latest");
  assert.equal(getDistTag("1.1.0-beta.1"), "beta");
  assert.equal(getDistTag("1.1.0-rc.2"), "rc");
  assert.equal(getDistTag("1.1.0-alpha.0"), "alpha");
  assert.equal(getDistTag("1.1.0-next.1"), "next");
  console.log("  Passed: Dist-tags are correctly derived from versions.");
}

// 2b. Changelog entry detection unit tests
{
  console.log("Test: Changelog entry detection logic");
  const sampleChangelog = `# Changelog\n\n## 1.2.2 - 2026-11-19\n\n- Fixes\n\n## 1.2.1 - 2026-11-12\n\n- Previous\n`;
  assert.equal(hasChangelogEntry(sampleChangelog, "1.2.2"), true);
  assert.equal(hasChangelogEntry(sampleChangelog, "1.2.1"), true);
  assert.equal(hasChangelogEntry(sampleChangelog, "1.2.20"), false);
  assert.equal(hasChangelogEntry(sampleChangelog, "1.3.0"), false);
  assert.equal(hasChangelogEntry("", "1.2.2"), false);
  console.log("  Passed: Changelog entry detection correctly matches existing versions.");
}

// 3. Root execution restriction unit tests
{
  console.log("Test: Root execution restriction logic");
  assert.equal(checkRootExecution({ ALLOW_ROOT_PUBLISH: "1" }), false);

  // Test CLI refusal when getuid returns 0 (root simulation)
  const rootTestScript = join(root, "scripts", "version-manager.mjs");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "data:text/javascript,process.getuid=()=>0;", rootTestScript, "1.2.2"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ALLOW_ROOT_PUBLISH: undefined } },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.once("close", (code) => resolve({ code, output: out }));
    child.once("error", reject);
  });
  assert.equal(result.code, 1, "CLI must reject execution when running as root");
  assert.ok(
    result.output.includes("Refusing to run publishing operations as root"),
    "Output must explain refusal to run as root",
  );
  console.log("  Passed: checkRootExecution and CLI reject execution as root.");
}

// 4. Mock npm registry server for integration tests
const mockRegistryPort = 48000 + Math.floor(Math.random() * 1000);
let mockRegistryHandler = () => ({ status: 404, body: {} });
const mockRegistryServer = createServer((req, res) => {
  const result = mockRegistryHandler(req);
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
});

await new Promise((resolve, reject) => {
  mockRegistryServer.once("error", reject);
  mockRegistryServer.listen(mockRegistryPort, "127.0.0.1", resolve);
});
const mockRegistryUrl = `http://127.0.0.1:${mockRegistryPort}`;

try {
  // Test 5: npm registry version retrieval
  {
    console.log("Test: Fetch package metadata from registry");
    mockRegistryHandler = () => ({
      status: 200,
      body: {
        name: "create-vanilla-vite",
        "dist-tags": { latest: "1.2.1", beta: "1.3.0-beta.1" },
        versions: { "1.2.0": {}, "1.2.1": {}, "1.3.0-beta.1": {} },
      },
    });

    const info = await fetchRegistryPackage("create-vanilla-vite", mockRegistryUrl);
    assert.equal(info.latest, "1.2.1");
    assert.deepEqual(info.versions, ["1.2.0", "1.2.1", "1.3.0-beta.1"]);
    console.log("  Passed: Registry package retrieval returns correct metadata.");
  }

  // Test 6: CLI invalid SemVer rejection
  {
    console.log("Test: CLI rejects invalid SemVer arguments");
    const result = await runCLI(["invalid-semver", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
      },
    });
    assert.notEqual(result.code, 0, "CLI should reject invalid SemVer");
    assert.ok(
      result.output.includes("not a valid semantic version"),
      "Output should indicate invalid semantic version",
    );
    console.log("  Passed: CLI rejects invalid SemVer.");
  }

  // Test 7: CLI already-published version rejection
  {
    console.log("Test: CLI rejects already published version");
    const result = await runCLI(["1.2.1", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
      },
    });
    assert.notEqual(result.code, 0, "CLI should reject already published version");
    assert.ok(
      result.output.includes("already been published"),
      "Output should report version has already been published",
    );
    console.log("  Passed: CLI rejects duplicate publication.");
  }

  // Test 8: CLI downgrade rejection
  {
    console.log("Test: CLI rejects version downgrade");
    const result = await runCLI(["1.1.0", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
      },
    });
    assert.notEqual(result.code, 0, "CLI should reject downgrade");
    assert.ok(
      result.output.includes("is a downgrade"),
      "Output should report downgrade error",
    );
    console.log("  Passed: CLI rejects downgrade.");
  }

  // Test 9: CLI user cancellation
  {
    console.log("Test: CLI respects user cancellation prompt");
    const result = await runCLI(["1.2.2", "--dry-run"], {
      input: "n\n",
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
      },
    });
    assert.equal(result.code, 0, "Cancellation should exit cleanly");
    assert.ok(
      result.output.includes("Publishing cancelled by user"),
      "Output should confirm cancellation",
    );
    console.log("  Passed: User cancellation safely aborts without errors.");
  }

  // Test 10: Registry failure handling
  {
    console.log("Test: Network/registry failure handling");
    const badPort = 49999;
    const result = await runCLI(["1.2.2", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: `http://127.0.0.1:${badPort}`,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
      },
    });
    assert.notEqual(result.code, 0, "Registry failure should exit with non-zero");
    assert.ok(
      result.output.includes("Failed to retrieve version information"),
      "Output should report registry retrieval failure",
    );
    console.log("  Passed: Registry failure is gracefully reported.");
  }

  // Test 11: Failed validation checks prevent publication
  {
    console.log("Test: Failed validation checks prevent publication");
    const result = await runCLI(["1.2.2", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "0",
        // Setting an impossible smoke filter forces tests to fail
        SMOKE_FILTER: "non_existent_case_filter_will_fail_tests",
      },
    });
    assert.notEqual(result.code, 0, "Failed tests must prevent publication");
    assert.ok(
      result.output.includes("Validation checks failed"),
      "Output should report validation failure",
    );
    console.log("  Passed: Failed tests prevent publication.");
  }

  // Test 12: Dry-run stable release publishing
  {
    console.log("Test: Dry-run stable release publishing with explicit version");
    const originalPkg = await readFile(join(root, "package.json"), "utf8");
    const originalChangelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const result = await runCLI(["1.3.0", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Dry run publish should succeed");
    assert.ok(
      result.output.includes('Distribution tag:   latest'),
      "Stable version must use dist-tag 'latest'",
    );
    assert.ok(
      result.output.includes("Successfully published"),
      "Output should report successful publication",
    );
    assert.equal(
      await readFile(join(root, "package.json"), "utf8"),
      originalPkg,
      "package.json must be unchanged after dry run",
    );
    assert.equal(
      await readFile(join(root, "CHANGELOG.md"), "utf8"),
      originalChangelog,
      "CHANGELOG.md must be unchanged after dry run",
    );
    console.log("  Passed: Stable release publishing executes with 'latest' tag in dry-run without writing files.");
  }

  // Test 13: Prerelease dist-tag publishing
  {
    console.log("Test: Prerelease dist-tag publishing");
    const originalPkg = await readFile(join(root, "package.json"), "utf8");
    const originalChangelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const result = await runCLI(["1.3.0-beta.2", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Prerelease publish should succeed");
    assert.ok(
      result.output.includes('Distribution tag:   beta'),
      "Prerelease beta must use dist-tag 'beta'",
    );
    assert.ok(
      result.output.includes("Successfully published"),
      "Output should report successful publication",
    );
    assert.equal(
      await readFile(join(root, "package.json"), "utf8"),
      originalPkg,
      "package.json must be unchanged after dry run",
    );
    assert.equal(
      await readFile(join(root, "CHANGELOG.md"), "utf8"),
      originalChangelog,
      "CHANGELOG.md must be unchanged after dry run",
    );
    console.log("  Passed: Prerelease publishing uses correct dist-tag without writing files.");
  }

  // Test 14: Interactive version input
  {
    console.log("Test: Interactive version input");
    const originalPkg = await readFile(join(root, "package.json"), "utf8");
    const originalChangelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const result = await runCLI(["--dry-run", "--yes"], {
      input: "1.3.0\n",
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Interactive input should succeed");
    assert.ok(
      result.output.includes("Vanilla-Vite Version Manager"),
      "Output should display version manager banner",
    );
    assert.ok(
      result.output.includes("1.3.0"),
      "Output should display target version 1.3.0",
    );
    assert.equal(
      await readFile(join(root, "package.json"), "utf8"),
      originalPkg,
      "package.json must be unchanged after dry run",
    );
    assert.equal(
      await readFile(join(root, "CHANGELOG.md"), "utf8"),
      originalChangelog,
      "CHANGELOG.md must be unchanged after dry run",
    );
    console.log("  Passed: Interactive version input operates correctly without writing files.");
  }

  // Test 15: Rollback on publish failure
  {
    console.log("Test: Rollback on publish failure restores exact file contents");
    const originalPkg = await readFile(join(root, "package.json"), "utf8");
    const originalChangelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const result = await runCLI(["1.3.0", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "fail",
      },
    });
    assert.equal(result.code, 1, "Failed publish should exit with code 1");
    assert.ok(
      result.output.includes("Reverting package.json and CHANGELOG.md"),
      "Output should report rollback",
    );
    assert.equal(
      await readFile(join(root, "package.json"), "utf8"),
      originalPkg,
      "package.json must be rolled back to exact original content",
    );
    assert.equal(
      await readFile(join(root, "CHANGELOG.md"), "utf8"),
      originalChangelog,
      "CHANGELOG.md must be rolled back to exact original content",
    );
    console.log("  Passed: Rollback cleanly restores package.json and CHANGELOG.md.");
  }

  // Test 16: Changelog check when entry exists
  {
    console.log("Test: Changelog check continues when entry already exists");
    const result = await runCLI(["1.2.2", "--dry-run", "--yes"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Publish should succeed when changelog entry exists");
    assert.ok(
      result.output.includes("Changelog check: Entry found for version 1.2.2. Continuing..."),
      `Output should report existing changelog entry verified, got:\n${result.output}`,
    );
    console.log("  Passed: Changelog check recognizes existing entries and continues.");
  }

  // Test 17: Changelog check prompts when entry does not exist
  {
    console.log("Test: Changelog check prompts when entry does not exist");
    const result = await runCLI(["1.4.0", "--dry-run"], {
      input: "Added brand new features\n\ny\n",
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Publish should succeed after entering changelog");
    assert.ok(
      result.output.includes("No entry found for version 1.4.0 in CHANGELOG.md"),
      `Output should report missing changelog entry, got:\n${result.output}`,
    );
    assert.ok(
      result.output.includes("What would you like to add to the changelog?"),
      `Output should prompt for changelog entry, got:\n${result.output}`,
    );
    console.log("  Passed: Changelog check asks for entries when missing.");
  }

  // Test 18: --changelog flag passes entry directly
  {
    console.log("Test: --changelog flag passes changelog entry directly");
    const result = await runCLI(["1.4.1", "--dry-run", "--yes", "--changelog=Direct CLI changelog note"], {
      env: {
        ...process.env,
        npm_config_registry: mockRegistryUrl,
        MOCK_NPM_AUTH: "1",
        SKIP_TESTS: "1",
        MOCK_PUBLISH: "1",
      },
    });
    assert.equal(result.code, 0, "Publish should succeed with --changelog flag");
    assert.ok(
      result.output.includes("1 new entry to add"),
      `Summary should show 1 new entry to add, got:\n${result.output}`,
    );
    console.log("  Passed: --changelog flag passes entry directly.");
  }
} finally {
  await new Promise((resolve) => mockRegistryServer.close(resolve));
}

console.log("\nAll version manager tests passed successfully!\n");
