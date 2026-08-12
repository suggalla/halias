import { ethers } from "hardhat";

/// Puts the canonical Poseidon libraries on whatever chain this is, and returns their
/// addresses for library linking.
///
/// This works on a fresh local node, which is the part that looks impossible: the addresses
/// are "canonical" because they come out of a deterministic proxy, not because some registry
/// blesses them. Where the chain has neither the libraries nor the proxy, both are created
/// here and land on exactly the same addresses they occupy on mainnet.
///
/// Why tests should use it rather than `getContractFactory("PoseidonT3").deploy()`: our own
/// build of the same source is compiled under `viaIR`, which makes it 29,315 bytes against
/// the canonical 23,478 — over EIP-170, so it cannot be deployed to a real chain at all —
/// and twice as expensive to call, 79,622 gas against 39,393. A suite linking our build
/// exercises a contract that will never be deployed and reports gas nobody will pay.
///
/// Both produce identical hashes, so this changes no root and no proof.
export async function ensurePoseidon(): Promise<{ PoseidonT3: string; PoseidonT4: string }> {
  const { proxy, PoseidonT3, PoseidonT4 } = require("poseidon-solidity");
  const [deployer] = await ethers.getSigners();

  if ((await ethers.provider.getCode(proxy.address)) === "0x") {
    // Nick's method: fund a keyless address, then broadcast a transaction it signed with no
    // private key in existence. The transaction is pre-EIP-155 — no chain id — which is what
    // makes it replayable onto any chain, and also what a few chains refuse to accept.
    await (await deployer.sendTransaction({ to: proxy.from, value: proxy.gas })).wait();
    await (await ethers.provider.broadcastTransaction(proxy.tx)).wait();
    if ((await ethers.provider.getCode(proxy.address)) === "0x") {
      throw new Error(
        `deterministic-deployment proxy could not be created at ${proxy.address}. ` +
        `This chain most likely rejects the pre-EIP-155 transaction Nick's method uses.`,
      );
    }
  }

  for (const lib of [PoseidonT3, PoseidonT4]) {
    if ((await ethers.provider.getCode(lib.address)) === "0x") {
      await (await deployer.sendTransaction({ to: proxy.address, data: lib.data })).wait();
      if ((await ethers.provider.getCode(lib.address)) === "0x") {
        throw new Error(`Poseidon library was not created at ${lib.address}`);
      }
    }
  }

  return { PoseidonT3: PoseidonT3.address, PoseidonT4: PoseidonT4.address };
}

/// Poseidon over BN254, from circomlibjs — the implementation the circuits use.
const CHECK = {
  PoseidonT3: { args: [1n, 2n],     out: 7853200120776062878684798364095072458815029376092732009249414926327459813530n },
  PoseidonT4: { args: [1n, 2n, 3n], out: 6542985608222806190361240322586112750744169038454362455181422643027100751666n },
};

/// Confirms the libraries at those addresses actually hash correctly.
///
/// Bytecode comparison is not available here — the canonical build is the package's, not ours
/// — so behaviour is what gets checked. A wrong library at the right address produces roots no
/// proof can satisfy, and a deploy touches nothing else that hashes.
export async function verifyPoseidon(addrs: { PoseidonT3: string; PoseidonT4: string }): Promise<void> {
  for (const name of ["PoseidonT3", "PoseidonT4"] as const) {
    const { args, out } = CHECK[name];
    const data = ethers.concat([
      ethers.id(`hash(uint256[${args.length}])`).slice(0, 10),
      ethers.AbiCoder.defaultAbiCoder().encode([`uint256[${args.length}]`], [args]),
    ]);
    const got = BigInt(await ethers.provider.call({ to: addrs[name], data }));
    if (got !== out) throw new Error(`${name} at ${addrs[name]} hashed ${got}, expected ${out}`);
  }
}
