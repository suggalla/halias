import { expect } from "chai";
import { ethers } from "hardhat";
// The alias token is displayable but not tradeable. Ownership may only move through
// transferAliasWithKeys, which rotates the spending keys in the same step.
describe("Alias token surface", function () {
  this.timeout(180000);

  let halias: any, owner: any, other: any;
  let aliasHash: string;

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), (await ethers.getSigners())[0].address);

    aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await halias.register(
      aliasHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.keccak256(ethers.randomBytes(32)),
      { value: await halias.registrationFee() },
    );
  });

  it("mints the alias to the registrant", async function () {
    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(owner.address);
  });

  it("blocks transferFrom", async function () {
    await expect(halias.transferFrom(owner.address, other.address, BigInt(aliasHash)))
      .to.be.revertedWithCustomError(halias, "UseTransferAliasWithKeys");
  });

  it("blocks both safeTransferFrom overloads", async function () {
    await expect(
      halias["safeTransferFrom(address,address,uint256)"](owner.address, other.address, BigInt(aliasHash)),
    ).to.be.revertedWithCustomError(halias, "UseTransferAliasWithKeys");
    await expect(
      halias["safeTransferFrom(address,address,uint256,bytes)"](owner.address, other.address, BigInt(aliasHash), "0x"),
    ).to.be.revertedWithCustomError(halias, "UseTransferAliasWithKeys");
  });

  it("blocks approve and setApprovalForAll", async function () {
    await expect(halias.approve(other.address, BigInt(aliasHash)))
      .to.be.revertedWithCustomError(halias, "AliasApprovalsDisabled");
    await expect(halias.setApprovalForAll(other.address, true))
      .to.be.revertedWithCustomError(halias, "AliasApprovalsDisabled");
  });

  it("reports no approvals, since none can be granted", async function () {
    expect(await halias.getApproved(BigInt(aliasHash))).to.equal(ethers.ZeroAddress);
    expect(await halias.isApprovedForAll(owner.address, other.address)).to.equal(false);
  });

  it("moves ownership and rotates keys together via transferAliasWithKeys", async function () {
    const newPubkey = ethers.toBeHex(11n, 32);
    const newNKHash = ethers.toBeHex(22n, 32);
    await halias.transferAliasWithKeys(
      aliasHash, other.address, newPubkey, newNKHash, ethers.keccak256(ethers.randomBytes(32)),
    );
    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(other.address);
    const stored = await halias.aliases(aliasHash);
    expect(stored.spendingPubkey).to.equal(newPubkey);
    expect(stored.nullifierKeyHash).to.equal(newNKHash);
  });
});
