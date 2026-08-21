import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { aliasHashToKey } from "./helpers/smt";
import { registerAlias, signClaimInvite } from "./helpers/register";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";
import { ZERO_PROOF, NO_RELAYER, rand32 } from "./helpers/tx";

// HaliasDeployer — the three contracts brought up wired, in one transaction.
//
// The dependency between them is a cycle, and the deployment is where a cycle actually
// bites: the registry must name its controller before that contract exists. What matters
// here is not that three contracts appeared but that the loop closed on the right
// addresses, since a wrong one produces a registry authorising an address that will never
// hold code — inert, with nothing reverting to say so.


describe("HaliasDeployer", function () {
  this.timeout(120000);

  let deployer: any, registry: any, pool: any, domain: any;
  let admin: any, user: any;
  let verifier: string;


  async function deployStack() {
    const [admin, user] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    const deployer = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(verifier, verifier, admin.address);

    return {
      admin, user, verifier, deployer,
      registry: await ethers.getContractAt("HaliasRegistry",   await deployer.registry()),
      pool:     await ethers.getContractAt("HaliasPool",       await deployer.pool()),
      domain:   await ethers.getContractAt("HaliasController", await deployer.controller()),
    };
  }

  beforeEach(async function () {
    ({ admin, user, verifier, deployer, registry, pool, domain } = await loadFixture(deployStack));
  });

  it("closes the cycle on the real addresses", async function () {
    // The whole point. Each reference has to name the contract that actually exists.
    expect(await registry.controller()).to.equal(await domain.getAddress());
    expect(await pool.registry()).to.equal(await registry.getAddress());
    expect(await domain.pool()).to.equal(await pool.getAddress());
    expect(await domain.registry()).to.equal(await registry.getAddress());
    expect(await pool.transactVerifier()).to.equal(verifier);
    expect(await domain.admin()).to.equal(admin.address);
  });

  it("gives all three contracts real code", async function () {
    for (const c of [registry, pool, domain]) {
      expect(await ethers.provider.getCode(await c.getAddress())).to.not.equal("0x");
    }
  });

  it("lands the children at the CREATE addresses their nonces imply", async function () {
    // Deployer nonce starts at 1, so the three sit at nonces 1, 2, 3. This is the property
    // _selfCreateAddress relies on; if it ever changed, the constructor's own assertion
    // would revert rather than deploy something inert.
    const from = await deployer.getAddress();
    expect(await deployer.registry()).to.equal(ethers.getCreateAddress({ from, nonce: 1 }));
    expect(await deployer.pool()).to.equal(ethers.getCreateAddress({ from, nonce: 2 }));
    expect(await deployer.controller()).to.equal(ethers.getCreateAddress({ from, nonce: 3 }));
  });

  it("leaves nobody but the domain able to write the registry", async function () {
    // Not the admin, and not the deployer that created it — the controller is the domain
    // and nothing grandfathers the creator in.
    const keys = [ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), rand32()] as const;
    await expect(registry.connect(admin).register(rand32(), ...keys))
      .to.be.revertedWithCustomError(registry, "NotController");
    await expect(registry.connect(user).register(rand32(), ...keys))
      .to.be.revertedWithCustomError(registry, "NotController");
    expect(await registry.controller()).to.not.equal(await deployer.getAddress());
  });

  it("holds nothing and can do nothing after construction", async function () {
    // The deployer is scaffolding. It keeps no authority over what it built and has no
    // function that could acquire any.
    const mutating = deployer.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability),
    );
    expect(mutating).to.deep.equal([]);
    expect(await ethers.provider.getBalance(await deployer.getAddress())).to.equal(0n);
  });

  it("is usable end to end straight out of the constructor", async function () {
    // Register through the domain, then move value through the pool against the registry
    // root that registration produced. Nothing else is wired up in between.
    const name = "alice.hls";
    const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(name));
    const fee = await domain.registrationFee();

    await expect(registerAlias(
      domain, user, name, ethers.toBeHex(11n, 32), ethers.toBeHex(22n, 32), rand32(), fee,
    )).to.emit(domain, "NamePublished").withArgs(aliasHash, name);

    expect(await domain.ownerOf(BigInt(aliasHash))).to.equal(user.address);
    expect(await registry.isRegistered(aliasHash)).to.equal(true);

    const deposit = ethers.parseEther("1");
    await (await pool.connect(user).transact({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot:      await registry.getRegistryRoot(),
      publicAmount:      deposit,
      tokenAddress:      ethers.ZeroAddress,
      inputNullifiers:   [rand32(), rand32(), rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient:         ethers.ZeroAddress,
      relayerFee:        NO_RELAYER,
      externalData:      ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    }, "0x", "0x", ZERO_PROOF, { value: deposit })).wait();

    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(deposit);
  });

  it("supports an invite and its claim, which need all three at once", async function () {
    await initPoseidon();
    // Together these are the only flow that touches every contract: the domain writes the
    // registry, arms a leaf on it, and calls the pool, which pays out against a root the
    // registry owns. If any reference were wrong this is where it shows.
    const fee = await domain.registrationFee();
    const poolAddr = await pool.getAddress();

    const deposit = fee * 4n;
    await (await pool.connect(user).transact({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree], registryRoot: await registry.getRegistryRoot(),
      publicAmount: deposit, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32(), rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    }, "0x", "0x", ZERO_PROOF, { value: deposit })).wait();

    const encode = (r: any) => ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address owner,bytes32 aliasHash,bytes32 spendingCommitment,bytes32 nullifierKeyHash,bytes32 encryptionPubkey)"],
      [r],
    );
    // The insertion a proof on these paths performs. The registry arms it from its own state
    // during the registration, and the pool requires the public signal to match.
    const pendingLeafFor = (r: any) => ethers.toBeHex(poseidonHash([
      aliasHashToKey(r.aliasHash),
      poseidonHash([BigInt(r.spendingCommitment), BigInt(r.nullifierKeyHash), 0n]),
      1n,
    ]), 32);
    const params = async (r: any, extra: any = {}) => ({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree], registryRoot: await registry.getRegistryRoot(),
      publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32(), rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
      externalData: ethers.keccak256(encode(r)),
      pendingLeaf: pendingLeafFor(r),
      outputsEmpty: false,
      ...extra,
    });

    // The invite: a keys-only entry, its hash forced to keccak256(spendingCommitment), paid
    // for in ETH from the wallet.
    const inviteOwner = ethers.Wallet.createRandom();
    const spendingCommitment = ethers.toBeHex(11n, 32);
    const invite = {
      owner: inviteOwner.address, aliasHash: ethers.keccak256(spendingCommitment),
      spendingCommitment, nullifierKeyHash: ethers.toBeHex(22n, 32),
      encryptionPubkey: ethers.toBeHex(33n, 32),
    };
    await (await domain.connect(admin)
      .createInvite(invite, await params(invite), "0x", "0x", ZERO_PROOF, { value: fee })).wait();
    expect(await domain.prepaidClaim(invite.aliasHash)).to.equal(inviteOwner.address);

    // The claim: a real alias, paid for by that credit rather than by the pool.
    const r = {
      owner: user.address, aliasHash: rand32(),
      spendingCommitment: ethers.toBeHex(44n, 32),
      nullifierKeyHash: ethers.toBeHex(55n, 32),
      encryptionPubkey: ethers.toBeHex(66n, 32),
    };
    const { deadline, signature } =
      await signClaimInvite(domain, inviteOwner, invite.aliasHash, r.aliasHash);
    await (await domain.connect(admin).claim(
      r, await params(r), "0x", "0x", ZERO_PROOF, "", invite.aliasHash, deadline, signature,
    )).wait();

    expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(user.address);
    // One fee, from the wallet, for both registrations — the pool still holds every wei it
    // was deposited.
    expect(await domain.accumulatedFees()).to.equal(fee);
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(deposit);
  });
});
