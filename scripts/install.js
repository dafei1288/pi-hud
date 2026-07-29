#!/usr/bin/env node

/**
 * Install script for agent-hud extension (multi-file directory extension).
 *
 * Usage:
 *   node scripts/install.js          # Install to current project (.pi/extensions/agent-hud/)
 *   node scripts/install.js --global # Install globally (~/.pi/agent/extensions/agent-hud/)
 *
 * Also removes legacy single-file installs (pi-agent-hud.ts / bubble-test.ts)
 * from the target directory.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const isGlobal = process.argv.includes("--global");
const extDirName = "agent-hud";
const srcDir = path.resolve(__dirname, "..", "extensions", extDirName);

if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, "index.ts"))) {
  console.error(`Error: Extension source not found at ${srcDir} (expected index.ts)`);
  process.exit(1);
}

/** Recursively copy .ts files from src to dest */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(s, d);
    } else if (entry.name.endsWith(".ts")) {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

const targetBase = isGlobal
  ? path.join(os.homedir(), ".pi", "agent", "extensions")
  : path.join(process.cwd(), ".pi", "extensions");
const targetDir = path.join(targetBase, extDirName);

// Remove legacy single-file installs that would shadow/conflict
for (const legacy of ["pi-agent-hud.ts", "bubble-test.ts"]) {
  const legacyPath = path.join(targetBase, legacy);
  if (fs.existsSync(legacyPath)) {
    fs.rmSync(legacyPath);
    console.log(`Removed legacy: ${legacyPath}`);
  }
}

const n = copyDir(srcDir, targetDir);
console.log(`Installed ${n} files: ${targetDir}`);
console.log("Restart pi or run /reload to activate.");
