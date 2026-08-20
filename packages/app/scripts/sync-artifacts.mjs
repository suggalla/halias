// Put the proving artifacts where the app can serve them.
//
// Copies from the protocol package when it has been built, and otherwise leaves alone
// whatever is already in static/artifacts. That second case is CI: the artifacts there are
// downloaded from a release rather than compiled, and they must be, because a ceremony uses
// fresh entropy every run. Rebuilding the circuits in CI would produce a proving key that
// does not match the verifier deployed on chain, and the failure is silent — proofs generate
// happily and then verify against nothing.
//
// Missing in both places is a hard error. A build that quietly ships without a proving key
// looks fine until someone tries to send.
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = "static/artifacts";
const SRC = "../protocol/circuits/out";

const WANTED = [
  [`${SRC}/transact/transact_js/transact.wasm`, "transact.wasm"],
  [`${SRC}/transact/ceremony/transact_final.zkey`, "transact_final.zkey"],
  [`${SRC}/transactClaim/transactClaim_js/transactClaim.wasm`, "transactClaim.wasm"],
  [`${SRC}/transactClaim/ceremony/transactClaim_final.zkey`, "transactClaim_final.zkey"],
];

mkdirSync(OUT, { recursive: true });

const missing = [];
for (const [from, name] of WANTED) {
  const to = join(OUT, name);
  if (existsSync(from)) {
    copyFileSync(from, to);
    console.log(`  copied  ${name}  ${(statSync(to).size / 1e6).toFixed(1)} MB`);
  } else if (existsSync(to)) {
    console.log(`  present ${name}  ${(statSync(to).size / 1e6).toFixed(1)} MB (not rebuilt)`);
  } else {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(
    `\nMissing proving artifacts: ${missing.join(", ")}\n\n` +
    `Either build them:      cd ../protocol && npm run circuits:build\n` +
    `or place them in:       packages/app/${OUT}/\n\n` +
    `They must be the same artifacts the deployed verifier was exported from — a locally\n` +
    `regenerated proving key will not verify against a contract already on chain.\n`
  );
  process.exit(1);
}
