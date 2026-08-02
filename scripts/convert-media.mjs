import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = process.cwd();
const outputDir = path.join(root, "apps/web/public/media");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "eidos-media-"));
mkdirSync(outputDir, { recursive: true });
const expected = Array.from({ length: 18 }, (_, index) => index + 1);
const archives = (process.argv.slice(2).length ? process.argv.slice(2) : execFileSync("find", [root, "-maxdepth", "1", "-name", "Robot-*.zip", "-print"], { encoding: "utf8" }).trim().split("\n").filter(Boolean));
const sourceMap = new Map();

for (const archive of archives) {
  const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  for (const entry of listing.split("\n")) {
    const match = entry.match(/^Robot\/(\d+)\.mov$/i);
    if (!match) continue;
    const id = Number(match[1]);
    if (sourceMap.has(id)) throw new Error(`Duplicate source for robot ${id}: ${sourceMap.get(id).archive} and ${archive}`);
    sourceMap.set(id, { archive, entry });
  }
}

const missing = expected.filter((id) => !sourceMap.has(id));
if (missing.length) throw new Error(`Cannot convert until all source videos exist. Missing: ${missing.join(", ")}`);

try {
  for (const id of expected) {
    const source = sourceMap.get(id);
    const input = path.join(tempDir, `${id}.mov`);
    const output = path.join(outputDir, `robot-${String(id).padStart(2, "0")}.webm`);
    const poster = path.join(outputDir, `robot-${String(id).padStart(2, "0")}.webp`);
    const fd = openSync(input, "w");
    try {
      execFileSync("unzip", ["-p", source.archive, source.entry], { stdio: ["ignore", fd, "inherit"] });
    } finally {
      closeSync(fd);
    }
    const video = spawnSync("ffmpeg", ["-y", "-i", input, "-an", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", output], { stdio: "inherit" });
    if (video.status !== 0) throw new Error(`FFmpeg failed for robot ${id}`);
    const image = spawnSync("ffmpeg", ["-y", "-i", input, "-frames:v", "1", "-c:v", "libwebp", "-quality", "85", poster], { stdio: "inherit" });
    if (image.status !== 0) throw new Error(`Poster generation failed for robot ${id}`);
    console.log(`Converted robot ${id}`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
