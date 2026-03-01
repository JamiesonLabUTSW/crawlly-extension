import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve("manifest.json");
const raw = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw);

function fail(message) {
  console.error(`manifest validation failed: ${message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  fail("manifest_version must be 3");
}

if (!manifest.name || !manifest.version || !manifest.background?.service_worker) {
  fail("name, version, and background.service_worker are required");
}

if (!Array.isArray(manifest.permissions)) {
  fail("permissions must be an array");
}

if (!Array.isArray(manifest.host_permissions)) {
  fail("host_permissions must be an array");
}

if (manifest.host_permissions.includes("<all_urls>")) {
  fail("host_permissions must not include <all_urls>");
}

const allowedHosts = ["https://ethos.swmed.edu/*"];
for (const host of manifest.host_permissions) {
  if (!allowedHosts.includes(host)) {
    fail(`unexpected host permission: ${host}`);
  }
}

if (manifest.permissions.includes("debugger")) {
  fail("debugger permission must be optional_permissions, not required permissions");
}

console.log("manifest validation passed");
