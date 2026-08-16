const fs = require("fs");
const path = require("path");

interface HaliasConfig {
  circuit: string;
  contractName?: string;
  power: number;
  paths: {
    circuitsDir: string;
    outDir: string;
    ceremonyDir: string;
  };
  filenames: {
    r1cs: string;
    wasm: string;
    wtns: string;
    ptauInitial: string;
    ptauContributed: string;
    ptauFinal: string;
    zkeyInitial: string;
    zkeyFinal: string;
    verificationKey: string;
  };
}

interface ResolvedPaths {
  circuitsDir: string;
  outDir: string;
  ceremonyDir: string;
  r1cs: string;
  wasm: string;
  wtns: string;
  ptauInitial: string;
  ptauContributed: string;
  ptauFinal: string;
  zkeyInitial: string;
  zkeyFinal: string;
  verificationKey: string;
}

interface PathOverrides {
  circuit?: string;
  power?: number;
  outDir?: string;
  ceremonyDir?: string;
}

function findProjectRoot(): string {
  let dir = __dirname;
  while (true) {
    if (fs.existsSync(path.join(dir, "halias.config.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find halias.config.json in any parent directory");
    }
    dir = parent;
  }
}

function loadConfig(): HaliasConfig {
  const root = findProjectRoot();
  const raw = fs.readFileSync(path.join(root, "halias.config.json"), "utf-8");
  return JSON.parse(raw) as HaliasConfig;
}

function interpolate(template: string, circuit: string): string {
  return template.replace(/\{circuit\}/g, circuit);
}

function resolve(overrides?: PathOverrides): ResolvedPaths {
  const root = findProjectRoot();
  const circuit = overrides?.circuit ?? config.circuit;

  const outDir = overrides?.outDir
    ? path.resolve(overrides.outDir)
    : path.resolve(root, interpolate(config.paths.outDir, circuit));

  const ceremonyDir = overrides?.ceremonyDir
    ? path.resolve(overrides.ceremonyDir)
    : path.resolve(root, interpolate(config.paths.ceremonyDir, circuit));

  const circuitsDir = path.resolve(root, config.paths.circuitsDir);

  return {
    circuitsDir,
    outDir,
    ceremonyDir,
    r1cs: path.join(outDir, interpolate(config.filenames.r1cs, circuit)),
    wasm: path.join(outDir, interpolate(config.filenames.wasm, circuit)),
    wtns: path.join(outDir, interpolate(config.filenames.wtns, circuit)),
    ptauInitial: path.join(ceremonyDir, interpolate(config.filenames.ptauInitial, circuit)),
    ptauContributed: path.join(ceremonyDir, interpolate(config.filenames.ptauContributed, circuit)),
    ptauFinal: path.join(ceremonyDir, interpolate(config.filenames.ptauFinal, circuit)),
    zkeyInitial: path.join(ceremonyDir, interpolate(config.filenames.zkeyInitial, circuit)),
    zkeyFinal: path.join(ceremonyDir, interpolate(config.filenames.zkeyFinal, circuit)),
    verificationKey: path.join(ceremonyDir, interpolate(config.filenames.verificationKey, circuit)),
  };
}

const config: HaliasConfig = loadConfig();
const resolvedPaths: ResolvedPaths = resolve();

function getResolvedPaths(overrides?: PathOverrides): ResolvedPaths {
  return resolve(overrides);
}

module.exports = { config, resolvedPaths, getResolvedPaths };
