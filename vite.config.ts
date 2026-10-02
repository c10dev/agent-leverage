import fs from "node:fs";
import path from "node:path";
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

// BASE_PATH lets the GitHub Pages build live under /agent-usage/
export default defineConfig({ base: process.env.BASE_PATH ?? "/", plugins: [react(), dropRealUsage] });
