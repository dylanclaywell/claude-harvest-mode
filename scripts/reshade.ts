/**
 * Reshade: rewrite a sprite's shadow/highlight palette slots so they equal
 * shade(baseColor, steps) — the SAME algorithm the character customizer uses
 * when a slider recolors a part. This makes the saved base palette start out
 * consistent with the slider's shading, so a slot named `x_shadow` is exactly
 * the shadow the slider would produce for `x`.
 *
 * Only palette COLOR values change. Frames, names, and base slots are left
 * untouched. Run after naming slots in the editor:
 *
 *   npx tsx scripts/reshade.ts            # all assets
 *   npx tsx scripts/reshade.ts farmhand   # just assets/farmhand.json
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { intToHex, shade } from "../src/color";
import { fromJson, parseSlotName, toJson } from "../src/editor/project";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(root, "assets");

const targets = process.argv.slice(2);
const files = targets.length
  ? targets.map((t) => (t.endsWith(".json") ? t : `${t}.json`))
  : readdirSync(ASSETS).filter((f) => f.endsWith(".json"));

let changed = 0;
for (const file of files) {
  const path = join(ASSETS, file);
  const project = fromJson(readFileSync(path, "utf8"));
  const names = project.names;
  if (!names) {
    console.log(`- ${file}: no named slots, skipped`);
    continue;
  }

  // Map base part name -> slot index (the steps==0 slot for that part).
  const baseSlot = new Map<string, number>();
  names.forEach((n, i) => {
    if (!n) return;
    const { base, steps } = parseSlotName(n);
    if (steps === 0) baseSlot.set(base, i);
  });

  let fileChanges = 0;
  names.forEach((n, i) => {
    if (!n) return;
    const { base, steps } = parseSlotName(n);
    if (steps === 0) return; // this IS a base slot
    const srcIdx = baseSlot.get(base);
    if (srcIdx === undefined) {
      console.warn(`  ! ${file}: "${n}" has no base slot "${base}" — left as-is`);
      return;
    }
    // Derive the shade per variant from THAT variant's base color.
    for (const pal of project.palettes) {
      const want = shade(pal.colors[srcIdx], steps);
      if (pal.colors[i] !== want) {
        console.log(
          `  ${file} [${pal.name}] slot ${i} "${n}": ${intToHex(pal.colors[i])} → ${intToHex(want)} (from ${base} ${intToHex(pal.colors[srcIdx])})`,
        );
        pal.colors[i] = want;
        fileChanges++;
      }
    }
  });

  if (fileChanges) {
    writeFileSync(path, toJson(project) + "\n");
    console.log(`✓ ${file}: ${fileChanges} slot(s) reshaded`);
    changed += fileChanges;
  } else {
    console.log(`= ${file}: already consistent`);
  }
}
console.log(`\nReshaded ${changed} slot(s). Run \`npm run gen\` to rebuild generated modules.`);
