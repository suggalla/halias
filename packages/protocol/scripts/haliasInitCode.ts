import { ethers } from "hardhat";

// CREATE2 init code for Halias, shared by the deploy script and its tests.
//
// This lives in one place on purpose. The address a CREATE2 deploy lands at is
// keccak(0xff ++ factory ++ salt ++ keccak(initCode)), so any disagreement about the
// constructor arguments silently moves the address — a mined vanity salt stops matching,
// and a predicted address stops being the deployed one. Two separate scripts each
// hand-rolling this encoding is how the standalone miner ended up still encoding the v0
// constructor long after it changed.
//
// Encoding goes through the contract's own ABI rather than a hand-written type list, so
// it cannot drift from the constructor at all.
export async function buildHaliasInitCode(opts: {
  poseidonT3: string;
  poseidonT4: string;
  transactVerifier: string;
  admin: string;
}): Promise<{ initCode: string; initCodeHash: string }> {
  const factory = await ethers.getContractFactory("Halias", {
    libraries: { PoseidonT3: opts.poseidonT3, PoseidonT4: opts.poseidonT4 },
  });

  // admin must be passed explicitly: under CREATE2, msg.sender in the constructor is the
  // factory, so deriving it from the caller would strand every admin function.
  const encodedArgs = factory.interface.encodeDeploy([opts.transactVerifier, opts.admin]);
  const initCode = ethers.concat([factory.bytecode, encodedArgs]);

  return { initCode, initCodeHash: ethers.keccak256(initCode) };
}

// Address a given factory/salt pair will produce, without touching the chain.
export function predictCreate2Address(factory: string, salt: string, initCodeHash: string): string {
  return ethers.getCreate2Address(factory, salt, initCodeHash);
}
