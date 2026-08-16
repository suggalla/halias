const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { config, getResolvedPaths } = require("./config");

interface CeremonyOptions {
  circuit: string;
  power: number;
  outDir: string;
  entropy: string;
  dev: boolean; // skip ptau contribution (insecure, dev/testnet only)
}

function parseArgs(): CeremonyOptions {
  const args = process.argv.slice(2);
  const opts: CeremonyOptions = {
    circuit: config.circuit,
    power: config.power,
    outDir: "",
    entropy: crypto.randomBytes(32).toString("hex"),
    dev: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-c":
      case "--circuit":
        opts.circuit = args[++i];
        break;
      case "-p":
      case "--power":
        opts.power = parseInt(args[++i], 10);
        break;
      case "-o":
      case "--outdir":
        opts.outDir = path.resolve(args[++i]);
        break;
      case "-e":
      case "--entropy":
        opts.entropy = args[++i];
        break;
      case "--dev":
        opts.dev = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

// Runs snarkjs CLI with a large heap — avoids WASM worker memory crashes
// that occur when using the programmatic API for power>=18.
function snarkjsCli(args: string, expectFile?: string): void {
  const snarkjsBin = path.join(path.dirname(require.resolve("snarkjs")), "cli.cjs");
  console.log(`  $ node snarkjs ${args.split(" ")[0]} ...`);
  execSync(`node --max-old-space-size=8192 "${snarkjsBin}" ${args}`, { stdio: "inherit" });
  if (expectFile) {
    const size = fs.existsSync(expectFile) ? fs.statSync(expectFile).size : 0;
    console.log(`  → ${path.basename(expectFile)}: ${size > 0 ? size + " bytes ✓" : "MISSING or empty ✗"}`);
    if (size === 0) throw new Error(`Expected output not created: ${expectFile}`);
  }
}

async function main() {
  const opts = parseArgs();
  const paths = getResolvedPaths({
    circuit: opts.circuit,
    ...(opts.outDir ? { outDir: opts.outDir } : {}),
  });

  if (!fs.existsSync(paths.r1cs)) {
    console.error(`Error: R1CS not found at ${paths.r1cs}`);
    process.exit(1);
  }

  fs.mkdirSync(paths.ceremonyDir, { recursive: true });

  console.log("\nResolved paths:");
  console.log("  r1cs:        ", paths.r1cs);
  console.log("  ptauInitial: ", paths.ptauInitial);
  console.log("  ptauFinal:   ", paths.ptauFinal);
  console.log("  zkeyInitial: ", paths.zkeyInitial);
  console.log("  zkeyFinal:   ", paths.zkeyFinal);
  console.log("  vkey:        ", paths.verificationKey);

  // Phase 1: Powers of Tau (circuit-independent)
  // Checkpointed: skips steps already completed.
  // For production: replace pot_final.ptau with a multi-party PPOT file.
  if (fs.existsSync(paths.ptauFinal)) {
    console.log(`\n=== Using existing Powers of Tau: ${path.basename(paths.ptauFinal)} ===\n`);
  } else {
    console.log(`\n=== Powers of Tau Ceremony (2^${opts.power}) ===\n`);

    if (!fs.existsSync(paths.ptauInitial)) {
      console.log("[1/5] Starting new ceremony...");
      snarkjsCli(`powersoftau new bn128 ${opts.power} "${paths.ptauInitial}"`, paths.ptauInitial);
    } else {
      console.log("[1/5] Reusing existing accumulator.");
    }

    // Always contribute — skipping leaves IC points at infinity, breaking all proofs.
    if (!fs.existsSync(paths.ptauContributed)) {
      const label = opts.dev ? "dev (insecure)" : "First contribution";
      console.log(`[2/5] Contributing to ceremony (${label})...`);
      snarkjsCli(`powersoftau contribute "${paths.ptauInitial}" "${paths.ptauContributed}" -n="${label}" -e="${opts.entropy}"`, paths.ptauContributed);
    } else {
      console.log("[2/5] Reusing existing contribution.");
    }
    const ptauForPhase2 = paths.ptauContributed;

    console.log("[3/5] Preparing phase 2...");
    snarkjsCli(`powersoftau prepare phase2 "${ptauForPhase2}" "${paths.ptauFinal}" -v`, paths.ptauFinal);
  }

  // Phase 2: Circuit-specific Groth16 setup
  console.log(`\n=== Groth16 Setup for '${opts.circuit}' ===\n`);

  console.log("[4/5] Generating proving key (.zkey)...");
  if (!fs.existsSync(paths.zkeyInitial)) {
    snarkjsCli(`groth16 setup "${paths.r1cs}" "${paths.ptauFinal}" "${paths.zkeyInitial}"`, paths.zkeyInitial);
  } else {
    console.log("  Reusing existing initial zkey.");
  }

  if (opts.dev) {
    console.log("  Skipping zkey contribution (--dev mode) — copying initial zkey as final.");
    fs.copyFileSync(paths.zkeyInitial, paths.zkeyFinal);
  } else {
    // Use beacon contribution for single-contributor ceremonies (non-interactive).
    // For multi-party production ceremony, replace with proper MPC contributions.
    const beaconHash = opts.entropy.slice(0, 64).padEnd(64, "0");
    snarkjsCli(`zkey beacon "${paths.zkeyInitial}" "${paths.zkeyFinal}" ${beaconHash} 10`, paths.zkeyFinal);
  }

  console.log("[5/5] Exporting verification key...");
  snarkjsCli(`zkey export verificationkey "${paths.zkeyFinal}" "${paths.verificationKey}"`, paths.verificationKey);

  console.log(`\n=== Done ===`);
  console.log(`Artifacts in ${paths.ceremonyDir}/:`);
  console.log(`  Proving key:      ${path.basename(paths.zkeyFinal)}`);
  console.log(`  Verification key: ${path.basename(paths.verificationKey)}`);
  console.log(`  Phase 1 ptau:     ${path.basename(paths.ptauFinal)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
