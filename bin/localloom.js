#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = join(root, "src", "index.ts");
const built = join(root, "dist", "index.js");

const target = existsSync(built) ? built : entry;
const args = [target, ...process.argv.slice(2)];
const res = built
  ? spawnSync(process.execPath, args, { stdio: "inherit" })
  : spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), ...args], {
      stdio: "inherit",
    });

if (res.error) {
  console.error("localloom: failed to start -", res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
