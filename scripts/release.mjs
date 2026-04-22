import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json"
];

function parseArgs(argv) {
  const args = { version: null, push: false };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "-v" || current === "--version") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for -v/--version.");
      }
      args.version = next;
      index += 1;
      continue;
    }

    if (current === "--push") {
      args.push = true;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid version: ${version}. Expected x.y.z`);
  }

  return match.slice(1).map((part) => Number(part));
}

function bumpPatch(version) {
  const [major, minor, patch] = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

function ensureCleanWorktree() {
  const output = execGit(["status", "--porcelain"]).trim();
  if (output !== "") {
    throw new Error("Worktree is not clean. Commit or stash changes before releasing.");
  }
}

function execGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function localTagExists(tagName) {
  const output = execGit(["tag", "--list", tagName]).trim();
  return output === tagName;
}

function updatePackageJson(version) {
  const filePath = "package.json";
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  parsed.version = version;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function updatePackageLock(version) {
  const filePath = "package-lock.json";
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  parsed.version = version;
  if (parsed.packages?.[""]) {
    parsed.packages[""].version = version;
  }
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function updateCargoToml(version) {
  const filePath = "src-tauri/Cargo.toml";
  const contents = readFileSync(filePath, "utf8");
  const updated = contents.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  if (updated === contents) {
    throw new Error("Could not find version in src-tauri/Cargo.toml.");
  }
  writeFileSync(filePath, updated);
}

function updateCargoLock(version) {
  const filePath = "src-tauri/Cargo.lock";
  const contents = readFileSync(filePath, "utf8");
  const updated = contents.replace(
    /(\[\[package\]\]\nname = "memory-guard"\nversion = ")[^"]+(")/,
    `$1${version}$2`
  );

  if (updated === contents) {
    throw new Error('Could not find package version for "memory-guard" in src-tauri/Cargo.lock.');
  }

  writeFileSync(filePath, updated);
}

function updateTauriConfig(version) {
  const filePath = "src-tauri/tauri.conf.json";
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  parsed.version = version;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function snapshotVersionFiles() {
  return new Map(
    VERSION_FILES.map((filePath) => [filePath, readFileSync(filePath, "utf8")])
  );
}

function restoreVersionFiles(snapshot) {
  for (const [filePath, contents] of snapshot.entries()) {
    writeFileSync(filePath, contents);
  }
}

function syncVersions(version) {
  updatePackageJson(version);
  updatePackageLock(version);
  updateCargoToml(version);
  updateCargoLock(version);
  updateTauriConfig(version);
}

function stageVersionFiles() {
  execGit(["add", ...VERSION_FILES]);
}

function createReleaseCommit(version) {
  execGit(["commit", "-m", `release v${version}`]);
}

function createReleaseTag(version) {
  execGit(["tag", "-a", `v${version}`, "-m", `v${version}`]);
}

function readCurrentBranch() {
  return execGit(["branch", "--show-current"]).trim();
}

function pushRelease(branchName, tagName) {
  execGit(["push", "--atomic", "origin", branchName, tagName]);
}

function readCurrentVersion() {
  const parsed = JSON.parse(readFileSync("package.json", "utf8"));
  if (typeof parsed.version !== "string") {
    throw new Error("package.json does not contain a string version.");
  }
  parseSemver(parsed.version);
  return parsed.version;
}

function rollbackRelease({ snapshot, commitCreated, tagCreated }) {
  if (tagCreated) {
    execGit(["tag", "-d", tagCreated]);
  }

  if (commitCreated) {
    execGit(["reset", "--hard", "HEAD~1"]);
    return;
  }

  restoreVersionFiles(snapshot);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureCleanWorktree();

  const currentVersion = readCurrentVersion();
  const nextVersion = args.version ?? bumpPatch(currentVersion);
  parseSemver(nextVersion);

  if (nextVersion === currentVersion) {
    throw new Error(`Version is already ${nextVersion}.`);
  }

  const tagName = `v${nextVersion}`;
  if (localTagExists(tagName)) {
    throw new Error(`Tag ${tagName} already exists.`);
  }

  const snapshot = snapshotVersionFiles();
  let commitCreated = false;
  let tagCreated = "";

  try {
    syncVersions(nextVersion);
    stageVersionFiles();
    createReleaseCommit(nextVersion);
    commitCreated = true;
    createReleaseTag(nextVersion);
    tagCreated = tagName;

    const branchName = readCurrentBranch();

    if (args.push) {
      pushRelease(branchName, tagName);
    }

    console.log(`Released ${tagName}`);
    if (args.push) {
      console.log(`Pushed ${branchName} and ${tagName}`);
    } else {
      console.log("Next step:");
      console.log(`  git push origin ${branchName} && git push origin ${tagName}`);
    }
  } catch (error) {
    if (args.push) {
      rollbackRelease({ snapshot, commitCreated, tagCreated });
      console.error(`Release failed. Rolled back local version changes for ${tagName}.`);
    } else if (!commitCreated) {
      restoreVersionFiles(snapshot);
    }

    throw error;
  }
}

main();
