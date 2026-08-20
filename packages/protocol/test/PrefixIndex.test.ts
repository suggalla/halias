import { expect } from "chai";
import { ethers } from "hardhat";
import { deployStack, type Stack } from "./helpers/stack";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { randField } from "./helpers/field";
import { aliasPrefix, ALIAS_PREFIX_BITS } from "halias-sdk";

// The prefix index, and the batch sibling read that pairs with it.
//
// Together these replace the two ways a client used to resolve a recipient, both of which
// leaked: scanning every registration (785 B of log JSON per alias, so 785 MB at a million)
// or asking a targeted question that names the person being paid. Reading one prefix group
// says only "someone in this group".
//
// The property that makes the pair worth having is that both calls name the SAME set. Two
// k-anonymous queries over different partitions would intersect, and the intersection is much
// smaller than either — so these tests check the correspondence, not just that each works.

/// The prefix a client computes locally, imported from the SDK rather than reimplemented
/// here. The contract's copy is private on purpose — as an external pure helper it would be
/// callable with one alias hash, which is the targeted question this whole mechanism exists
/// to avoid — so the client's copy is the only other place the rule exists, and a test that
/// reimplements it proves the contract agrees with the test rather than with the client.
const prefixOf = (aliasHash: string) => aliasPrefix(BigInt(aliasHash));

