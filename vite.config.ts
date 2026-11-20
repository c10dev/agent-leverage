import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const demo = Boolean(process.env.VITE_DEMO);

// Demo builds must never ship real usage: drop public/usage.json from the output even if it exists locally.
const dropRealUsage: Plugin = {
  name: "drop-real-usage",
  apply: "build",
  writeBundle(options) {
    if (demo) fs.rmSync(path.join(options.dir ?? "dist", "usage.json"), { force: true });
  },
};

// Dev only: lets the dashboard's refresh button re-run the collector.
let collecting: Promise<{ ok: boolean; error?: string }> | null = null;
const collectEndpoint: Plugin = {
  name: "collect-endpoint",
  apply: "serve",
  configureServer(server) {
    const url = `${server.config.base}api/collect`;
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== url) return next();
      const send = (status: number, body: object) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST") return send(405, { ok: false, error: "Method Not Allowed" });
      collecting ??= new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let stderr = "";
        const child = spawn(process.execPath, ["scripts/collect.mjs", "--out", "public/usage.json"], { cwd: server.config.root });
        child.stderr.on("data", (d) => {
          stderr = (stderr + d).slice(-500);
        });
        child.on("error", (e) => resolve({ ok: false, error: String(e.message).slice(-500) }));
        child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(-500) }));
      }).finally(() => {
        collecting = null;
      });
      collecting.then((r) => send(r.ok ? 200 : 500, r));
    });
  },
};

// BASE_PATH lets the GitHub Pages build live under /agent-leverage/
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), dropRealUsage, collectEndpoint],
});
