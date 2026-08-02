const major = Number(process.versions.node.split(".")[0]);

if (major < 22) {
  console.error(`Eidos requires Node.js 22 or newer. Found ${process.versions.node}.`);
  process.exit(1);
}
