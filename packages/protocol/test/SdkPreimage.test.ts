import { expect } from "chai";
import { ethers } from "hardhat";
import {
  computeParamsHash, encodeRegistration, buildTransactParams,
  POOL_ABI, POOL_REGISTRY_ABI as REGISTRY_ABI, CONTROLLER_ABI,
  NO_RELAYER, type TransactParams, registrationCommitment,
  computeNullifier as sdkNullifier, NULLIFIER_DOMAIN, POOL_LEVELS,
  SMT, rootFromSiblings, aliasHashToSmtKey,
  init as initSdkCrypto,
} from "halias-sdk";
import { updateAliasDataAs } from "./helpers/register";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { nullifierFor, globalIndex } from "./helpers/nullifier";
import { FIELD_PRIME } from "./helpers/field";
// `NO_RELAYER` deliberately not taken from helpers/tx here: this suite compares the SDK
// against the contract, so the SDK's own constant is the one under test.
import { rand32 } from "./helpers/tx";

// The SDK's paramsHash, checked against the pool's own.
//
// This is the gap that let the split break the SDK silently. `paramsHash` is a public
// signal: the circuit constrains it without interpreting it, so if the SDK's preimage
// differs from the contract's by one byte the result is not a decoding error or a revert
// with a name — it is a proof that verifies against nothing, on a transaction that looks
// well formed. Comparing ABI fragments cannot see this at all, which is why the fragment
// check below is necessary but nowhere near sufficient.
//
// It became a live problem when the relayer fee moved from a packed `address || uint96`
// word into a two-member struct. Nothing in the build would have caught it.


