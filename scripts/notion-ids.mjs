// Looks up the Notion property IDs for every column the app uses and writes
// them into lib/notion-props.json. Run once:  npm run notion:ids
// IDs don't change when a column is renamed. Re-run only if a column is
// deleted and re-created, or a new field is added to the app.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const propsFile = resolve(root, "lib", "notion-props.json");

for (const f of [".env.local", ".env"]) {
  const p = resolve(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("NOTION_TOKEN is missing. Add it to .env.local first.");
  process.exit(1);
}

const databases = {
  supervisors: process.env.NOTION_SUPERVISORS_DB,
  projects: process.env.NOTION_PROJECTS_DB,
  buildings: process.env.NOTION_BUILDINGS_DB,
  elevations: process.env.NOTION_ELEVATIONS_DB,
};

const current = JSON.parse(readFileSync(propsFile, "utf8"));
const out = { _note: current._note };
let problems = 0;

for (const [group, dbId] of Object.entries(databases)) {
  if (!dbId) {
    console.error(`Missing env var for ${group} database.`);
    process.exit(1);
  }
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  if (!res.ok) {
    console.error(`Could not read ${group} database (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const db = await res.json();
  const schema = Object.values(db.properties);

  out[group] = {};
  console.log(`\n${group}`);
  for (const [field, key] of Object.entries(current[group])) {
    const match = schema.find((p) => p.id === key || p.name === key);
    if (!match) {
      problems++;
      out[group][field] = key;
      console.log(`  ✗ ${field}: no column "${key}". Columns: ${schema.map((p) => p.name).join(", ")}`);
      continue;
    }
    out[group][field] = match.id;
    console.log(`  ✓ ${field.padEnd(15)} ${match.name}  →  ${match.id}`);
  }
}

writeFileSync(propsFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${propsFile}`);
if (problems) {
  console.log(`${problems} field(s) not found. Put the current column name in lib/notion-props.json and run again.`);
  process.exit(1);
}