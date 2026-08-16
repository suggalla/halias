const fs = require("fs");
const path = require("path");
const { config, getResolvedPaths } = require("./config");
const { exportSolidityVerifier } = require("./zksnark");

function parseArgs(): { circuit: string } {
  const args = process.argv.slice(2);
  let circuit = config.circuit;

  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case "-c":
      case "--circuit":
        circuit = args[i + 1];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return { circuit };
}

async function main() {
  const { circuit } = parseArgs();
  const paths = getResolvedPaths({ circuit });

  console.log(`Exporting Solidity verifier for '${circuit}'...\n`);

  const code: string = await exportSolidityVerifier(paths.zkeyFinal);

  const outDir = path.resolve(__dirname, "..", "contracts");
  fs.mkdirSync(outDir, { recursive: true });

  const contractName = config.contractName ?? `${circuit.charAt(0).toUpperCase() + circuit.slice(1)}Verifier`;
  const filename = `${contractName}.sol`;
  const outPath = path.join(outDir, filename);
  const renamedCode = code.replace(/contract\s+Groth16Verifier\b/, `contract ${contractName}`);
  fs.writeFileSync(outPath, renamedCode);

  console.log(`Verifier written to ${outPath}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
