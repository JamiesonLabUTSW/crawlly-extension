import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const allowedExtensions = new Set([".js", ".html", ".json"]);
const ignoreDirs = new Set([".git", "node_modules", "dist"]);

const bannedPatterns = [
  { name: "eval", regex: /\beval\s*\(/ },
  { name: "new Function", regex: /\bnew\s+Function\s*\(/ },
  { name: "string setTimeout", regex: /setTimeout\s*\(\s*["'`]/ },
  { name: "string setInterval", regex: /setInterval\s*\(\s*["'`]/ }
];

const remoteScriptPattern = /<script[^>]+src=["']https?:\/\//i;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else {
      if (allowedExtensions.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }
  return files;
}

const files = walk(root);
let failed = false;

for (const file of files) {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, "utf8");

  for (const rule of bannedPatterns) {
    if (rule.regex.test(content)) {
      console.error(`security check failed: ${rule.name} found in ${rel}`);
      failed = true;
    }
  }

  if (path.extname(file) === ".html" && remoteScriptPattern.test(content)) {
    console.error(`security check failed: remote script src found in ${rel}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log("security check passed");
