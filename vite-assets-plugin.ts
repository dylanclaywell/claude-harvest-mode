import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Dev-only REST shim over the assets/ directory, so the sprite editor can read
 * and write project .json straight into the repo from ANY browser (the File
 * System Access API is Chromium-only). Never part of the production build.
 *
 *   GET  /api/assets            -> [{ file, project } | { file, error }]
 *   GET  /api/assets/<file>     -> raw .json
 *   PUT  /api/assets/<file>     -> write body (validated JSON) into assets/
 */
const ASSETS = join(process.cwd(), "assets");
// No slashes / no "..": confines writes to assets/, blocks path traversal.
const FILE_RE = /^[A-Za-z0-9._-]+\.json$/;

function ensureAssets(): void {
  if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function assetsApi(): Plugin {
  return {
    name: "assets-api",
    configureServer(server) {
      server.middlewares.use("/api/assets", async (req: IncomingMessage, res: ServerResponse) => {
        const send = (code: number, obj: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(obj));
        };
        try {
          const seg = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\//, ""));

          // List every project, parsed so the editor can draw thumbnails.
          if (req.method === "GET" && seg === "") {
            ensureAssets();
            const list = readdirSync(ASSETS)
              .filter((f) => f.endsWith(".json"))
              .map((file) => {
                try {
                  return { file, project: JSON.parse(readFileSync(join(ASSETS, file), "utf8")) };
                } catch (e) {
                  return { file, error: (e as Error).message };
                }
              });
            return send(200, list);
          }

          if (!FILE_RE.test(seg)) return send(400, { error: "invalid filename" });
          const path = join(ASSETS, seg);

          if (req.method === "GET") {
            if (!existsSync(path)) return send(404, { error: "not found" });
            res.setHeader("Content-Type", "application/json");
            return res.end(readFileSync(path, "utf8"));
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readBody(req);
            try {
              JSON.parse(body); // refuse to persist garbage
            } catch {
              return send(400, { error: "body is not valid JSON" });
            }
            ensureAssets();
            writeFileSync(path, body);
            return send(200, { ok: true, file: seg });
          }

          return send(405, { error: "method not allowed" });
        } catch (e) {
          return send(500, { error: (e as Error).message });
        }
      });
    },
  };
}
