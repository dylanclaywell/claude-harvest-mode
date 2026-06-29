// maps.ts — load authored tilemaps from assets/*.map.json (the source of truth,
// edited in tilemap.html and seeded by scripts/make-maps.ts). Vite bundles the
// JSON; editing a file hot-reloads the game in dev.

import type { TileMap } from "./tilemap";
import farmData from "../assets/farm.map.json";
import barnData from "../assets/barn.map.json";

// Tile ids = frame indices in assets/tile.json (the `tile` tileset sprite).
export const T = { GRASS: 0, TILLED: 1, DIRT: 2, WOOD: 3, WALL: 4 } as const;

export function makeFarmMap(): TileMap { return farmData as TileMap; }
export function makeBarnMap(): TileMap { return barnData as TileMap; }
