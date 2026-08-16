import { ethers } from "hardhat";
import { ensurePoseidon } from "../../scripts/poseidon";

// The three contracts, deployed wired together, as production does it.
//
// Four suites had their own copy of this and three were the same code: deploy a verifier,
// hand it to HaliasDeployer, read back the three addresses. The fourth — HaliasController's —
// is deliberately different: it builds the dependency cycle by hand with a predicted nonce
// address, which is the shape it exists to exercise, so it stays where it is.
//
// Going through HaliasDeployer rather than deploying three contracts separately matters: it
// is the only arrangement where the cycle is closed the way it will be on a real chain, so a
// suite that wires them by hand is testing a configuration nobody deploys.

export interface Stack {
  pool: any;
  registry: any;
  controller: any;
  verifier: string;
  admin: any;
}

/// Deploy the stack.
///
/// `realVerifier` swaps MockTransactVerifier — which accepts anything — for the exported
/// Groth16 one. Only the suites that generate real proofs want it; everywhere else it would
/// mean every test needed a valid proof to reach the behaviour it was actually about.
export async function deployStack(opts: { realVerifier?: boolean } = {}): Promise<Stack> {
  const [admin] = await ethers.getSigners();
  const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();

  const verifier = await (
    await ethers.getContractFactory(opts.realVerifier ? "TransactVerifier" : "MockTransactVerifier")
  ).deploy();
  const verifierAddr = await verifier.getAddress();

  const deployer = await (await ethers.getContractFactory("HaliasDeployer", {
    libraries: { PoseidonT3: t3, PoseidonT4: t4 },
  })).deploy(verifierAddr, verifierAddr, admin.address);

  return {
    admin,
    verifier: verifierAddr,
    pool:       await ethers.getContractAt("HaliasPool",       await deployer.pool()),
    registry:   await ethers.getContractAt("HaliasRegistry",   await deployer.registry()),
    controller: await ethers.getContractAt("HaliasController", await deployer.controller()),
  };
}
