#!/usr/bin/env node
// Builds the npm package `tapdance-cli` from the workspace: one package whose command is `tapdance`.
//
// The five workspace packages (@tapdance/*) are not published on their own. They, and the patched
// Simlock and agent-device that Tapdance is tested with (patches/), travel inside this package as
// bundled dependencies, so `npm install -g tapdance-cli` runs exactly the tested code. pnpm applies
// those patches only inside this workspace; a plain npm install of simlock or agent-device would get
// the unpatched releases.
//
// Run after `pnpm build`:
//   node scripts/pack-npm.mjs            # writes dist-npm/tapdance-cli-<version>.tgz
//   node scripts/pack-npm.mjs --no-pack  # stops after staging dist-npm/tapdance-cli/
//
// It never publishes. The release workflow (.github/workflows/release.yml) publishes the tarball.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-npm");
const stage = join(out, "tapdance-cli");
const WORKSPACE = ["core", "provider-simlock", "sdk", "mcp"];
const PATCHED = { simlock: "simlock@0.6.0.patch", "agent-device": "agent-device@0.21.36.patch" };

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const fail = (message) => {
  process.stderr.write(`pack-npm: ${message}\n`);
  process.exit(1);
};

const cli = readJson(join(root, "packages/cli/package.json"));
const version = cli.version;
const ours = new Set(["cli", ...WORKSPACE].map((p) => readJson(join(root, `packages/${p}/package.json`)).name));

// Every runtime dependency of the five packages, at the exact version the workspace pins.
const deps = {};
for (const p of ["cli", ...WORKSPACE]) {
  const pkg = readJson(join(root, `packages/${p}/package.json`));
  if (!existsSync(join(root, `packages/${p}/dist`))) fail(`packages/${p}/dist is missing: run pnpm build first`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (ours.has(name)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(range)) fail(`${pkg.name} depends on ${name}@${range}: only exact versions are packed`);
    if (deps[name] !== undefined && deps[name] !== range) fail(`${name} is pinned to both ${deps[name]} and ${range}`);
    deps[name] = range;
  }
}
for (const name of Object.keys(PATCHED)) if (deps[name] === undefined) fail(`${name} is not a dependency any more: update PATCHED`);

const copyDist = (from, to) =>
  cpSync(from, to, { recursive: true, filter: (src) => !/\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(src) && !/\.integration\.test\./.test(src) });

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. The package itself, first without the workspace packages, so npm installs only public ones.
const manifest = {
  name: "tapdance-cli",
  version,
  description: "Your AI agent tests your app on real Android emulators and iOS simulators: a CLI and MCP server.",
  keywords: ["mcp", "android", "ios", "emulator", "simulator", "testing", "agent", "claude-code"],
  license: cli.license,
  homepage: "https://github.com/mirzemehdi/tapdance#readme",
  repository: { type: "git", url: "git+https://github.com/mirzemehdi/tapdance.git" },
  bugs: { url: "https://github.com/mirzemehdi/tapdance/issues" },
  type: "module",
  bin: { tapdance: "dist/main.js" },
  engines: cli.engines ?? { node: ">=22.13" },
  files: ["dist", "NOTICE.md"],
  dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyDist(join(root, "packages/cli/dist"), join(stage, "dist"));
for (const f of ["README.md", "LICENSE", "NOTICE.md"]) cpSync(join(root, f), join(stage, f));

// 2. A real, flat npm install of the public dependencies, with no install scripts.
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], stage);

// 3. The same patches pnpm applies in the workspace. A patch that does not apply stops the pack.
for (const [name, file] of Object.entries(PATCHED)) {
  const dir = join(stage, "node_modules", name);
  const installed = readJson(join(dir, "package.json")).version;
  if (installed !== deps[name]) fail(`${name}@${installed} installed, ${deps[name]} expected`);
  const patch = join(root, "patches", file);
  run("patch", ["-p1", "--forward", "--dry-run", "--silent", "-d", dir, "-i", patch], root);
  run("patch", ["-p1", "--forward", "--silent", "-d", dir, "-i", patch], root);
  // Record that this copy is patched, so `npm ls` and bug reports can tell.
  const pkg = readJson(join(dir, "package.json"));
  pkg.tapdancePatch = file;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

// 4. The workspace packages, with workspace:* turned into this version.
for (const p of WORKSPACE) {
  const pkg = readJson(join(root, `packages/${p}/package.json`));
  const dir = join(stage, "node_modules", pkg.name);
  mkdirSync(dir, { recursive: true });
  copyDist(join(root, `packages/${p}/dist`), join(dir, "dist"));
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) if (String(range).startsWith("workspace:")) pkg[field][name] = version;
  }
  delete pkg.devDependencies;
  delete pkg.scripts;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

// 5. Bundle the workspace packages and the patched dependencies (npm packs their own dependencies
// with them).
const bundled = [...[...ours].filter((n) => n !== cli.name), ...Object.keys(PATCHED)].sort();
manifest.dependencies = Object.fromEntries(
  Object.entries({ ...manifest.dependencies, ...Object.fromEntries([...ours].filter((n) => n !== cli.name).map((n) => [n, version])) }).sort(([a], [b]) => a.localeCompare(b)),
);
manifest.bundleDependencies = bundled;
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (process.argv.includes("--no-pack")) {
  process.stdout.write(`${stage}\n`);
  process.exit(0);
}
run("npm", ["pack", "--pack-destination", out], stage);
const tarball = readdirSync(out).find((f) => f === `tapdance-cli-${version}.tgz`);
if (!tarball) fail("npm pack wrote no tarball");
process.stdout.write(`${join(out, tarball)}\n`);
