import { readFileSync } from "node:fs";

function readJsonVersion(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed.version !== "string") {
    throw new Error(`${filePath} does not contain a string version.`);
  }
  return parsed.version;
}

function readCargoTomlVersion(filePath) {
  const contents = readFileSync(filePath, "utf8");
  const match = contents.match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error(`Could not find version in ${filePath}.`);
  }
  return match[1];
}

function readCargoLockVersion(filePath) {
  const contents = readFileSync(filePath, "utf8");
  const match = contents.match(/\[\[package\]\]\nname = "memory-guard"\nversion = "([^"]+)"/);
  if (!match) {
    throw new Error(`Could not find package version for "memory-guard" in ${filePath}.`);
  }
  return match[1];
}

function parseArgs(argv) {
  const args = { expected: null };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--expected") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --expected.");
      }
      args.expected = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const versions = new Map([
    ["package.json", readJsonVersion("package.json")],
    ["src-tauri/Cargo.toml", readCargoTomlVersion("src-tauri/Cargo.toml")],
    ["src-tauri/tauri.conf.json", readJsonVersion("src-tauri/tauri.conf.json")],
    ["src-tauri/Cargo.lock", readCargoLockVersion("src-tauri/Cargo.lock")]
  ]);

  const distinctVersions = new Set(versions.values());
  if (distinctVersions.size !== 1) {
    const details = [...versions.entries()].map(([filePath, version]) => `${filePath}: ${version}`);
    throw new Error(`Release versions are out of sync.\n${details.join("\n")}`);
  }

  const [version] = distinctVersions;
  if (args.expected && version !== args.expected) {
    throw new Error(`Expected release version ${args.expected}, but found ${version}.`);
  }

  console.log(`Release version verified: ${version}`);
}

main();
