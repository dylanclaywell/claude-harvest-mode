/**
 * Asset codegen. Reads every sprite project in assets/*.json (the committed
 * source of truth, authored in editor.html) and regenerates its derived
 * output:
 *   - src/generated/<name>.ts  — emulator + game module
 *
 * The .ts is a build artifact: never hand-edit it, just rerun `npm run gen`.
 * Codegen logic lives in src/editor/project.ts so the editor preview and this
 * utility stay byte-identical.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromJson, toTypeScript } from "../src/editor/project";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(root, "assets");
const TS_OUT = join(root, "src", "generated");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

if (!existsSync(ASSETS)) {
  console.error(`No assets/ directory at ${ASSETS} — export a .json from editor.html first.`);
  process.exit(1);
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.warn("assets/ has no .json files — nothing to generate.");
  process.exit(0);
}

ensureDir(TS_OUT);

let ok = 0;
for (const file of files) {
  try {
    const project = fromJson(readFileSync(join(ASSETS, file), "utf8"));
    writeFileSync(join(TS_OUT, `${project.name}.ts`), toTypeScript(project));
    console.log(`✓ ${file} → src/generated/${project.name}.ts`);
    ok++;
  } catch (err) {
    console.error(`✗ ${file}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
console.log(`Generated ${ok} sprite${ok === 1 ? "" : "s"}.`);
