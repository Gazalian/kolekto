#!/usr/bin/env node
/**
 * The dependency audit (SEC-30), with written exceptions.
 *
 * This is `npm audit --audit-level=high` with one addition: an advisory that
 * has no upstream fix can be accepted, but only by name, only with a record in
 * docs/security/dependency-audit-exceptions.md, and only until its review date.
 * Everything else at high or critical still fails the run, exactly as before.
 *
 * An exception also fails the run when:
 *   · its `reviewBy` date has passed — somebody has to look again
 *   · it no longer matches any advisory — the fix landed, so delete the entry
 *   · it is marked `devOnly` but the advisory appears in the production tree
 *     (`npm audit --omit=dev`) — the reason it was accepted is no longer true
 *
 * Usage: node scripts/security/audit.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const FAILING = new Set(["high", "critical"]);

const { exceptions } = JSON.parse(readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);

/** Every advisory npm reports, keyed by GHSA id. */
function advisories(extraArgs = []) {
  const result = spawnSync("npm", ["audit", "--json", ...extraArgs], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error("npm audit did not return JSON:\n" + result.stdout + result.stderr);
    process.exit(1);
  }
  if (report.error) {
    console.error("npm audit failed: " + JSON.stringify(report.error));
    process.exit(1);
  }

  // An advisory appears as an object in the `via` of the package it affects;
  // the packages that merely depend on that one list it by name. Collecting
  // the objects is therefore the full set of advisories, once each.
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via !== "object") continue;
      const id = via.url.split("/").pop();
      found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return found;
}

const all = advisories();
const production = advisories(["--omit=dev"]);
const problems = [];

for (const advisory of all.values()) {
  if (!FAILING.has(advisory.severity)) continue;
  const exception = exceptions.find((entry) => entry.advisory === advisory.id);
  if (!exception) {
    problems.push(`${advisory.severity}: ${advisory.package} — ${advisory.title} (${advisory.url})`);
  } else if (exception.package !== advisory.package) {
    problems.push(`exception ${exception.advisory} names ${exception.package}, but npm reports it against ${advisory.package}`);
  }
}

for (const exception of exceptions) {
  if (!all.has(exception.advisory)) {
    problems.push(`exception ${exception.advisory} (${exception.package}) no longer matches any advisory — remove it`);
  }
  if (exception.reviewBy < today) {
    problems.push(`exception ${exception.advisory} (${exception.package}) passed its review date ${exception.reviewBy}`);
  }
  if (exception.devOnly && production.has(exception.advisory)) {
    problems.push(`exception ${exception.advisory} (${exception.package}) is marked devOnly but is in the production dependency tree`);
  }
}

for (const exception of exceptions) {
  if (all.has(exception.advisory)) {
    console.log(`accepted: ${exception.advisory} ${exception.package} (${exception.severity}), review by ${exception.reviewBy}`);
  }
}

if (problems.length > 0) {
  console.error("\nDependency audit failed:\n" + problems.map((problem) => "  " + problem).join("\n"));
  console.error("\nExceptions are recorded in docs/security/dependency-audit-exceptions.md.");
  process.exit(1);
}

console.log("Dependency audit passed: no unaccepted high or critical advisories.");