describe("registry prefix index", function () {
  this.timeout(120000);

  let s: Stack;
  const registered: { hash: string; pk: string; nkh: string; enc: string }[] = [];

  before(async function () {
    await initPoseidon();
    s = await deployStack();

    // Registered directly through the registry rather than the controller: this suite is about
    // the index, and going through registration fees and commitments would only add ways for
    // it to fail for unrelated reasons. The registry only accepts its controller, so the stack
    // is deployed with this signer standing in.
    const registry = s.registry.connect(s.admin);
    const controllerAddr = await s.controller.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [controllerAddr]);
    await ethers.provider.send("hardhat_setBalance", [controllerAddr, "0x56bc75e2d63100000"]);
    const asController = await ethers.getSigner(controllerAddr);

    // Enough that several land in the same prefix group and most groups stay empty — 12 bits
    // is 4,096 groups, so with 40 aliases collisions are the exception, which is the shape a
    // real registry has early on.
    for (let i = 0; i < 40; i++) {
      const hash = ethers.hexlify(ethers.randomBytes(32));
      const pk = randField(), nkh = randField(), enc = randField();
      await registry.connect(asController).register(hash, pk, nkh, enc);
      registered.push({ hash, pk, nkh, enc });
    }
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [controllerAddr]);
  });

  // The one assertion that keeps the client and the contract from drifting apart. The rule
  // exists in exactly two places — HaliasRegistry._aliasPrefix, which is private, and the
  // SDK's aliasPrefix — and a disagreement is silent: the client fetches a group the alias is
  // not in, and a registered name reads as unregistered on the send path.
  it("agrees with the contract on how wide a prefix is", async function () {
    expect(Number(await s.registry.ALIAS_PREFIX_BITS())).to.equal(ALIAS_PREFIX_BITS);
  });

  it("puts every alias in the group its hash selects", async function () {
    // The whole design rests on the client being able to compute the group from the name
    // without asking. If the contract's grouping and the client's disagree, a lookup returns
    // an empty page and the name reads as unregistered — a wrong answer, not an error.
    for (const r of registered) {
      const group = await s.registry.getAliasesByPrefix(prefixOf(r.hash), 0, 1000);
      expect(group.map((e: any) => e.aliasHash), `alias ${r.hash} missing from its group`)
        .to.include(r.hash);
    }
  });

  it("returns records complete enough to build the leaf without a second call", async function () {
    // The point of returning whole records: following up with `aliases(h)` per entry would put
    // the alias hash back on the wire one at a time, which is exactly the leak being removed.
    for (const r of registered.slice(0, 5)) {
      const [entry] = (await s.registry.getAliasesByPrefix(prefixOf(r.hash), 0, 1000))
        .filter((e: any) => e.aliasHash === r.hash);
      expect(entry.spendingCommitment).to.equal(r.pk);
      expect(entry.nullifierKeyHash).to.equal(r.nkh);
      expect(entry.encryptionPubkey).to.equal(r.enc);
      expect(entry.dataHash).to.equal(ethers.ZeroHash);

      // Built from the returned fields alone, checked against the contract's own leaf.
      expect(poseidonHash([BigInt(entry.spendingCommitment), BigInt(entry.nullifierKeyHash),
                           BigInt(entry.dataHash)]))
        .to.equal(BigInt(await s.registry.leafOf(r.hash)));
    }
  });

  it("reports pathKey zero-based, matching what getSmtSiblings takes", async function () {
    // The convention trap. `aliasSlot` and AliasRegistered are one-based so that zero reads as
    // unregistered; `getSmtSiblings` takes the zero-based path key. Getting this wrong does not
    // throw — it derives the neighbouring alias's path, and the proof fails much later.
    for (const r of registered.slice(0, 5)) {
      const [entry] = (await s.registry.getAliasesByPrefix(prefixOf(r.hash), 0, 1000))
        .filter((e: any) => e.aliasHash === r.hash);
      expect(entry.pathKey).to.equal(Number(await s.registry.aliasSlot(r.hash)) - 1);
    }
  });

  it("pages without gaps, overlaps or reordering", async function () {
    // Pick the busiest group so paging actually has something to get wrong.
    const counts = await Promise.all(
      [...new Set(registered.map(r => prefixOf(r.hash)))]
        .map(async p => [p, Number(await s.registry.prefixCount(p))] as const));
    const [busiest, total] = counts.sort((a, b) => b[1] - a[1])[0];

    const whole = (await s.registry.getAliasesByPrefix(busiest, 0, 1000))
      .map((e: any) => e.aliasHash);
    expect(whole.length).to.equal(total);

    const paged: string[] = [];
    for (let off = 0; off < total; off++) {
      const page = await s.registry.getAliasesByPrefix(busiest, off, 1);
      expect(page.length).to.equal(1);
      paged.push(page[0].aliasHash);
    }
    expect(paged).to.deep.equal(whole);
  });

  it("clamps a limit past the end instead of reverting", async function () {
    const p = prefixOf(registered[0].hash);
    const total = Number(await s.registry.prefixCount(p));
    expect((await s.registry.getAliasesByPrefix(p, 0, 10_000)).length).to.equal(total);
    // Including the overflow case, where offset + limit wraps.
    expect((await s.registry.getAliasesByPrefix(p, 1, ethers.MaxUint256)).length)
      .to.equal(total - 1);
  });

  it("returns empty past the end rather than reverting, so paging can stop", async function () {
    const p = prefixOf(registered[0].hash);
    const total = Number(await s.registry.prefixCount(p));
    expect((await s.registry.getAliasesByPrefix(p, total, 10)).length).to.equal(0);
    expect((await s.registry.getAliasesByPrefix(p, total + 99, 10)).length).to.equal(0);
  });

  it("leaves untouched groups empty", async function () {
    // 4,096 groups against 40 aliases, so most are empty — and an empty group must read as
    // empty rather than as a revert or as someone else's entries.
    const used = new Set(registered.map(r => prefixOf(r.hash)));
    let checked = 0;
    for (let p = 0; p < 4096 && checked < 20; p++) {
      if (used.has(p)) continue;
      expect(Number(await s.registry.prefixCount(p)), `group ${p}`).to.equal(0);
      expect((await s.registry.getAliasesByPrefix(p, 0, 10)).length).to.equal(0);
      checked++;
    }
    expect(checked).to.equal(20);
  });

  it("does not append a second entry when an alias is rotated or its data changes", async function () {
    // `_smtUpdate` runs for rotations and data updates too. Indexing there rather than in
    // `register` would append a duplicate every rotation, and a client would build the same
    // leaf twice — harmless for the tree, wrong for the count, and a slow leak of how often
    // someone rotates.
    const controllerAddr = await s.controller.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [controllerAddr]);
    const asController = await ethers.getSigner(controllerAddr);

    const r = registered[0];
    const p = prefixOf(r.hash);
    const before = Number(await s.registry.prefixCount(p));

    await s.registry.connect(asController).setDataHash(r.hash, randField());
    await s.registry.connect(asController).reassign(r.hash, randField(), randField(), randField());
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [controllerAddr]);

    expect(Number(await s.registry.prefixCount(p))).to.equal(before);
    const entries = (await s.registry.getAliasesByPrefix(p, 0, 1000))
      .filter((e: any) => e.aliasHash === r.hash);
    expect(entries.length, "alias appears more than once").to.equal(1);
    // And the entry reflects the new keys, not a stale copy taken at registration.
    expect(poseidonHash([BigInt(entries[0].spendingCommitment),
                         BigInt(entries[0].nullifierKeyHash), BigInt(entries[0].dataHash)]))
      .to.equal(BigInt(await s.registry.leafOf(r.hash)));
  });

  // ── the batch sibling read ────────────────────────────────────────────────

  it("batches sibling paths identically to fetching them one at a time", async function () {
    const keys = await Promise.all(
      registered.slice(0, 8).map(async r => Number(await s.registry.aliasSlot(r.hash)) - 1));

    const batch = await s.registry.getSmtSiblingsBatch(keys);
    expect(batch.length).to.equal(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const one = await s.registry.getSmtSiblings(keys[i]);
      expect(batch[i], `slot ${keys[i]}`).to.deep.equal(one);
    }
  });

  it("batches an empty request, and repeated slots, without special-casing", async function () {
    expect((await s.registry.getSmtSiblingsBatch([])).length).to.equal(0);
    const k = Number(await s.registry.aliasSlot(registered[0].hash)) - 1;
    const twice = await s.registry.getSmtSiblingsBatch([k, k]);
    expect(twice[0]).to.deep.equal(twice[1]);
  });

  it("answers for an unoccupied slot, which the claim path depends on", async function () {
    const next = Number(await s.registry.nextAliasSlot());
    const batch = await s.registry.getSmtSiblingsBatch([next]);
    expect(batch[0]).to.deep.equal(await s.registry.getSmtSiblings(next));
  });

  it("serves a whole prefix group in one pair of calls", async function () {
    // The end-to-end shape a client actually uses, and the reason the two calls must name the
    // same set: the sibling request carries exactly the slots the prefix request returned, so
    // it discloses nothing the first call did not.
    const p = prefixOf(registered[0].hash);
    const entries = await s.registry.getAliasesByPrefix(p, 0, 1000);
    const batch = await s.registry.getSmtSiblingsBatch(entries.map((e: any) => e.pathKey));

    expect(batch.length).to.equal(entries.length);
    for (let i = 0; i < entries.length; i++) {
      expect(batch[i]).to.deep.equal(await s.registry.getSmtSiblings(entries[i].pathKey));
    }
  });
});
