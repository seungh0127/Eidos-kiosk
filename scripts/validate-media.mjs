import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const expected = Array.from({ length: 18 }, (_, index) => index + 1);
const archivePaths = readdirSync(root)
  .filter((name) => /^Robot-.*\.zip$/i.test(name))
  .map((name) => path.join(root, name));

const archiveIds = new Map();
for (const archive of archivePaths) {
  const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  for (const entry of listing.split("\n")) {
    const match = entry.match(/^Robot\/(\d+)\.mov$/i);
    if (!match) continue;
    const id = Number(match[1]);
    const sources = archiveIds.get(id) ?? [];
    sources.push(path.basename(archive));
    archiveIds.set(id, sources);
  }
}

const runtimeDir = path.join(root, "apps/web/public/media");
const runtimeIds = existsSync(runtimeDir)
  ? readdirSync(runtimeDir).map((name) => name.match(/^robot-(\d{2})\.webm$/)?.[1]).filter(Boolean).map(Number)
  : [];
const missingSources = expected.filter((id) => !archiveIds.has(id));
const duplicateSources = expected.filter((id) => (archiveIds.get(id)?.length ?? 0) > 1);
const missingRuntime = expected.filter((id) => !runtimeIds.includes(id));

console.log(`Source archives: ${archivePaths.length}`);
console.log(`Source IDs: ${[...archiveIds.keys()].sort((a, b) => a - b).join(", ") || "none"}`);
console.log(`Runtime WebM IDs: ${runtimeIds.sort((a, b) => a - b).join(", ") || "none"}`);
if (missingSources.length) console.warn(`Missing source IDs: ${missingSources.join(", ")}`);
if (duplicateSources.length) console.warn(`Duplicate source IDs: ${duplicateSources.join(", ")}`);
if (missingRuntime.length) console.warn(`Missing runtime WebM IDs: ${missingRuntime.join(", ")}`);

if (missingSources.length || duplicateSources.length || missingRuntime.length) process.exitCode = 1;
