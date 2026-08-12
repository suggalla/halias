import { expect } from "chai";
import { ethers } from "hardhat";
import {
  computeParamsHash, encodeRegistration, buildTransactParams,
  POOL_ABI, POOL_REGISTRY_ABI as REGISTRY_ABI, DOMAIN_ABI,
  NO_RELAYER, type TransactParams,
} from "halias-sdk";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";

// The SDK's paramsHash, checked against the pool's own.
//
// This is the gap that let the split break the SDK silently. `paramsHash` is a public
// signal: the circuit constrains it without interpreting it, so if the SDK's preimage
// differs from the contract's by one byte the result is not a decoding error or a revert
// with a name — it is a proof that verifies against nothing, on a transaction that looks
// well formed. SdkAbi.test.ts compares ABI fragments and cannot see this at all.
//
// It became a live problem when the relayer fee moved from a packed `address || uint96`
// word into a two-member struct. Nothing in the build would have caught it.

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("SDK preimage agreement", function () {
  this.timeout(120000);

  let pool: any, registry: any, domain: any, poolAddr: string;
  let chainId: bigint;
  let signer: any, other: any;

  const rand32  = () => ethers.keccak256(ethers.randomBytes(32));
  const randBig = () => BigInt(rand32());

  before(async function () {
    [signer, other] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    const deployer = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(verifier, signer.address);

    pool     = await ethers.getContractAt("HaliasPool",     await deployer.pool());
    registry = await ethers.getContractAt("HaliasRegistry", await deployer.registry());
    domain   = await ethers.getContractAt("HaliasDomain",   await deployer.domain());
    poolAddr = await pool.getAddress();
    chainId  = (await ethers.provider.getNetwork()).chainId;
  });

  async function assertAgrees(params: TransactParams, enc0: string, enc1: string) {
    const root = BigInt((await anchorOf(pool)).root);
    const p = buildTransactParams(
      [root, root], [0, 0], BigInt(await registry.getRegistryRoot()),
      0n, 0n, [randBig(), randBig()], [randBig(), randBig()], params,
    );
    const onChain = await pool.computeParamsHash(p, enc0, enc1);
    const offChain = computeParamsHash(params, enc0, enc1, chainId, poolAddr);
    expect(offChain).to.equal(onChain);
    return onChain;
  }

  it("agrees on the trivial case", async function () {
    await assertAgrees(
      { recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER, externalData: ethers.ZeroHash },
      "0x", "0x",
    );
  });

  it("agrees with a relayer fee, which is the field that changed shape", async function () {
    // Previously address(20) || uint96(12) packed into one word; now a struct of two words.
    // A stale SDK produces a syntactically valid but unverifiable proof.
    await assertAgrees(
      { recipient: other.address, relayerFee: { relayer: signer.address, amount: 12345n }, externalData: ethers.ZeroHash },
      "0x", "0x",
    );
  });

  it("agrees on a fee above the old uint96 ceiling", async function () {
    await assertAgrees(
      { recipient: other.address, relayerFee: { relayer: signer.address, amount: (1n << 100n) + 7n }, externalData: rand32() },
      "0xdeadbeef", "0xc0ffee",
    );
  });

  it("agrees across many random inputs", async function () {
    // Fuzzing the preimage rather than a fixture: a field that is merely in the wrong
    // position often still matches for zero values.
    for (let i = 0; i < 12; i++) {
      await assertAgrees({
        recipient:    ethers.Wallet.createRandom().address,
        relayerFee:   { relayer: ethers.Wallet.createRandom().address, amount: randBig() % (1n << 200n) },
        externalData: rand32(),
      }, ethers.hexlify(ethers.randomBytes(i * 3)), ethers.hexlify(ethers.randomBytes(64 - i)));
    }
  });

  it("changes when any single field changes", async function () {
    // Agreement on a constant is not agreement; both sides could ignore the same field.
    const base: TransactParams = {
      recipient: other.address,
      relayerFee: { relayer: signer.address, amount: 5n },
      externalData: rand32(),
    };
    const h = await assertAgrees(base, "0xaa", "0xbb");

    const variants: TransactParams[] = [
      { ...base, recipient: signer.address },
      { ...base, relayerFee: { relayer: other.address, amount: 5n } },
      { ...base, relayerFee: { relayer: signer.address, amount: 6n } },
      { ...base, externalData: rand32() },
    ];
    for (const v of variants) {
      expect(await assertAgrees(v, "0xaa", "0xbb")).to.not.equal(h);
    }
    expect(await assertAgrees(base, "0xab", "0xbb")).to.not.equal(h);
    expect(await assertAgrees(base, "0xaa", "0xbc")).to.not.equal(h);
  });

  it("stays inside the field", async function () {
    for (let i = 0; i < 5; i++) {
      const h = await assertAgrees({
        recipient: ethers.Wallet.createRandom().address,
        relayerFee: { relayer: ethers.Wallet.createRandom().address, amount: randBig() % (1n << 200n) },
        externalData: rand32(),
      }, "0x", "0x");
      expect(h).to.be.lessThan(FIELD_PRIME);
    }
  });

  it("agrees on the Registration hash the domain requires for a claim", async function () {
    // Same class of failure on the claim path: a mismatch here is ClaimNotAuthorised with
    // no indication that the encoding, rather than the caller, was wrong.
    const r = {
      owner: other.address,
      aliasHash: randBig(), spendingPubkey: randBig() % FIELD_PRIME,
      nullifierKeyHash: randBig() % FIELD_PRIME, encryptionPubkey: randBig(),
    };
    const offChain = encodeRegistration(r);
    const onChain = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address,bytes32,bytes32,bytes32,bytes32)"],
      [[r.owner, ethers.toBeHex(r.aliasHash, 32), ethers.toBeHex(r.spendingPubkey, 32),
        ethers.toBeHex(r.nullifierKeyHash, 32), ethers.toBeHex(r.encryptionPubkey, 32)]],
    ));
    expect(offChain).to.equal(onChain);
  });

  it("matches the compiled artifacts fragment for fragment", async function () {
    // Signature agreement, which is what SdkAbi.test.ts does for the monolith. Kept beside
    // the preimage check so the two failure modes are visible together.
    const check = (abi: string[], artifactName: string) => {
      const iface = new ethers.Interface(abi);
      const artifact = require(`/tmp/halias-artifacts/contracts/${artifactName}.sol/${artifactName}.json`);
      const real = new ethers.Interface(artifact.abi);
      for (const f of iface.fragments) {
        if (f.type !== "function" && f.type !== "event") continue;
        const sig = (f as any).format("sighash");
        const found = f.type === "function" ? real.getFunction(sig) : real.getEvent(sig);
        expect(found, `${artifactName} missing ${sig}`).to.not.equal(null);
        // "minimal" rather than "full": parameter names are documentation, but types,
        // ordering, mutability and indexed-ness all change how calldata and logs decode.
        expect((found as any).format("minimal")).to.equal((f as any).format("minimal"));
      }
    };
    check(POOL_ABI, "HaliasPool");
    check(REGISTRY_ABI, "HaliasRegistry");
    check(DOMAIN_ABI, "HaliasDomain");
  });
});
