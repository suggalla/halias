import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { aliasHashToKey } from "./helpers/smt";
import { registerAlias } from "./helpers/register";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";

// HaliasDeployer — the three contracts brought up wired, in one transaction.
//
// The dependency between them is a cycle, and the deployment is where a cycle actually
// bites: the registry must name its controller before that contract exists. What matters
// here is not that three contracts appeared but that the loop closed on the right
// addresses, since a wrong one produces a registry authorising an address that will never
// hold code — inert, with nothing reverting to say so.

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO_PROOF  = "0x" + "00".repeat(256);
const NO_RELAYER  = { relayer: ethers.ZeroAddress, amount: 0n };

describe("HaliasDeployer", function () {
  this.timeout(120000);

  let deployer: any, registry: any, pool: any, domain: any;
  let admin: any, user: any;
  let verifier: string;

  const rand32 = () => ethers.keccak256(ethers.randomBytes(32));

  beforeEach(async function () {
    [admin, user] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    deployer = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(verifier, admin.address);

    registry = await ethers.getContractAt("HaliasRegistry", await deployer.registry());
    pool     = await ethers.getContractAt("HaliasPool",     await deployer.pool());
    domain   = await ethers.getContractAt("HaliasController",   await deployer.domain());
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
    expect(await deployer.domain()).to.equal(ethers.getCreateAddress({ from, nonce: 3 }));
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
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot:      await registry.getRegistryRoot(),
      publicAmount:      deposit,
      tokenAddress:      ethers.ZeroAddress,
      inputNullifiers:   [rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient:         ethers.ZeroAddress,
      relayerFee:        NO_RELAYER,
      externalData:      ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    }, "0x", "0x", ZERO_PROOF, { value: deposit })).wait();

    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(deposit);
  });

  it("supports a claim, which needs all three at once", async function () {
    await initPoseidon();
    // The claim path is the only flow that touches every contract: the domain writes the
    // registry, calls the pool, and is paid by it. If any reference were wrong this is
    // where it shows.
    const fee = await domain.registrationFee();
    const poolAddr = await pool.getAddress();

    const deposit = fee * 4n;
    await (await pool.connect(user).transact({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree], registryRoot: await registry.getRegistryRoot(),
      publicAmount: deposit, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    }, "0x", "0x", ZERO_PROOF, { value: deposit })).wait();

    const r = {
      owner: user.address, aliasHash: rand32(),
      spendingPubkey: ethers.toBeHex(11n, 32),
      nullifierKeyHash: ethers.toBeHex(22n, 32),
      encryptionPubkey: ethers.toBeHex(33n, 32),
    };
    const externalData = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address owner,bytes32 aliasHash,bytes32 spendingPubkey,bytes32 nullifierKeyHash,bytes32 encryptionPubkey)"],
      [r],
    ));

    await (await domain.connect(admin).claim(r, {
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree], registryRoot: await registry.getRegistryRoot(),
      publicAmount: FIELD_PRIME - fee, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: await domain.getAddress(), relayerFee: NO_RELAYER, externalData,
      // The insertion the claim's proof performs. The registry arms it from its own state
      // during the registration, and the pool requires the public signal to match.
      pendingLeaf: ethers.toBeHex(poseidonHash([
        aliasHashToKey(r.aliasHash),
        poseidonHash([BigInt(r.spendingPubkey), BigInt(r.nullifierKeyHash), 0n]),
        1n,
      ]), 32),
      outputsEmpty: false,
    }, "0x", "0x", ZERO_PROOF, "")).wait();

    expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(user.address);
    expect(await domain.accumulatedFees()).to.equal(fee);
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(deposit - fee);
  });
});
