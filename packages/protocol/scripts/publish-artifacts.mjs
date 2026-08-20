#!/usr/bin/env node
// Publish the proving artifacts as a GitHub release, and record their hashes.
//
// The Pages workflow downloads these rather than rebuilding the circuits, because a phase-2
// ceremony draws fresh entropy every run: a rebuilt proving key does not match a verifier
// already on chain, and nothing says so — proofs generate and then verify against nothing.
//
// The checksums matter more than the transport. A 51 MB zkey off a release URL is something
// you are trusting GitHub and us for; a zkey whose SHA-256 matches the one recorded beside
// the deployment is something you can check. Whatever the artifacts are served from later —
// a release, IPFS, a CDN — the hash is what makes the copy verifiable, so it is written to
// artifacts.sha256 next to the deployment record.
//
//   node scripts/publish-artifacts.mjs                 # hash only, no upload
//   node scripts/publish-artifacts.mjs --upload        # hash, then create the release
//
// Uploading needs `gh` on PATH and authenticated (`gh auth login`), or GITHUB_TOKEN set with
// `repo` scope. Nothing here can push on its own.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TAG = process.env.ARTIFACT_TAG ?? "artifacts-v1";
const OUT = "../deployments/networks/artifacts.sha256";

const FILES = [
  "circuits/out/transact/transact_js/transact.wasm",
  "circuits/out/transact/ceremony/transact_final.zkey",
  "circuits/out/transactClaim/transactClaim_js/transactClaim.wasm",
  "circuits/out/transactClaim/ceremony/transactClaim_final.zkey",
];

const missing = FILES.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`Missing:\n  ${missing.join("\n  ")}\n\nRun: npm run circuits:build`);
  process.exit(1);
}

const lines = [];
for (const f of FILES) {
  const buf = readFileSync(f);
  const sum = createHash("sha256").update(buf).digest("hex");
  const name = f.split("/").pop();
  console.log(`${sum}  ${name}  ${(buf.length / 1e6).toFixed(1)} MB`);
  lines.push(`${sum}  ${name}`);
}

writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`\nWrote ${OUT}`);

if (!process.argv.includes("--upload")) {
  console.log("\nRe-run with --upload to create the release, or attach the four files by hand at");
  console.log("  Releases -> Draft a new release -> tag " + TAG);
  process.exit(0);
}

try {
  execFileSync("gh", ["--version"], { stdio: "ignore" });
} catch {
  console.error(
    "\n`gh` is not on PATH. Either install it (https://cli.github.com), or attach the four\n" +
    "files by hand under Releases -> Draft a new release, tagged " + TAG + "."
  );
  process.exit(1);
}

// --clobber so re-running after a circuit change replaces the assets rather than failing on
// a name that already exists. The artifacts and the deployed verifier move together, so a
// stale asset under a live tag is the one state worth making hard to reach.
const existing = (() => {
  try { execFileSync("gh", ["release", "view", TAG], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

if (existing) {
  console.log(`\nRelease ${TAG} exists — uploading over it.`);
  execFileSync("gh", ["release", "upload", TAG, ...FILES, OUT, "--clobber"], { stdio: "inherit" });
} else {
  console.log(`\nCreating release ${TAG}.`);
  execFileSync("gh", [
    "release", "create", TAG, ...FILES, OUT,
    "--title", "Proving artifacts",
    "--notes",
    "Proving keys and witness generators for the deployed verifiers.\n\n" +
    "These are not reproducible: a phase-2 ceremony draws fresh entropy, so rebuilding the\n" +
    "circuits yields a different key that will not verify against the deployed contracts.\n" +
    "Check a download against artifacts.sha256 rather than against a rebuild.",
  ], { stdio: "inherit" });
}
console.log("\nDone.");
