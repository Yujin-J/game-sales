import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const dataDir = join(dist, "data");
const preserveData = process.argv.includes("--preserve-data");

if (preserveData && existsSync(dataDir)) {
  await Promise.all([
    copyFile(join(root, "index.html"), join(dist, "index.html")),
    copyFile(join(root, "styles.css"), join(dist, "styles.css")),
    copyFile(join(root, "app.js"), join(dist, "app.js")),
  ]);
} else {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await Promise.all([
    copyFile(join(root, "index.html"), join(dist, "index.html")),
    copyFile(join(root, "styles.css"), join(dist, "styles.css")),
    copyFile(join(root, "app.js"), join(dist, "app.js")),
  ]);
}

await writeFile(join(dist, ".nojekyll"), "", "utf8");
console.log(`Built static site at ${dist}`);
