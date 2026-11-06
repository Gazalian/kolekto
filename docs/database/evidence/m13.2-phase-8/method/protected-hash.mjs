// Aggregate SHA-256 over non-ignored files in the protected paths. Prints count and aggregate only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const paths = ["apps/worker/src", "apps/worker/test", "supabase/migrations", "supabase-itest", "packages", "scripts", "package.json", "apps/worker/package.json", ".gitignore"];
const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
const files = [...new Set(out.split("\0").filter(Boolean))].sort();
const lines = [];
for (const f of files) {
  const full = path.join(repo, f);
  try {
    if (!statSync(full).isFile()) continue;
  } catch {
    continue; // tracked but deleted in the working tree
  }
  lines.push(`${f}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
}
console.log(`${lines.length} files, aggregate ${createHash("sha256").update(lines.join("\n")).digest("hex")}`);
