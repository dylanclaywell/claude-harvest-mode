// maps.ts — load authored tilemaps from assets/*.map.json (the source of truth,
// edited in tilemap.html and seeded by scripts/make-maps.ts). Vite bundles the
// JSON; editing a file hot-reloads the game in dev.

import type { TileMap } from "./tilemap";
import farmData from "../assets/farm.map.json";
import barnData from "../assets/barn.map.json";

// Map cells name a kind="tile" sprite (assets/<name>.json); "" = empty.
export function makeFarmMap(): TileMap { return farmData as TileMap; }
export function makeBarnMap(): TileMap { return barnData as TileMap; }
