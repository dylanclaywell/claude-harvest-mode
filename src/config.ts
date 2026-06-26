// config.ts — farm tables + deterministic helpers (GAME_DESIGN.md §8A–§8D).
// Balance numbers live here; tune freely.

export const GROWTH_STAGES = 4; // edits to reach ripe (stage >= this = ripe)
export const CROP_BASE_PRICE = 50; // gold per ripe crop, before quality
export const PRODUCE_BASE_PRICE = 20; // gold per animal produce item
export const QUALITY_TEST_BONUS = 0.5; // added to a crop's quality on a test pass
export const QUALITY_MAX = 3;
export const HEARTS_MAX = 5;

export type Season = "Spring" | "Summer" | "Fall" | "Winter";

// Authentic-ish Harvest Moon crops by season (winter filled so it's never bare).
export const SEASON_CROPS: Record<Season, string[]> = {
  Spring: ["Turnip", "Potato", "Cucumber", "Cabbage", "Strawberry"],
  Summer: ["Tomato", "Corn", "Onion", "Pumpkin", "Pineapple"],
  Fall: ["Eggplant", "Carrot", "Sweet Potato", "Spinach", "Yam"],
  Winter: ["Broccoli", "Wasabi", "Buckwheat", "Snow Turnip"],
};

// Species are assigned by acquisition order (no name-hash collisions).
export const SPECIES_ORDER = ["Cow", "Chicken", "Sheep"] as const;
export type Species = (typeof SPECIES_ORDER)[number];
export const PRODUCE_OF: Record<Species, string> = {
  Cow: "Milk",
  Chicken: "Egg",
  Sheep: "Wool",
};

const RECIPE_ADJ = ["Hearty", "Honeyed", "Rustic", "Wild", "Grandma's", "Golden", "Spicy"];
const RECIPE_DISH = ["Stew", "Pie", "Gratin", "Risotto", "Jam", "Skewers", "Curry"];

/** Stable unsigned string hash (FNV-1a). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Real-world calendar season from a JS Date (Northern hemisphere). */
export function seasonOf(d: Date): Season {
  const m = d.getMonth(); // 0=Jan
  if (m <= 1 || m === 11) return "Winter";
  if (m <= 4) return "Spring";
  if (m <= 7) return "Summer";
  return "Fall";
}

/** YYYY-MM-DD local date key. */
export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/** A file's crop: an in-season crop chosen by extension hash (§8A). */
export function cropForFile(filePath: string, season: Season): string {
  const crops = SEASON_CROPS[season];
  return crops[hashStr(extOf(filePath) || filePath) % crops.length];
}

/** Species for the Nth animal acquired (cycles). */
export function speciesForIndex(i: number): Species {
  return SPECIES_ORDER[i % SPECIES_ORDER.length];
}

/** Deterministic food-recipe name from a skill name; ingredient is in-season. */
export function recipeName(skill: string, season: Season): string {
  const h = hashStr(skill);
  const crops = SEASON_CROPS[season];
  const adj = RECIPE_ADJ[h % RECIPE_ADJ.length];
  const ingr = crops[(h >>> 8) % crops.length];
  const dish = RECIPE_DISH[(h >>> 16) % RECIPE_DISH.length];
  return `${adj} ${ingr} ${dish}`;
}

export function cropPrice(quality: number): number {
  return Math.round(CROP_BASE_PRICE * Math.max(1, quality));
}
export function producePrice(hearts: number): number {
  return Math.round(PRODUCE_BASE_PRICE * (1 + hearts / HEARTS_MAX));
}
