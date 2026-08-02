import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const targetDir = path.join(root, "apps/web/public/mediapipe/wasm");

if (!existsSync(sourceDir)) {
  throw new Error("MediaPipe Tasks Vision is not installed. Run npm install first.");
}

mkdirSync(targetDir, { recursive: true });
for (const name of readdirSync(sourceDir)) {
  if (!name.endsWith(".js") && !name.endsWith(".wasm")) continue;
  copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
}

console.log("Copied MediaPipe WASM assets to apps/web/public/mediapipe/wasm");
