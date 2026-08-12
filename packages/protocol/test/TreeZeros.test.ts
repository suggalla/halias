import { expect } from "chai";
import { ethers } from "hardhat";
import { ensurePoseidon } from "../scripts/poseidon";

// The empty-subtree hashes are constants in TreeZeros rather than a storage array seeded at
// construction. That is only safe while the constants are exactly the chain the hash function
// produces — a mistyped digit would not fail loudly. It would give the tree a wrong empty
// sibling at one level, producing roots that no proof can satisfy, with nothing to say why.
//
// So this recomputes the chain on chain, with the same PoseidonT3 the trees use, and pins
// every entry. It is the reason those constants may be trusted.
describe("TreeZeros", function () {
  let zeros: any;
  let poseidon: any;

  before(async function () {
    const { PoseidonT3 } = await ensurePoseidon();
    poseidon = new ethers.Contract(
      PoseidonT3, ["function hash(uint256[2]) pure returns (uint256)"], ethers.provider);
    zeros = await (await ethers.getContractFactory("TreeZerosHarness")).deploy();
  });

  it("is the Poseidon chain from zero, at every level", async function () {
    // 0..32 inclusive: the pool reads up to LEVELS and the registry up to REGISTRY_LEVELS,
    // and _initSMT reads the root level itself, so the deepest entry must exist.
    let expected = ethers.ZeroHash;
    for (let i = 0; i <= 32; i++) {
      expect(await zeros.at(i), `zeros(${i})`).to.equal(expected);
      expected = ethers.zeroPadValue(
        ethers.toBeHex(await poseidon["hash(uint256[2])"]([expected, expected])), 32);
    }
  });

  it("rejects a level past the end rather than returning zero", async function () {
    // Silently returning bytes32(0) for an out-of-range level would be indistinguishable from
    // level 0 and would corrupt a tree that grew deeper than this table.
    await expect(zeros.at(33)).to.be.revertedWithCustomError(zeros, "ZeroLevelOutOfRange");
  });
});