describe("SDK preimage agreement", function () {
  this.timeout(120000);

  let pool: any, registry: any, domain: any, poolAddr: string;
  let chainId: bigint;
  let signer: any, other: any;

  const randBig = () => BigInt(rand32());

  before(async function () {
    // Both Poseidons: this suite's, and the SDK's. The differential below is worthless if one
    // of them is the other.
    await initPoseidon();
    await initSdkCrypto();
    [signer, other] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    const deployer = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(verifier, verifier, signer.address);

    pool     = await ethers.getContractAt("HaliasPool",     await deployer.pool());
    registry = await ethers.getContractAt("HaliasRegistry", await deployer.registry());
    domain   = await ethers.getContractAt("HaliasController", await deployer.controller());
    poolAddr = await pool.getAddress();
    chainId  = (await ethers.provider.getNetwork()).chainId;
  });

  async function assertAgrees(params: TransactParams, enc0: string, enc1: string) {
    const root = BigInt((await anchorOf(pool)).root);
    const p = buildTransactParams(
      [root, root, root, root], [0, 0, 0, 0], BigInt(await registry.getRegistryRoot()),
      0n, 0n, [randBig(), randBig(), randBig(), randBig()], [randBig(), randBig()], params,
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
      aliasHash: randBig(), spendingCommitment: randBig() % FIELD_PRIME,
      nullifierKeyHash: randBig() % FIELD_PRIME, encryptionPubkey: randBig(),
    };
    const offChain = encodeRegistration(r);
    const onChain = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address,bytes32,bytes32,bytes32,bytes32)"],
      [[r.owner, ethers.toBeHex(r.aliasHash, 32), ethers.toBeHex(r.spendingCommitment, 32),
        ethers.toBeHex(r.nullifierKeyHash, 32), ethers.toBeHex(r.encryptionPubkey, 32)]],
    ));
    expect(offChain).to.equal(onChain);
  });

  it("matches the compiled artifacts fragment for fragment", async function () {
    // Signature agreement. Kept in this file rather than its own so the two failure modes —
    // a fragment that drifted, and a preimage that drifted while the fragments still match —
    // are visible together. Only the second one is silent, which is why both live here.
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
    check(CONTROLLER_ABI, "HaliasController");
  });

  // ── the registration commitment ───────────────────────────────────────────
  //
  // The contract's `registrationCommitment` is `internal`, deliberately: as an external `pure`
  // helper it was callable over eth_call with the plaintext name, which hands the name to
  // whatever node answers — before the opaque commitment is broadcast, on the one flow whose
  // entire purpose is that nobody learns it until front-running is impossible.
  //
  // So there is nothing to compare hashes against, and agreement is proven the way it actually
  // matters instead: precommit with the SDK's hash, then reveal against the contract's. If the
  // two encodings disagree by a single byte the reveal reverts with NoReservation, which is the
  // same failure a user would hit — caught here rather than in production.
  describe("registration commitment", function () {
    it("is not callable from outside, so the name cannot leak over eth_call", async function () {
      // Guards the property rather than trusting the modifier to stay put. An ABI that still
      // carries this function is one an integrator can call, and the leak is silent.
      const external = new ethers.Interface([
        "function registrationCommitment(string,bytes32,bytes32,bytes32,address,bytes32) view returns (bytes32)",
      ]);
      const selector = external.getFunction("registrationCommitment")!.selector;
      const deployed = await ethers.provider.getCode(await domain.getAddress());
      expect(deployed.includes(selector.slice(2)), "selector is still dispatchable")
        .to.equal(false);
    });

    it("the SDK's encoding reveals against the contract's", async function () {
      const [, user] = await ethers.getSigners();
      const name = `sdk${Math.floor(Math.random() * 1e9)}.hls`;
      const salt = rand32();
      const pk   = randBig() % FIELD_PRIME;
      const nkh  = randBig() % FIELD_PRIME;
      const enc  = randBig() % FIELD_PRIME;
      const fee  = await domain.registrationFee();

      const c = registrationCommitment(name, pk, nkh, enc, user.address, salt);
      await (await domain.connect(user).reserveRegistration(c)).wait();
      await ethers.provider.send("evm_mine", []);

      // Succeeds only if the contract recomputed the identical hash from the same six fields.
      await expect(
        domain.connect(user).revealRegistration(
          name, ethers.toBeHex(pk, 32), ethers.toBeHex(nkh, 32), ethers.toBeHex(enc, 32),
          user.address, salt, { value: fee },
        ),
      ).to.emit(registry, "AliasRegistered");
    });

    it("a commitment built with any field altered does not reveal", async function () {
      // The other half. Agreement alone would be satisfied by an encoding that ignored a field
      // in both places — this shows each one is actually bound, using the contract as the
      // judge rather than comparing the SDK against itself.
      const [, user] = await ethers.getSigners();
      const name = `sdk${Math.floor(Math.random() * 1e9)}.hls`;
      const salt = rand32();
      const fee  = await domain.registrationFee();
      const pk   = randBig() % FIELD_PRIME;

      // Reserved for a different owner; revealed as this one. The address has to be one no
      // signer in this suite holds — `other` IS the second signer, so using it here reserved
      // and revealed the same tuple and the reveal succeeded, which is not what this tests.
      const stranger = ethers.Wallet.createRandom().address;
      const c = registrationCommitment(name, pk, 2n, 3n, stranger, salt);
      await (await domain.connect(user).reserveRegistration(c)).wait();
      await ethers.provider.send("evm_mine", []);

      await expect(
        domain.connect(user).revealRegistration(
          name, ethers.toBeHex(pk, 32), ethers.toBeHex(2n, 32), ethers.toBeHex(3n, 32),
          user.address, salt, { value: fee },
        ),
      ).to.be.revertedWithCustomError(domain, "NoReservation");
    });

    it("binds every field, checked against itself for the ones a reveal cannot vary", async function () {
      const base = ["alice.hls", 1n, 2n, 3n, other.address, rand32()] as const;
      const ref = registrationCommitment(...base);
      const variants: Array<Parameters<typeof registrationCommitment>> = [
        ["bob.hls", 1n, 2n, 3n, other.address, base[5]],
        ["alice.hls", 9n, 2n, 3n, other.address, base[5]],
        ["alice.hls", 1n, 9n, 3n, other.address, base[5]],
        ["alice.hls", 1n, 2n, 9n, other.address, base[5]],
        ["alice.hls", 1n, 2n, 3n, signer.address, base[5]],
        ["alice.hls", 1n, 2n, 3n, other.address, rand32()],
      ];
      for (const v of variants) {
        expect(registrationCommitment(...v), `field did not affect the commitment: ${v[0]}`)
          .to.not.equal(ref);
      }
    });
  });

  // ── the registry tree the client mirrors ──────────────────────────────────
  //
  // The client no longer asks `getSmtSiblings(slot)` for a membership path; it derives one from
  // a tree it rebuilds out of scanned events. That was a privacy change — slot↔alias is public
  // from AliasRegistered, so asking a node for a slot's path told it who was about to be paid —
  // and it is only sound if the mirror is byte-for-byte the tree the contract holds.
  //
  // The failure mode is the reason this suite exists: a wrong mirror does not throw. Its root
  // simply fails to match, {registryProof} falls back to fetching, and every test still passes
  // while the leak the change removed quietly returns. Nothing else in the build would notice.
  //
  // So this compares against a live registry, built from logs alone — no SDK-internal state —
  // which also exercises the reconstruction {rebuildRegistryTree} performs.
  describe("registry tree", function () {
    // Every registration and data update this contract has ever seen, folded to current state.
    // Reads all logs rather than only its own, so entries left by earlier tests in this file
    // are included — the tree has to match the whole registry, not a subset of it.
    async function stateFromLogs() {
      const [regs, updates] = await Promise.all([
        registry.queryFilter(registry.filters.AliasRegistered(), 0),
        registry.queryFilter(registry.filters.AliasDataUpdated(), 0),
      ]);
      const state = new Map<string, { slot: number; leafValue: bigint; key: bigint }>();
      for (const e of regs) {
        state.set(e.args.aliasHash, {
          // One-based on chain — `aliasSlot` reserves 0 to mean "unregistered" — and the path
          // key is one less. The SDK's scanner subtracts this same one; getting it wrong does
          // not throw, it silently derives the neighbour's path.
          slot: Number(e.args.slot) - 1,
          key: aliasHashToSmtKey(BigInt(e.args.aliasHash)),
          leafValue: poseidonHash([
            BigInt(e.args.spendingCommitment), BigInt(e.args.nullifierKeyHash), 0n,
          ]),
        });
      }
      // Applied after, and in log order, because a data update replaces the leaf of an alias
      // registered earlier — replaying them out of order would leave a stale dataHash.
      for (const e of updates) {
        const cur = state.get(e.args.aliasHash);
        if (!cur) continue;
        const reg = regs.filter((r: any) => r.args.aliasHash === e.args.aliasHash).pop()!;
        cur.leafValue = poseidonHash([
          BigInt(reg.args.spendingCommitment), BigInt(reg.args.nullifierKeyHash),
          BigInt(e.args.dataHash),
        ]);
      }
      return state;
    }

    // Built the way the client builds it — bottom-up — so these tests exercise the path that
    // actually runs. The equivalence with repeated `update` is asserted separately below.
    function treeFrom(state: Map<string, { slot: number; leafValue: bigint; key: bigint }>) {
      return SMT.fromLeaves([...state.values()].map(
        e => ({ slot: e.slot, key: e.key, value: e.leafValue })));
    }

    let state: Map<string, { slot: number; leafValue: bigint; key: bigint }>;

    before(async function () {
      const fee = await domain.registrationFee();
      // Several, so the tree has interior structure: a single leaf agrees with almost any
      // implementation, because every sibling on its path is still a zero node.
      const hashes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const rc = await (await domain.directRegistration(
          `tree${i}-${Math.floor(Math.random() * 1e9)}.hls`,
          ethers.toBeHex(randBig() % FIELD_PRIME, 32),
          ethers.toBeHex(randBig() % FIELD_PRIME, 32),
          ethers.toBeHex(randBig() % FIELD_PRIME, 32),
          signer.address, { value: fee },
        )).wait();
        const ev = rc!.logs.map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
          .find((p: any) => p?.name === "AliasRegistered")!;
        hashes.push(ev.args.aliasHash);
      }
      // One in-place update. Registrations only ever append; a rotation or a data change
      // rewrites an occupied slot, and that is the path where a mirror is easiest to get wrong.
      await (await updateAliasDataAs(domain, signer, hashes[2],
        ethers.toBeHex(randBig() % FIELD_PRIME, 32))).wait();

      state = await stateFromLogs();
      expect(state.size, "expected registrations to reach the registry").to.be.greaterThan(4);
    });

    it("reproduces the contract's root from logs alone", async function () {
      // The whole change rests on this one equality. If it fails the client is not wrong, it is
      // merely slower and less private — which is why it is asserted rather than relied upon.
      expect(treeFrom(state).root).to.equal(BigInt(await registry.getRegistryRoot()));
    });

    it("derives the same sibling path the contract returns, for every occupied slot", async function () {
      const smt = treeFrom(state);
      for (const e of state.values()) {
        const onChain = (await registry.getSmtSiblings(e.slot) as string[]).map(BigInt);
        expect(smt.getSiblings(e.slot), `slot ${e.slot}`).to.deep.equal(onChain);
      }
    });

    it("derives the path of an unassigned slot too", async function () {
      // Not incidental: claimInvite proves a slot is *empty* in the current tree and then
      // derives the tree that filling it produces, so the path beside an unoccupied slot has to
      // be right as well.
      const next = Number(await registry.nextAliasSlot());
      const onChain = (await registry.getSmtSiblings(next) as string[]).map(BigInt);
      expect(treeFrom(state).getSiblings(next)).to.deep.equal(onChain);
    });

    it("verifies against the root the way registryProof does", async function () {
      // The exact check on the send path: leaf plus derived path must rebuild the published
      // root. Stated separately because it is `rootFromSiblings` that decides whether the local
      // copy is trusted, and it walks the path independently of the code that built the tree.
      const smt = treeFrom(state);
      const root = BigInt(await registry.getRegistryRoot());
      for (const e of state.values()) {
        expect(rootFromSiblings(e.key, e.leafValue, e.slot, smt.getSiblings(e.slot)), `slot ${e.slot}`)
          .to.equal(root);
      }
    });

    it("fails the check when the mirror is stale, rather than proving against a wrong tree", async function () {
      // The other half, and the one that makes the fallback reachable. A client that scanned
      // before the newest registration holds a tree missing it; every path it derives is wrong.
      // That has to surface here, as a mismatched root, and not several seconds later as a
      // proof the pool rejects.
      const newest = [...state.values()].sort((a, b) => b.slot - a.slot)[0];
      const stale = new Map(state);
      stale.delete([...state.keys()].find((k) => state.get(k)!.slot === newest.slot)!);
      const smt = treeFrom(stale);
      const root = BigInt(await registry.getRegistryRoot());

      expect(smt.root, "a tree missing a registration must not match").to.not.equal(root);
      const survivor = [...stale.values()][0];
      expect(rootFromSiblings(survivor.key, survivor.leafValue, survivor.slot,
                              smt.getSiblings(survivor.slot))).to.not.equal(root);
    });

    it("builds the same tree bottom-up as one update at a time", async function () {
      // `fromLeaves` exists purely for speed — it hashes each node once instead of once per
      // descendant, which is 14x — and the two builders share no code. The tests above run
      // against whichever one `treeFrom` uses, so without this a divergence would show up as
      // a client that silently falls back to fetching, not as a failure.
      const leaves = [...state.values()].map(e => ({ slot: e.slot, key: e.key, value: e.leafValue }));
      const sequential = new SMT();
      for (const l of leaves) sequential.update(l.slot, l.key, l.value);
      const batch = SMT.fromLeaves(leaves);

      expect(batch.root).to.equal(sequential.root);
      // Roots alone would pass on two trees that agree at the top and differ below, so the
      // paths are compared too — including past the end, where the answer is zero subtrees.
      const next = Number(await registry.nextAliasSlot());
      for (const slot of [...leaves.map(l => l.slot), next, next + 1]) {
        expect(batch.getSiblings(slot), `slot ${slot}`).to.deep.equal(sequential.getSiblings(slot));
      }
    });

    it("fails the check when a leaf is stale, which is the dataHash case", async function () {
      // Same guard against the mutable field. The path is current; only the leaf is old, which
      // is what a client sees when an owner updates their dataHash after the last scan.
      const smt = treeFrom(state);
      const updated = [...state.values()].sort((a, b) => a.slot - b.slot)[2];
      expect(rootFromSiblings(updated.key, poseidonHash([1n, 2n, 3n]), updated.slot,
                              smt.getSiblings(updated.slot)))
        .to.not.equal(BigInt(await registry.getRegistryRoot()));
    });
  });

  // ── constants the three implementations must share ────────────────────────
  //
  // The nullifier is computed independently in three places — NoteNullifier in
  // transact.circom, computeNullifier in the SDK, and helpers/nullifier.ts here — and none of
  // them can see the others. Disagreement does not surface as an error: it produces a proof
  // that verifies against nothing, or a double-spend that the pool fails to catch. These are
  // the assertions that make sharing one helper across the suite safe rather than circular.
  describe("nullifier derivation", function () {
    it("uses the domain constant the circuit does, derived rather than copied", async function () {
      // "NTRL" as big-endian ASCII. Derived rather than copied, because a transposed digit in
      // 1314148940 is invisible on its own — which is exactly how every comment in the repo
      // came to describe this as "NULL" (0x4e554c4c). It is not; it is 0x4e54524c, and the
      // difference of 64,000 never showed up because nothing checked.
      //
      // The value itself is fine: it is a domain tag, and any input distinct from the others
      // separates the arities. It is also frozen — baked into the circuit and the proving key —
      // so this asserts what it *is*, not what it should have been.
      const fromAscii = BigInt("0x" + Buffer.from("NTRL", "ascii").toString("hex"));
      expect(NULLIFIER_DOMAIN, "NULLIFIER_DOMAIN is not ascii NTRL").to.equal(fromAscii);
      expect(NULLIFIER_DOMAIN).to.equal(0x4e54524cn);
      expect(NULLIFIER_DOMAIN).to.equal(1314148940n);
    });

    it("agrees with the pool about how deep a tree is", async function () {
      // The one that would go unnoticed. POOL_LEVELS is a hardcoded 16 in the SDK, and it sets
      // the shift in every global index; the pool has its own LEVELS. If they ever diverge,
      // every note in tree 0 still works — leafIndex is unshifted there — and everything from
      // tree 1 onward silently nullifies to the wrong value. Nothing else in the build
      // compares them.
      expect(POOL_LEVELS, "SDK POOL_LEVELS disagrees with HaliasPool.LEVELS()")
        .to.equal(Number(await pool.LEVELS()));
    });

    it("matches an independent re-derivation, across trees and leaves", async function () {
      // Two implementations of the same arithmetic, compared over cases that would each catch
      // a different mistake: leaf 0 of tree 0 (both terms zero), a leaf at the tree boundary,
      // the first leaf of tree 1 (where the shift starts mattering), and a high tree number.
      const key = randBig() % FIELD_PRIME;
      const cases: [number, number][] = [
        [0, 0], [0, 1], [0, (1 << POOL_LEVELS) - 1], [1, 0], [1, 5], [7, 12345], [4095, 65535],
      ];
      for (const [tree, leaf] of cases) {
        expect(sdkNullifier(key, tree, leaf), `tree ${tree} leaf ${leaf}`)
          .to.equal(nullifierFor(key, leaf, tree));
      }
    });

    it("gives every (tree, leaf) position a distinct nullifier", async function () {
      // The property the global index exists for. Before it, leaf 5 of tree 0 and leaf 5 of
      // tree 3 shared a nullifier, so spending one marked the other spent — and the pool would
      // have rejected an honest note with NullifierAlreadySpent.
      const key = randBig() % FIELD_PRIME;
      const seen = new Map<bigint, string>();
      for (let tree = 0; tree < 4; tree++) {
        for (const leaf of [0, 1, 2, (1 << POOL_LEVELS) - 1]) {
          const n = nullifierFor(key, leaf, tree);
          const where = `tree ${tree} leaf ${leaf}`;
          expect(seen.has(n), `${where} collides with ${seen.get(n)}`).to.equal(false);
          seen.set(n, where);
        }
      }
      expect(seen.size).to.equal(16);
    });

    it("separates the nullifier from the registry's key hash, at every arity", async function () {
      // The collision the domain constant exists to close. nullifierKeyHash is Poseidon(key, 1)
      // and is PUBLIC in the registry. A two-input nullifier — Poseidon(key, leafIndex) — would
      // equal it exactly at leafIndex == 1, so spending that one note would publish a value
      // identical to the alias's own public key hash. Poseidon(3) can never collide with
      // Poseidon(2), which is why the separation is an extra input rather than a new constant.
      const key = randBig() % FIELD_PRIME;
      const keyHash = poseidonHash([key, 1n]);
      for (let leaf = 0; leaf < 4; leaf++) {
        expect(nullifierFor(key, leaf), `leaf ${leaf} leaked the registry key hash`)
          .to.not.equal(keyHash);
      }
    });

    it("commits to the global index rather than the raw leaf", async function () {
      const key = randBig() % FIELD_PRIME;
      expect(globalIndex(0, 5)).to.equal(5n);
      expect(globalIndex(1, 0)).to.equal(BigInt(1 << POOL_LEVELS));
      expect(globalIndex(2, 3)).to.equal(BigInt(2 * (1 << POOL_LEVELS) + 3));
      // Stated as the hash of the index, so a change to the folding breaks this too.
      expect(nullifierFor(key, 5, 0))
        .to.equal(poseidonHash([key, globalIndex(0, 5), NULLIFIER_DOMAIN]));
    });
  });
});
