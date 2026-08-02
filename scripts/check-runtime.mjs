const response = await fetch("http://127.0.0.1:3000/api/runtime");
if (!response.ok) throw new Error(`Runtime check returned HTTP ${response.status}`);
const status = await response.json();
if (!status.assetsReady || status.availableRobotIds.length !== 18) {
  throw new Error(`Runtime assets are incomplete: ${status.availableRobotIds.length}/18`);
}
console.log(`Runtime ready: ${status.availableRobotIds.length}/18 assets; counter ${status.counter}`);
