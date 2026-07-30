import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expectedRepository = "https://github.com/stralner2711-a11y/pladetjek";
const expectedSupabase = "https://uolrwogzfegrdjbjvsvu.supabase.co";
const files = [
  ".env.example",
  "README.md",
  "package.json",
  "src/update-system.ts",
  "android/app/src/main/java/dk/pladetjek/app/AppUpdaterPlugin.java",
  "supabase/README.md",
];

for (const file of files) {
  const content = readFileSync(resolve(root, file), "utf8");
  if (/stralner2711-a11y\/xpresshub/i.test(content)) {
    throw new Error(`${file} peger fejlagtigt på XpressHub.`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (packageJson.repository?.url !== `${expectedRepository}.git`) {
  throw new Error("package.json peger ikke på det officielle Pladetjek-repository.");
}

const environmentExample = readFileSync(resolve(root, ".env.example"), "utf8");
if (!environmentExample.includes(`VITE_SUPABASE_URL=${expectedSupabase}`)) {
  throw new Error("Supabase-projektet i .env.example er ikke det officielle Pladetjek-projekt.");
}

try {
  const origin = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
  }).trim().replace(/\.git$/, "");
  if (origin !== expectedRepository) {
    throw new Error(`Git origin er ${origin}; forventede ${expectedRepository}.`);
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Git origin er")) throw error;
  throw new Error("Git origin kunne ikke verificeres.");
}

console.log("Projektgrænser verificeret: Pladetjek GitHub + separat Supabase.");
