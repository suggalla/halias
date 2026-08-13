import { ethers } from "ethers";
import { normalizeAlias, AliasTakenError } from "./alias";
import { deriveKeysFromRoot, poseidonHash } from "./crypto";
import { buildEntry, computeNullifier, randomBlinding, OwnedEntry, ETH_TOKEN_ADDRESS, POOL_LEVELS } from "./entry";
import { PoolTrees } from "./merkle";
import { aliasHashToSmtKey } from "./smt";
import { proveTransact, dummyInput, dummyOutput, TransactOutput } from "./proof";
import { findMyOutputs, Output } from "./events";
import { deriveInviteKeys, InviteKeys, encodeInviteCode } from "./invite";
import { encodeViewKey, viewKeysFrom } from "./viewkey";
import {
  
  
  
  transact as contractTransact,
  register as contractRegister,
  registerDirect as contractRegisterDirect,
  updateAliasData as contractUpdateAliasData,
  offerAlias as contractOfferAlias,
  cancelOffer as contractCancelOffer,
  acceptAlias as contractAcceptAlias,
  lookupAlias as contractLookupAlias,
  claim as contractClaim,
  registrationTuple,
  encodeRegistration,
  computeParamsHash,
  TransactParams,
  ZERO_TRANSACT_PARAMS,
  NO_RELAYER,
} from "./contract";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

import { HaliasCore } from "./client-core";
import { encodeRelayBlob } from "./relay";
import { buildTransactParams } from "./contract";
// Declared alongside the state they describe; re-exported here so `halias-sdk` importers
// see them on the same module as the class that returns them.
import type {
  HaliasConfig, DepositResult, SendResult, WithdrawResult,
  BalanceResult, LookupResult, InviteResult, ScanEntry,
} from "./client-core";
export interface PrivacyContext {
  /// Total commitments in the pool — the crowd a withdrawal hides in.
  anonymitySet: number;
  /// How many of them are this alias's.
  myNotes: number;
  /// Blocks since this alias last created a note.
  blocksSinceLastNote: number;
  /// Notes created by anyone since then. Zero means a withdrawal now is trivially linkable
  /// to your own deposit by ordering alone.
  othersSinceLastNote: number;
}

export interface HistoryEntry {
  kind: "register" | "deposit" | "send" | "receive" | "withdraw";
  amount: bigint;
  tokenAddress: bigint;
  txHash: string;
  blockNumber: number;
  /// What inclusion cost, in wei. Paid in ETH regardless of the asset moved.
  gasFee: bigint;
  /// Who actually submitted and paid. Usually the alias owner — but on a relayed
  /// transaction it is the relayer, which is the whole point of the mechanism and worth
  /// showing rather than implying.
  feePayer: string;
  /// Whether someone else was paid out of the pool to submit this.
  ///
  /// Not inferred from `feePayer`. A different payer has three unrelated causes — a third
  /// party funding your alias, the sender of a transfer you received, or an actual relay —
  /// and reading "relayed" off the address alone conflates them.
  relayed: boolean;
  /// What the submitter was paid, where that is recoverable. A transfer's `publicAmount` is
  /// exactly zero unless a fee left the pool, so for transfers this is exact. A withdrawal
  /// bundles the fee into the total leaving, so it stays 0n there even when `relayed`.
  relayerFee: bigint;
}

export type {
  HaliasConfig, DepositResult, SendResult, WithdrawResult,
  BalanceResult, LookupResult, InviteResult, ScanEntry,
};

/// The public surface: everything a caller can do with an alias or a note.
export class Halias extends HaliasCore {
  // ── Operations ─────────────────────────────────────────────────────────────

  /// Register `alias` under this client's alias index.
  ///
  /// The name is always published. It used to be optional, on the reasoning that an
  /// unpublished alias is unguessable — which it is not. `aliasHash` is keccak of the name
  /// and is public in the registration event regardless, so for any name a person would
  /// choose and be able to type, a wordlist recovers it immediately. Withholding the
  /// plaintext buys resistance only for a name with enough entropy that its holder cannot
  /// remember it either, and must store it somewhere anyway.
  ///
  /// What it costs is absolute: registration is the only moment the plaintext can be
  /// supplied — someone who has forgotten the name cannot supply it later — so an
  /// unpublished name is unrecoverable the moment local storage is lost.
  ///
  /// The one caller that genuinely has no name to publish is {createInvite}, whose alias
  /// hash is random rather than derived from anything. It registers through the contract
  /// directly.
  ///
  /// The index is not stored on chain — it does not need to be. Recovery rederives indices
  /// and matches them against the spending pubkeys the registry publishes; see
  /// {aliasIndexOf}.
  ///
  /// Throws {AliasTakenError} without sending anything if the name is already registered.
  async register(
    alias: string,
    onStep?: (step: "commit" | "register") => void,
    /// One transaction instead of two, and no front-running protection. Only correct where
    /// the mempool is not public; see {registerDirect} on the contract. Defaults off, and
    /// deliberately not surfaced by the CLI.
    opts: { direct?: boolean } = {},
  ): Promise<{ txHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    const cleanAlias = normalizeAlias(alias);

    // Ask before paying. Registration is commit-then-reveal, and a taken name only fails at
    // the reveal — so without this the commit is mined and paid for, and the second
    // transaction reverts with AliasTaken. The user is charged for learning something a free
    // call could have told them.
    //
    // Not a substitute for the contract's own check, and not meant to be: a name can be taken
    // between this read and the transaction. That race ends in exactly the revert this avoids
    // in the ordinary case, which is the right place for it to be handled.
    if (await this.isAliasTaken(cleanAlias)) {
      throw new AliasTakenError(`${cleanAlias}.hls is already registered`);
    }

    const spendingBytes32 = this.keys!.spendingPubkey;
    const encBytes32      = BigInt(ethers.hexlify(this.keys!.encryption.publicKey));

    // The commit-reveal secret, derived rather than random, so nothing has to survive
    // between the two transactions. A random salt lives only in the memory of the session
    // that committed: lose it — a refresh, a crash, a different device — and the commitment
    // is unspendable and has to be remade. This one is recomputed from the root.
    //
    // Derived from the ROOT, not from the keys. The keys are already in the commitment, so a
    // salt derived from them would add no entropy — anyone able to guess them could compute
    // it too. The root is never published and never leaves the client, so the commitment
    // stays hiding even if the keys are known in advance.
    const salt = ethers.keccak256(ethers.concat([
      ethers.toBeHex(this.derivationRoot, 32),
      ethers.toBeHex(this.aliasHashOf(alias), 32),
    ]));

    const nullifierKeyHash = poseidonHash([this.keys!.nullifierKey, 1n]);
    const fee = await this.domain.registrationFee() as bigint;
    const tx = opts.direct
      ? await contractRegisterDirect(
          this.domain, `${cleanAlias}.hls`, spendingBytes32, nullifierKeyHash, encBytes32, fee)
      : await contractRegister(
          this.domain, `${cleanAlias}.hls`, spendingBytes32, nullifierKeyHash, encBytes32,
          fee, salt, onStep);
    return { txHash: await this.settle(tx) };
  }

  /// The alias this client's keys belong to, found by matching its spending pubkey against
  /// what the registry publishes.
  ///
  /// {myAliases} cannot answer this for a view key: it asks who *owns* the alias NFT, and a
  /// viewer owns nothing. The registry is the right source either way — it is what binds a
  /// key to a name.
  async selfAlias(): Promise<{ aliasHash: string; name: string | null; slot: number } | null> {
    this.ensureInit();
    await this.ensureSync();
    const hash = this.aliasHashByPubkey.get(this.keys!.spendingPubkey);
    if (hash === undefined) return null;
    const h = "0x" + hash.toString(16).padStart(64, "0");
    const entry = this.registryEntries.find(
      (e) => e.aliasHash.toLowerCase() === h.toLowerCase(),
    );
    return {
      aliasHash: h,
      name: this.namesByAlias.get(entry?.aliasHash ?? h) ?? null,
      slot: entry?.registrySlot ?? 0,
    };
  }

  /// The view-only half of this alias's keys.
  ///
  /// Whoever holds it can decrypt every note addressed to this alias, tell which are spent,
  /// and total them — and can spend nothing, because the spending key is derived separately
  /// and is not included. It covers this alias index alone: it reveals no other alias and
  /// cannot derive one.
  ///
  /// It is a secret. It exposes the entire payment history of this alias to anyone who has
  /// it, and unlike a password it cannot be changed without re-registering the alias under
  /// fresh keys.
  exportViewKey(): string {
    this.ensureInit();
    return encodeViewKey(viewKeysFrom(this.keys!));
  }

  /// Is this name already registered? A free read, and the same question {register} asks
  /// before it spends anything.
  async isAliasTaken(alias: string): Promise<boolean> {
    this.ensureInit();
    return await this.registry.isRegistered(
      ethers.toBeHex(this.aliasHashOf(alias), 32),
    ) as boolean;
  }

  async deposit(amountEth: string, tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<DepositResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();
    const selfProof = await this.selfRegistryProof();
    return this._deposit(amountEth, tokenAddress, {
      pubkey:           this.keys!.spendingPubkey,
      nullifierKeyHash: this.myNullifierKeyHash(),
      encryptionPubkey: undefined,   // sealNote defaults to our own viewing key
      proof:            selfProof,
    });
  }

  /// Deposit straight into someone else's alias.
  ///
  /// Nothing in the circuit ties an output to whoever is spending: outputs need a registry
  /// membership proof, but not one belonging to the sender. The second output is a
  /// zero-amount dummy, and zero-amount outputs skip the registry check entirely — so the
  /// payer needs no alias, no notes, and no prior involvement. Keys still come from their
  /// wallet signature; registration only exists so that people can pay *you*.
  ///
  /// On chain this is an ordinary deposit: the amount and the payer are public, the
  /// recipient is not. It reads as "0xA put 1 ETH into the pool", with no indication of who
  /// can spend it.
  async depositTo(
    recipientName: string,
    amountEth: string,
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
  ): Promise<DepositResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const recipient = await this.lookup(recipientName);
    const proof     = await this.registryProof(recipient.spendingPubkey);
    return this._deposit(amountEth, tokenAddress, {
      pubkey:           recipient.spendingPubkey,
      nullifierKeyHash: recipient.nullifierKeyHash,
      encryptionPubkey: recipient.encryptionPubkey,
      proof,
    });
  }

  private async _deposit(
    amountEth: string,
    tokenAddress: bigint,
    to: {
      pubkey: bigint;
      nullifierKeyHash: bigint;
      encryptionPubkey?: Uint8Array;
      proof: { aliasHash: bigint; registrySlot: number; siblings: bigint[]; dataHash: bigint; registryRoot: bigint };
    },
  ): Promise<DepositResult> {
    const amount   = ethers.parseEther(amountEth);
    const blinding = randomBlinding();
    const entry    = buildEntry(to.pubkey, to.nullifierKeyHash, blinding, amount, tokenAddress);

    // The pool pulls tokens with safeTransferFrom, so a deposit needs an allowance first.
    // Without this an ERC-20 deposit reverts inside the pool after the proof has already
    // been generated — several seconds of work thrown away for a missing approval.
    if (tokenAddress !== ETH_TOKEN_ADDRESS) {
      const token = new ethers.Contract(
        ethers.getAddress(ethers.toBeHex(tokenAddress, 20)),
        [
          "function allowance(address,address) view returns (uint256)",
          "function approve(address,uint256) returns (bool)",
        ],
        this.config.signer,
      );
      const me = await this.config.signer.getAddress();
      if ((await token.allowance(me, this.config.poolAddress)) < amount) {
        await (await token.approve(this.config.poolAddress, amount)).wait();
      }
    }

    const dBase = this.consumeDummyIdx(2);

    // Sealed to the recipient's key, so only they can find and spend it. Paying an alias
    // whose note you encrypted to yourself would burn the funds.
    const encryptedOutput0 = this.sealNote(blinding, amount, to.encryptionPubkey);

    const { out: out1, commitment: comm1 } = this.filler(tokenAddress);

    const paramsHash = computeParamsHash(ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", BigInt(this.config.chainId), this.config.poolAddress);
    const anchor       = this.poolAnchor();
    const registryRoot = to.proof.registryRoot;

    const dummy0 = dummyInput(anchor.tree, dBase, POOL_LEVELS);
    const dummy1 = dummyInput(anchor.tree, dBase + 1, POOL_LEVELS);

    const { proofBytes } = await proveTransact({
      poolRoot: [anchor.root, anchor.root], treeNumber: [anchor.tree, anchor.tree], registryRoot, publicAmount: amount, tokenAddress, paramsHash,
      inputNullifiers:  [dummy0.nullifier, dummy1.nullifier],
      outputCommitments: [entry.commitment, comm1],
      inputs: [dummy0.input, dummy1.input],
      outputs: [
        {
          pubkey:           to.pubkey,
          nullifierKeyHash: to.nullifierKeyHash,
          registrySlot:     to.proof.registrySlot,
          blinding,
          amount,
          aliasHash: to.proof.aliasHash,
          dataHash:  to.proof.dataHash,
          registrySiblings: to.proof.siblings,
        },
        out1,
      ],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.pool, [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, amount, tokenAddress,
      [dummy0.nullifier, dummy1.nullifier],
      [entry.commitment, comm1],
      ZERO_TRANSACT_PARAMS,
      encryptedOutput0, "0x", proofBytes,
      // ETH arrives as msg.value; a token is pulled with safeTransferFrom and must send
      // none. Attaching it unconditionally made every ERC-20 deposit revert with
      // WrongMsgValue(0, amount) — after the proof had already been generated.
      tokenAddress === ETH_TOKEN_ADDRESS ? amount : 0n,
    );
    return { txHash: await this.settle(tx), commitment: entry.commitment, amount };
  }

  /// Move value between two aliases without it leaving the pool.
  ///
  /// A relayer can be paid here for the same reason as on a withdrawal — so that someone
  /// holding notes but no ETH can transact at all. The cost is that it is no longer a pure
  /// transfer: the fee genuinely leaves the pool, so `publicAmount` becomes -fee and the
  /// chain shows a small withdrawal to the relayer where an unrelayed transfer shows
  /// nothing. The transfer amount and both aliases stay hidden regardless; what leaks is
  /// that *something* happened and what the fee was.
  async send(
    recipientName: string,
    amountEth: string,
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
    opts: { relayerFee?: bigint; relayer?: string; prepare?: boolean } = {},
  ): Promise<SendResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const sendAmount = ethers.parseEther(amountEth);
    const keys = this.keys!;
    const selfNullifierKeyHash = this.myNullifierKeyHash();

    const relayerFeeAmount = opts.relayerFee ?? 0n;
    if (relayerFeeAmount > 0n && !opts.relayer)
      throw new Error("relayerFee requires a relayer address to pay it to");

    const recipient  = await this.lookup(recipientName);
    // The fee comes out of the same note, so the note has to cover both.
    const entry      = this.selectEntry(sendAmount + relayerFeeAmount, tokenAddress);
    const nullifier  = computeNullifier(keys.nullifierKey, entry.treeNumber, entry.leafIndex);
    const recProof   = await this.registryProof(recipient.spendingPubkey);
    const selfProof  = await this.selfRegistryProof();

    const recipientBlinding = randomBlinding();
    const changeBlinding    = randomBlinding();
    const changeAmount = entry.amount - sendAmount - relayerFeeAmount;

    const recipientEntry = buildEntry(recipient.spendingPubkey, recipient.nullifierKeyHash, recipientBlinding, sendAmount, tokenAddress);
    const changeEntry    = buildEntry(keys.spendingPubkey, selfNullifierKeyHash, changeBlinding, changeAmount, tokenAddress);

    const recEncKey = recipient.encryptionPubkey;
    const recBlob = this.sealNote(recipientBlinding, sendAmount, recEncKey);
    const chgBlob = this.sealNote(changeBlinding, changeAmount);

    const anchor    = this.poolAnchor(entry.treeNumber);
    const poolProof = this.poolTrees.tree(entry.treeNumber).getProof(entry.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(anchor.tree, dBase, POOL_LEVELS);

    const recipientOut: TransactOutput = {
      pubkey:           recipient.spendingPubkey,
      nullifierKeyHash: recipient.nullifierKeyHash,
      registrySlot:     recProof.registrySlot,
      blinding:         recipientBlinding,
      amount:           sendAmount,
      aliasHash:        recProof.aliasHash,
      dataHash:         recProof.dataHash,
      registrySiblings: recProof.siblings,
    };
    const changeOut: TransactOutput = {
      pubkey:           keys.spendingPubkey,
      nullifierKeyHash: selfNullifierKeyHash,
      registrySlot:     selfProof.registrySlot,
      blinding:         changeBlinding,
      amount:           changeAmount,
      aliasHash:        selfProof.aliasHash,
      dataHash:         selfProof.dataHash,
      registrySiblings: selfProof.siblings,
    };

    const flip = Math.random() < 0.5;
    const [out0, out1]   = flip ? [changeOut,               recipientOut]               : [recipientOut,               changeOut];
    const [comm0, comm1] = flip ? [changeEntry.commitment,  recipientEntry.commitment]  : [recipientEntry.commitment,  changeEntry.commitment];
    const [blob0, blob1] = flip ? [chgBlob, recBlob] : [recBlob, chgBlob];

    // No public recipient: the fee is the only thing leaving, and it goes to the relayer
    // through the same payout path a withdrawal uses.
    const sendParams: TransactParams = relayerFeeAmount > 0n
      ? { recipient: ethers.ZeroAddress,
          relayerFee: { relayer: opts.relayer!, amount: relayerFeeAmount },
          externalData: ethers.ZeroHash }
      : ZERO_TRANSACT_PARAMS;
    const paramsHash  = computeParamsHash(sendParams, blob0, blob1, BigInt(this.config.chainId), this.config.poolAddress);
    const registryRoot = selfProof.registryRoot;
    const publicAmount = relayerFeeAmount > 0n ? FIELD_PRIME - relayerFeeAmount : 0n;

    const { proofBytes } = await proveTransact({
      poolRoot: [anchor.root, anchor.root], treeNumber: [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress, paramsHash,
      inputNullifiers:   [nullifier, dummy.nullifier],
      outputCommitments: [comm0, comm1],
      inputs: [
        {
          spendingPrivKey: keys.spendingPrivKey,
          viewingPrivKey:  keys.viewingPrivKey,
          blinding:  entry.blinding,
          amount:    entry.amount,
          pathIndices:  poolProof.pathIndices,
          pathElements: poolProof.pathElements,
        },
        dummy.input,
      ],
      outputs: [out0, out1],
    }, this.getArtifacts());

    if (opts.prepare) {
      const built = buildTransactParams(
        [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress,
        [nullifier, dummy.nullifier], [comm0, comm1], sendParams,
      );
      return {
        txHash: "",
        commitment: recipientEntry.commitment,
        amount: sendAmount,
        relayBlob: encodeRelayBlob({
          v: 1,
          kind: "transact",
          chainId: this.config.chainId,
          pool: this.config.poolAddress,
          params: built,
          encryptedOutput0: blob0,
          encryptedOutput1: blob1,
          proof: proofBytes,
        }),
      };
    }

    const tx = await contractTransact(
      this.pool, [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress,
      [nullifier, dummy.nullifier],
      [comm0, comm1],
      sendParams,
      blob0, blob1, proofBytes,
    );
    return { txHash: await this.settle(tx), commitment: recipientEntry.commitment, amount: sendAmount };
  }

  /// Move value out of the pool.
  ///
  /// `amountEth` is the total leaving the pool. When a relayer is named, its fee is taken
  /// out of that total and the pool pays both destinations itself — so the recipient
  /// receives `amountEth - relayerFee`. That is what lets someone holding no ETH pay for
  /// inclusion out of their own shielded funds: the fee is committed inside `paramsHash`,
  /// so whoever submits cannot inflate its own cut.
  ///
  /// `prepare` returns the transaction instead of sending it, as `relayBlob`. Someone with
  /// no ETH cannot broadcast at all, so preparing is the only way the relayed path is
  /// reachable for the person it exists for.
  async withdraw(
    recipientAddress: string,
    amountEth: string,
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
    externalData: string = ethers.ZeroHash,
    opts: { relayerFee?: bigint; relayer?: string; prepare?: boolean; uniform?: boolean } = {},
  ): Promise<WithdrawResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const amount          = ethers.parseEther(amountEth);
    const keys            = this.keys!;
    const nullifierKeyHash = this.myNullifierKeyHash();
    const entry           = this.selectEntry(amount, tokenAddress);
    const nullifier       = computeNullifier(keys.nullifierKey, entry.treeNumber, entry.leafIndex);
    const changeAmount    = entry.amount - amount;

    const anchor    = this.poolAnchor(entry.treeNumber);
    const poolProof = this.poolTrees.tree(entry.treeNumber).getProof(entry.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(anchor.tree, dBase, POOL_LEVELS);

    let out0: TransactOutput;
    let comm0: bigint;
    let encBlob0 = "0x";

    // Read whether or not there is change: the root it carries is what the proof commits to,
    // and a full withdrawal still has to name a registry root the pool will accept.
    const selfProof = await this.selfRegistryProof();

    if (changeAmount > 0n) {
      const changeBlinding = randomBlinding();
      const changeEntry    = buildEntry(keys.spendingPubkey, nullifierKeyHash, changeBlinding, changeAmount, tokenAddress);
      encBlob0 = this.sealNote(changeBlinding, changeAmount);
      out0 = {
        pubkey:           keys.spendingPubkey,
        nullifierKeyHash,
        registrySlot:     selfProof.registrySlot,
        blinding:         changeBlinding,
        amount:           changeAmount,
        aliasHash:        selfProof.aliasHash,
        dataHash:         selfProof.dataHash,
        registrySiblings: selfProof.siblings,
      };
      comm0 = changeEntry.commitment;
    } else {
      out0  = dummyOutput(randomBlinding());
      comm0 = poseidonHash([out0.pubkey, out0.nullifierKeyHash, out0.blinding, out0.amount, tokenAddress]);
    }

    const { out: out1, commitment: comm1 } = this.filler(tokenAddress);

    // Taking everything means there is nothing to insert, so skip the tree walk — 32 Poseidon
    // hashes and about 74% of what this transaction would otherwise cost.
    //
    // On by default, which is a deliberate inversion of the obvious choice. An exit IS
    // distinguishable on chain: it says this spender kept no change, where every ordinary
    // transact looks alike. But making it opt-in is worse for everyone. Almost nobody would
    // take it, so the few who did would stand out precisely because it was rare — while
    // everyone else paid ~1.87M gas to hide a single bit that amount-and-timing correlation
    // already gives away, on a transaction whose amount and recipient are public anyway.
    //
    // As an opt-OUT the asymmetry runs the right way. `uniform` inserts the two zero-amount
    // dummy commitments exactly as before, so the transaction is indistinguishable from any
    // transfer or partial withdrawal — a large, entirely ordinary crowd — rather than the
    // small marked set that opting in would have created.
    const exit = !opts.uniform && changeAmount <= 0n;

    const relayerFeeAmount = opts.relayerFee ?? 0n;
    if (relayerFeeAmount > 0n && !opts.relayer)
      throw new Error("relayerFee requires a relayer address to pay it to");
    if (relayerFeeAmount > amount)
      throw new Error("relayerFee cannot exceed the amount being withdrawn");

    const withdrawParams: TransactParams = {
      recipient: recipientAddress,
      relayerFee: relayerFeeAmount > 0n
        ? { relayer: opts.relayer!, amount: relayerFeeAmount }
        : NO_RELAYER,
      externalData,
    };
    const paramsHash  = computeParamsHash(withdrawParams, encBlob0, "0x", BigInt(this.config.chainId), this.config.poolAddress);
    const registryRoot = selfProof.registryRoot;
    const publicAmount = FIELD_PRIME - amount;

    const { proofBytes } = await proveTransact({
      poolRoot: [anchor.root, anchor.root], treeNumber: [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress, paramsHash,
      inputNullifiers:   [nullifier, dummy.nullifier],
      outputCommitments: [comm0, comm1],
      inputs: [
        {
          spendingPrivKey: keys.spendingPrivKey,
          viewingPrivKey:  keys.viewingPrivKey,
          blinding:  entry.blinding,
          amount:    entry.amount,
          pathIndices:  poolProof.pathIndices,
          pathElements: poolProof.pathElements,
        },
        dummy.input,
      ],
      outputs: [out0, out1],
      outputsEmpty: exit,
    }, this.getArtifacts());

    const built = buildTransactParams(
      [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress,
      [nullifier, dummy.nullifier], [comm0, comm1], withdrawParams, 0n, exit,
    );

    // Hand it over instead of sending it. Everything above is identical either way — the
    // proof is the same object whether this client submits it or someone else does.
    if (opts.prepare) {
      return {
        txHash: "",
        recipient: recipientAddress,
        amount,
        relayBlob: encodeRelayBlob({
          v: 1,
          kind: "transact",
          chainId: this.config.chainId,
          pool: this.config.poolAddress,
          params: built,
          encryptedOutput0: encBlob0,
          encryptedOutput1: "0x",
          proof: proofBytes,
        }),
      };
    }

    const tx = await this.pool.transact(built, encBlob0, "0x", proofBytes);
    return { txHash: await this.settle(tx), recipient: recipientAddress, amount };
  }

  async balance(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<BalanceResult> {
    this.ensureInit();
    await this.ensureSync();
    const entries = this.myEntries.filter(e =>
      e.amount > 0n &&
      e.tokenAddress === tokenAddress &&
      !this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.treeNumber, e.leafIndex))
    );
    const total = entries.reduce((s, e) => s + e.amount, 0n);
    return { total, entries };
  }

  // The aliasHash this account's spending key is registered under, or null if it has
  // never registered. A name cannot be recovered from it — aliasHash is a keccak — so a
  // caller that wants to display the name must remember what it registered.
  async myAliasHash(): Promise<bigint | null> {
    this.ensureInit();
    await this.ensureSync();
    return this.aliasHashByPubkey.get(this.keys!.spendingPubkey) ?? null;
  }

  // Current registration fee, read from the contract rather than assumed — it is
  // admin-settable, so a hardcoded figure in the UI would eventually be wrong.
  async registrationFee(): Promise<bigint> {
    this.ensureInit();
    return await this.domain.registrationFee() as bigint;
  }

  // Alias hashes this address owns, found by scanning registrations and checking the
  // ERC-721 owner. The contract does not implement ERC721Enumerable, so there is no
  // cheaper on-chain route — and the NAME cannot come back either, since aliasHash is a
  // keccak. A caller that wants to display names must remember what it registered.
  /// Every alias this wallet owns, paired with the index that derives its keys.
  ///
  /// The index is never stored anywhere — not on chain, not locally. It is recovered by
  /// deriving candidates and matching against the `spendingPubkey` the registry published
  /// at registration, which means a wallet alone is enough to restore everything. An alias
  /// whose index is not found within `maxIndex` comes back as `null`: it is still owned and
  /// still visible, but this wallet cannot currently spend from it.
  ///
  /// Static because it enumerates identities rather than acting as one — a client is bound
  /// to a single alias.
  static async discoverAliases(
    config: HaliasConfig,
    maxIndex: number = 32,
    root?: bigint,
  ): Promise<{ aliasHash: string; slot: number; name: string | null; index: number | null; root: bigint }[]> {
    // Pass `root` on any call after the first. Without it every enumeration signs again,
    // and enumeration happens after each registration.
    const probe = new Halias(config);
    await probe.init(0, root);
    const derived = probe.derivationRoot;
    const owned = await probe.myAliases();
    if (owned.length === 0) return [];   // caller already has `derived` if it passed one in

    // spendingPubkey -> index. Derived from the root the probe already obtained, so this
    // loop costs no signatures — deriving per index from the signer would ask the wallet
    // `maxIndex` times over.
    const byPubkey = new Map<bigint, number>();
    for (let i = 0; i < maxIndex; i++) {
      byPubkey.set(deriveKeysFromRoot(derived, i).spendingPubkey, i);
    }

    return owned.map((a) => {
      const entry = probe.registryEntries.find(
        (e) => e.aliasHash.toLowerCase() === a.aliasHash.toLowerCase(),
      );
      const index = entry ? byPubkey.get(entry.spendingPubkey) : undefined;
      return { ...a, index: index ?? null, root: derived };
    });
  }

  /// The plaintext registered under an aliasHash, if one was published.
  ///
  /// Recovery, not decoration. aliasHash is a keccak, so a client that loses local storage
  /// has no way back to the name it registered — and registration is the only moment the
  /// plaintext can be supplied, since someone who has forgotten it cannot supply it later
  /// either. Publishing is on by default for exactly that reason; this is the read side,
  /// which was missing.
  nameOf(aliasHash: string): string | null {
    return this.namesByAlias.get(aliasHash) ?? null;
  }

  async myAliases(): Promise<{ aliasHash: string; slot: number; name: string | null }[]> {
    this.ensureInit();
    await this.ensureSync();
    const me = await this.config.signer.getAddress();
    const owned: { aliasHash: string; slot: number; name: string | null }[] = [];
    for (const e of this.registryEntries) {
      try {
        const owner = await this.domain.ownerOf(BigInt(e.aliasHash)) as string;
        if (owner.toLowerCase() === me.toLowerCase()) {
          owned.push({
            aliasHash: e.aliasHash,
            slot: e.registrySlot,
            name: this.namesByAlias.get(e.aliasHash) ?? null,
          });
        }
      } catch { /* burned or unowned */ }
    }
    return owned;
  }

  async lookup(alias: string): Promise<LookupResult> {
    this.ensureInit();
    const cleanAlias = normalizeAlias(alias);
    const aliasHash = this.aliasHashOf(alias);
    const r = await contractLookupAlias(this.registry, aliasHash);
    if (r.spendingPubkey === 0n) throw new Error(`"${cleanAlias}.hls" is not registered`);
    return {
      spendingPubkey:   r.spendingPubkey,
      nullifierKeyHash: r.nullifierKeyHash,
      encryptionPubkey: ethers.getBytes(ethers.toBeHex(r.encryptionPubkey, 32)),
      dataHash:         r.dataHash,
    };
  }

  // There is no `updateKeys`. It rotated the nullifier and encryption keys but never the
  // spending pubkey, so the one compromise that loses funds was the one it could not answer.
  //
  // Rotation is a handover to yourself, and needs no method of its own because keys come from
  // the derivation index — fresh keys mean a client at a different one:
  //
  //     await atOldIndex.offerAlias(name, myAddress);
  //     await atNewIndex.acceptAlias(name);
  //
  // That replaces all three keys, keeps the alias in its registry slot, and both halves are
  // signable — so someone locked out of a compromised key can have the whole rotation
  // relayed. What it does not preserve is `dataHash`, which `reassign` clears.

  /// Offer this alias to someone. Nothing moves until they accept.
  ///
  /// Deliberately not a transfer. The old `transferAlias` let the *sender* choose the new
  /// keys alongside the new owner, and nothing related the two — so a seller could hand over
  /// the token while installing keys they kept, and every payment to that name would arrive
  /// for them. Only the recipient can say which keys are theirs.
  async offerAlias(alias: string, to: string): Promise<{ txHash: string }> {
    return this.offerAliasByHash(this.aliasHashOf(alias), to);
  }

  /// Offer by hash, for an alias this client cannot derive keys for.
  ///
  /// Offering is authorised by the owner's signature and touches no note keys, so an alias
  /// whose keys are lost is still transferable. That is what makes it recoverable: offer it
  /// to yourself and accept with a key set you do have, and the name works again under new
  /// keys. Notes it already received stay unreadable — those needed the old viewing key.
  async offerAliasByHash(aliasHash: bigint, to: string): Promise<{ txHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    const tx = await contractOfferAlias(this.domain, aliasHash, to, await this.nextNonce());
    return { txHash: await this.settle(tx) };
  }

  async cancelOffer(alias: string): Promise<{ txHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    const tx = await contractCancelOffer(this.domain, this.aliasHashOf(alias), await this.nextNonce());
    return { txHash: await this.settle(tx) };
  }

  /// Accept an alias offered to this client, installing keys derived at `aliasIndex`.
  ///
  /// Returns the signature and a `submit` that anyone may call — the recipient authorises,
  /// a relayer can pay. `prepare` stops before submitting, for the gasless path.
  async acceptAlias(
    alias: string,
    opts: { prepare?: boolean; deadlineSeconds?: number } = {},
  ): Promise<{ txHash: string; signature: string; deadline: bigint }> {
    return this.acceptOffer(this.aliasHashOf(alias), opts);
  }

  /// Accept by alias hash, for an offer found rather than told.
  ///
  /// The contract identifies an alias by hash, so the name is never needed to accept one —
  /// which matters because an offer is discoverable from `AliasOffered` while the name behind
  /// its hash is not. Someone offered an alias out of the blue can take it without having to
  /// be told what it is called.
  async acceptOffer(
    aliasHash: bigint,
    opts: { prepare?: boolean; deadlineSeconds?: number } = {},
  ): Promise<{ txHash: string; signature: string; deadline: bigint }> {
    this.ensureInit();
    this.ensureSpendable();
    const keys = this.keys!;
    const accepted = await contractAcceptAlias(
      this.domain,
      aliasHash,
      {
        spendingPubkey:   keys.spendingPubkey,
        nullifierKeyHash: this.myNullifierKeyHash(),
        encryptionPubkey: BigInt(ethers.hexlify(keys.encryption.publicKey)),
      },
      this.config.signer,
      { deadlineSeconds: opts.deadlineSeconds },
    );

    if (opts.prepare) {
      return { txHash: "", signature: accepted.signature, deadline: accepted.deadline };
    }
    const tx = await accepted.submit();
    return {
      txHash: await this.settle(tx),
      signature: accepted.signature,
      deadline: accepted.deadline,
    };
  }

  async updateAliasData(alias: string, newDataHash: bigint): Promise<{ txHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    const aliasHash = this.aliasHashOf(alias);

    const tx = await contractUpdateAliasData(this.domain, aliasHash, newDataHash);
    return { txHash: await this.settle(tx) };
  }

  /// Empty an alias, then offer it on.
  ///
  /// The recipient's keys are not a parameter and cannot be: only they can assert which keys
  /// are theirs, so they complete the handover with {acceptAlias}. Until they do, nothing has
  /// moved — this client still owns the alias and still receives to it.
  ///
  /// Sweeping first is a courtesy, not a guarantee. Nothing on chain can verify an alias is
  /// empty — the pool cannot compute an alias's balance without breaking the privacy that is
  /// the point of it — and notes already under this client's spending key stay spendable by
  /// it regardless. A buyer is acquiring the name and everything paid to it from now on,
  /// never a balance.
  async sweepAndOffer(
    alias: string,
    recipientAddress: string,
    newOwner: string,
  ): Promise<{ sweepTxHashes: string[]; offerTxHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const sweepTxHashes: string[] = [];
    const keys = this.keys!;

    const unspent = this.myEntries.filter(e =>
      e.amount > 0n &&
      !this.spentNullifiers.has(computeNullifier(keys.nullifierKey, e.treeNumber, e.leafIndex))
    );
    let lastNonce: number | undefined;
    for (const entry of unspent) {
      const result = await this.withdraw(recipientAddress, ethers.formatEther(entry.amount));
      sweepTxHashes.push(result.txHash);
      lastNonce = (await this.config.provider.getTransaction(result.txHash))?.nonce;
    }

    // Chained from the sweep we just mined rather than resolved by ethers. Sweeping and
    // offering are the only two sends in this SDK with no proof between them, and a proof is
    // what usually gives the provider's view time to catch up.
    const tx = await contractOfferAlias(
      this.domain, this.aliasHashOf(alias), newOwner,
      lastNonce === undefined ? undefined : lastNonce + 1,
    );
    return { sweepTxHashes, offerTxHash: await this.settle(tx) };
  }

  // ── Invite links ──────────────────────────────────────────────────────────
  //
  // The inviter does everything up front, alone: derive a temp keypair from a random
  // secret, register it as an UNNAMED account (a random aliasHash with no name
  // preimage), and fund it with a note. The claimer only needs the secret.
  //
  // Registering the temp account is not optional. The circuit enforces registry
  // membership for every non-zero output, so an unregistered recipient cannot be paid
  // at all — which is exactly what the old aliasHash=0 voucher path got wrong.
  //
  // The inviter keeps the secret and can reclaim an unclaimed invite by spending the
  // note normally. That also means they could claw it back after the claimer sees it,
  // so a claimer should claim promptly. This is inherent to any one-shot link: whoever
  // generates the secret knows it.
  async createInvite(amountEth: string): Promise<InviteResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const amount = ethers.parseEther(amountEth);
    const secret = randomBlinding();
    const temp   = deriveInviteKeys(secret);

    // The invite account needs a registry entry — its note is a non-zero output, and those
    // must prove membership — so it needs a name like any other alias.
    //
    // Derived from the secret rather than random, and through a hash rather than directly:
    // deterministic means it can be recomputed instead of remembered, and hashing means
    // publishing the name does not publish the secret that spends the note. The prefix marks
    // it as machinery in the directory; a user alias cannot collide, since those are
    // validated lowercase alphanumeric and this contains a hyphen.
    const inviteName = `invite-${ethers.keccak256(ethers.toBeHex(secret, 32)).slice(2, 18)}.hls`;
    const tempAliasHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(inviteName)));
    const registrationFee = await this.domain.registrationFee() as bigint;

    // From the invite secret, for the same reason: whoever can create this registration
    // already holds the secret, and nobody else can derive the salt from the public name.
    const inviteSalt = ethers.keccak256(ethers.concat([
      ethers.toBeHex(secret, 32), ethers.toUtf8Bytes(inviteName),
    ]));
    const regTx = await contractRegister(
      this.domain, inviteName, temp.spendingPubkey,
      temp.nullifierKeyHash, temp.encryptionPubkeyField, registrationFee, inviteSalt,
    );
    await regTx.wait();
    await this.refresh();

    const entry = buildEntry(temp.spendingPubkey, temp.nullifierKeyHash, temp.blinding, amount, ETH_TOKEN_ADDRESS);

    // Encrypted to the temp key derived from the secret, so holding the secret is
    // sufficient to discover and decrypt the note — nothing else is transmitted.
    const encryptedOutput0 = this.sealNote(temp.blinding, amount, temp.encryption.publicKey);

    const { out: out1, commitment: comm1 } = this.filler(ETH_TOKEN_ADDRESS);

    const dBase  = this.consumeDummyIdx(2);
    const anchor = this.poolAnchor();
    const dummy0 = dummyInput(anchor.tree, dBase, POOL_LEVELS);
    const dummy1 = dummyInput(anchor.tree, dBase + 1, POOL_LEVELS);

    const paramsHash   = computeParamsHash(ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", BigInt(this.config.chainId), this.config.poolAddress);
    const tempProof    = await this.registryProof(temp.spendingPubkey, "Invite account");
    const registryRoot = tempProof.registryRoot;
    const siblings     = tempProof.siblings;

    const { proofBytes } = await proveTransact({
      poolRoot: [anchor.root, anchor.root], treeNumber: [anchor.tree, anchor.tree], registryRoot, publicAmount: amount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   [dummy0.nullifier, dummy1.nullifier],
      outputCommitments: [entry.commitment, comm1],
      inputs: [dummy0.input, dummy1.input],
      outputs: [
        { pubkey: temp.spendingPubkey, nullifierKeyHash: temp.nullifierKeyHash, blinding: temp.blinding,
          amount, aliasHash: tempAliasHash, registrySlot: tempProof.registrySlot,
          dataHash: 0n, registrySiblings: siblings },
        out1,
      ],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.pool, [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, amount, ETH_TOKEN_ADDRESS,
      [dummy0.nullifier, dummy1.nullifier],
      [entry.commitment, comm1],
      ZERO_TRANSACT_PARAMS,
      encryptedOutput0, "0x", proofBytes, amount,
    );
    return { txHash: await this.settle(tx), secret, inviteCode: encodeInviteCode(secret), amount };
  }

  // Claim an invite: register `alias` and pay registrationFee out of the invite note.
  //
  // relayerFee > 0 lets a third party broadcast this and be reimbursed from the note, so
  // a claimer holding no ETH at all can still be registered. The relayer is named inside
  // paramsHash, so it cannot alter the amount, the destination, or its own cut.
  //
  // The proof targets the registry root AFTER this registration, because the change note
  // is addressed to the alias being created. registerWithPoolNote registers before it
  // verifies, and the new root is pushed to history immediately, so it is already valid.
  /// Redeem an invite.
  ///
  /// `relayerFee` comes out of the invite note itself and is chosen here, by the claimer —
  /// the person who created the invite specifies nothing. That is deliberate: they cannot
  /// know gas prices at redemption, which may be days later. Their only obligation is to
  /// fund enough to cover the registration fee plus whatever relaying costs.
  ///
  /// `prepare` returns the transaction instead of sending it, so someone else can submit it.
  /// Safe to hand over: the blob carries the proof rather than the secret, and `owner` is
  /// bound into `externalData`, so a submitter cannot mint the alias to itself.
  async claimInvite(
    secret: bigint,
    alias: string,
    opts: { relayerFee?: bigint; relayer?: string; prepare?: boolean } = {},
  ): Promise<{ txHash: string; relayBlob?: string }> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();
    const cleanAlias = normalizeAlias(alias);

    const relayerFee = opts.relayerFee ?? 0n;
    const relayer    = opts.relayer ?? ethers.ZeroAddress;
    if (relayerFee > 0n && relayer === ethers.ZeroAddress)
      throw new Error("relayerFee requires a relayer address");

    const temp = deriveInviteKeys(secret);
    const note = await this.findInviteNote(temp);
    if (!note) throw new Error("No unspent invite note found for this secret");

    const aliasHash = this.aliasHashOf(alias);
    const smtKey     = aliasHash % FIELD_PRIME;

    const keys             = this.keys!;
    const nullifierKeyHash = this.myNullifierKeyHash();
    const encBytes32       = BigInt(ethers.hexlify(keys.encryption.publicKey));

    const registrationFee = await this.domain.registrationFee() as bigint;
    const absAmount       = registrationFee + relayerFee;
    if (note.amount < absAmount)
      throw new Error(`Invite note ${ethers.formatEther(note.amount)} ETH cannot cover fee + relayer (${ethers.formatEther(absAmount)} ETH)`);

    // The change belongs to the claimer, and it has to.
    //
    // Addressing it to the invite account instead looks tempting — that account already
    // exists, so nothing about a future tree would be involved at all. It is unsound: the
    // change note becomes indistinguishable from the invite note it came from, so the invite
    // reads as unspent and is claimable again; and the *inviter* knows the secret, so they
    // could spend the claimer's remainder or buy another name with it. Tried, caught by
    // "the same invite cannot be claimed twice", reverted. Do not re-attempt.
    //
    // So the claimer's own alias has to be in the tree the proof checks against, and it is
    // not registered yet. This used to predict the post-registration root, which meant any
    // other registry write landing in between invalidated the claim (F1) — cheap to trigger
    // on purpose, and worst on the onboarding path.
    //
    // Nothing is predicted now. The proof carries the insertion: it proves against the
    // CURRENT root, shows the target slot is empty there, and derives the tree that results
    // from adding this leaf. Whatever else lands afterwards, that root stays valid for the
    // freshness window, and the derivation is unaffected by it.
    const ownSlot     = Number(await this.registry.nextAliasSlot() as bigint);
    const leafValue   = poseidonHash([keys.spendingPubkey, nullifierKeyHash, 0n]);
    const pendingLeaf = poseidonHash([smtKey, leafValue, 1n]);
    // The claim reads its witness straight from the registry, which is the case that looked
    // like it needed a local tree and does not. `ownSlot` is unassigned — nobody holds it
    // yet — and getSmtSiblings answers for an empty slot exactly as it does for a full one:
    // the path nodes are absent, but the siblings beside them are what matter, and those
    // exist. They serve both proofs at once, because the siblings of a slot do not change
    // when only that slot does — the emptiness proof against the current root, and the change
    // note's membership proof against the root derived by filling it.
    //
    // Pinned to one block, so the root the proof commits to is the root these siblings build.
    const blockTag = await this.headBlock();
    const [pendingSiblingsRaw, registryRootRaw] = await Promise.all([
      this.registry.getSmtSiblings(ownSlot, { blockTag }) as Promise<string[]>,
      this.registry.getRegistryRoot({ blockTag }) as Promise<string>,
    ]);
    const pendingSiblings = pendingSiblingsRaw.map(BigInt);
    const registryRoot    = BigInt(registryRootRaw);

    const changeAmount = note.amount - absAmount;
    const changeBlind  = randomBlinding();
    const changeOut = changeAmount > 0n
      ? { pubkey: keys.spendingPubkey, nullifierKeyHash, blinding: changeBlind, amount: changeAmount,
          aliasHash: smtKey, registrySlot: ownSlot, dataHash: 0n,
          registrySiblings: pendingSiblings }
      : dummyOutput(randomBlinding());
    const comm0 = poseidonHash([changeOut.pubkey, changeOut.nullifierKeyHash, changeOut.blinding, changeOut.amount, ETH_TOKEN_ADDRESS]);

    // Encrypt the change to the claimer's own key.
    //
    // This used to pass "0x" for both ciphertexts, which lost the remainder permanently:
    // the commitment lands in the pool but there is no blob to decrypt, so findMyOutputs
    // can never see it, and the blinding is generated here and never persisted. The note
    // was unspendable by anyone, including its owner — on the flow whose entire purpose is
    // onboarding someone with no funds.
    const changeBlob = changeAmount > 0n
      ? (() => {
          return this.sealNote(changeBlind, changeAmount);
        })()
      : "0x";

    const { out: out1, commitment: comm1 } = this.filler(ETH_TOKEN_ADDRESS);

    const anchor    = this.poolAnchor(note.treeNumber);
    const poolProof = this.poolTrees.tree(note.treeNumber).getProof(note.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(anchor.tree, dBase, POOL_LEVELS);

    const nullifier0 = computeNullifier(temp.nullifierKey, note.treeNumber, note.leafIndex);

    // The registration the proof authorises. Hashing it into externalData is what stops a
    // relayer minting the alias to itself: the domain recomputes this from its own
    // arguments and refuses anything that does not match, and the hash is inside
    // paramsHash, so a submitter cannot alter it without invalidating the proof.
    const registration = {
      owner:            await this.config.signer.getAddress(),
      aliasHash,
      spendingPubkey:   keys.spendingPubkey,
      nullifierKeyHash,
      encryptionPubkey: encBytes32,
    };

    // The relayer is now a first-class field the pool settles directly, rather than a
    // packed word this contract has to split up. The pool pays the relayer its fee and
    // sends the remainder — exactly the registration fee — on to the domain.
    const params: TransactParams = {
      recipient:    this.config.controllerAddress,
      relayerFee:   relayerFee > 0n ? { relayer, amount: relayerFee } : NO_RELAYER,
      externalData: encodeRegistration(registration),
    };

    const publicAmount = FIELD_PRIME - absAmount;
    const paramsHash   = computeParamsHash(params, changeBlob, "0x", BigInt(this.config.chainId), this.config.poolAddress);
    
    const { proofBytes } = await proveTransact({
      poolRoot: [anchor.root, anchor.root], treeNumber: [anchor.tree, anchor.tree], registryRoot, publicAmount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   [nullifier0, dummy.nullifier],
      outputCommitments: [comm0, comm1],
      inputs: [
        { spendingPrivKey: temp.spendingPrivKey, viewingPrivKey: temp.viewingPrivKey,
          blinding: note.blinding, amount: note.amount,
          pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
        dummy.input,
      ],
      outputs: [changeOut, out1],
      pending: { leaf: pendingLeaf, slot: ownSlot, siblings: pendingSiblings },
    }, this.getArtifacts());

    if (opts.prepare) {
      return {
        txHash: "",
        relayBlob: encodeRelayBlob({
          v: 1,
          kind: "claim",
          chainId: this.config.chainId,
          pool: this.config.poolAddress,
          params: buildTransactParams(
            [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, publicAmount, ETH_TOKEN_ADDRESS,
            [nullifier0, dummy.nullifier], [comm0, comm1], params, pendingLeaf,
          ),
          encryptedOutput0: changeBlob,
          encryptedOutput1: "0x",
          proof: proofBytes,
          claim: {
            domain: this.config.controllerAddress,
            registration: registrationTuple(registration),
            name: `${cleanAlias}.hls`,
          },
        }),
      };
    }

    const tx = await contractClaim(
      this.domain, registration,
      [anchor.root, anchor.root], [anchor.tree, anchor.tree], registryRoot, publicAmount,
      [nullifier0, dummy.nullifier],
      [comm0, comm1],
      params, changeBlob, "0x", proofBytes, `${cleanAlias}.hls`, pendingLeaf,
    );
    return { txHash: await this.settle(tx) };
  }

  // Locate the unspent pool note belonging to an invite's temp keypair. The note is a
  // perfectly ordinary output encrypted to the temp encryption key, so the normal
  // decrypt-and-match path finds it — no special-case scanning.
  private async findInviteNote(temp: InviteKeys): Promise<OwnedEntry | null> {
    // The one place ciphertext is needed after the fact. The cache drops it — it is the bulk
    // of the bytes and its only use is trial decryption, which has already happened for every
    // output the client itself owns. An invite is decrypted with a *different* key, so a warm
    // client has to fetch the blobs again before it can look.
    if (this.allOutputs.some((o) => o.encryptedBlob === "")) {
      this.lastBlock = 0;
      this.allOutputs = [];
      this.myEntries = [];
      this.poolTrees = new PoolTrees();
      this.registryEntries = [];
      this.aliasHashByPubkey = new Map();
      this.spentNullifiers = new Set();
      await this.refresh();
    }
    const owned = findMyOutputs(
      this.allOutputs, temp.spendingPubkey, temp.nullifierKey, temp.encryption.privateKey,
    );
    return owned.find(e => !this.spentNullifiers.has(computeNullifier(temp.nullifierKey, e.treeNumber, e.leafIndex))) ?? null;
  }

  /// Everything this alias has done, newest first.
  ///
  /// Reconstructed rather than recorded: nothing on chain says "alice deposited". What is
  /// visible is which notes we can decrypt and which nullifiers of ours were spent, and the
  /// four cases fall out of combining those with `publicAmount`:
  ///
  ///   spent ours + publicAmount < 0   withdrew
  ///   spent ours + publicAmount == 0  sent (a private transfer we authored)
  ///   gained ours + publicAmount > 0  deposited
  ///   gained ours, spent none         received
  ///
  /// A send also creates our own change note in the same transaction, which is why entries
  /// are grouped by transaction rather than by note — otherwise every send would also show
  /// up as a receipt of its own change.
  async history(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<HistoryEntry[]> {
    this.ensureInit();
    await this.ensureSync();
    const keys = this.keys!;
    const mine = new Set(this.myEntries.map((e) => e.commitment));
    const myNullifiers = new Set(
      this.myEntries.map((e) => computeNullifier(keys.nullifierKey, e.treeNumber, e.leafIndex)),
    );

    const byTx = new Map<string, Output[]>();
    for (const o of this.allOutputs) {
      if (o.tokenAddress !== tokenAddress) continue;
      if (!byTx.has(o.txHash)) byTx.set(o.txHash, []);
      byTx.get(o.txHash)!.push(o);
    }

    const out: HistoryEntry[] = [];

    // The registration itself. It lives in the registry's events, not the pool's, so it is
    // invisible to the loop below — but it is the first thing that ever happened to this
    // alias and a history starting at the first deposit reads as though it appeared from
    // nowhere.
    const selfAlias = this.aliasHashByPubkey.get(keys.spendingPubkey);
    if (selfAlias !== undefined) {
      // aliasHashByPubkey stores the value the SMT keys on, so compare on that rather than
      // on the raw 32 bytes — they differ whenever the hash exceeds the field prime.
      const reg = this.registryEntries.find(
        (e) => aliasHashToSmtKey(BigInt(e.aliasHash)) === selfAlias || BigInt(e.aliasHash) === selfAlias,
      );
      if (reg && reg.txHash) {
        out.push({
          kind: "register",
          amount: 0n,
          tokenAddress,
          txHash: reg.txHash,
          blockNumber: reg.blockNumber,
          gasFee: 0n, feePayer: "",
          // Registration goes through the domain contract, not the pool — no relay path.
          relayed: false, relayerFee: 0n,
        });
      }
    }
    for (const [txHash, outputs] of byTx) {
      const first = outputs[0];
      const spentMine = first.spentNullifiers.some((n) => myNullifiers.has(n));
      const gained = outputs.filter((o) => mine.has(o.commitment));
      if (!spentMine && gained.length === 0) continue;   // someone else's transaction

      const gainedTotal = gained.reduce(
        (sum, o) => sum + (this.myEntries.find((e) => e.commitment === o.commitment)?.amount ?? 0n),
        0n,
      );
      const isWithdraw = first.publicAmount >= FIELD_PRIME - (1n << 248n);
      const absPublic = isWithdraw ? FIELD_PRIME - first.publicAmount : first.publicAmount;

      let kind: HistoryEntry["kind"];
      let amount: bigint;
      let relayed = false;
      let relayerFee = 0n;
      if (spentMine && isWithdraw) {
        kind = "withdraw";
        amount = absPublic;
        // The fee is folded into the total leaving, so it cannot be separated here. Settled
        // below from the receipt instead: if we did not submit it, someone else did, and the
        // relay path is the only way that happens.
      } else if (spentMine) {
        kind = "send";
        // What left this alias: the inputs consumed, less the change that came back.
        amount = (this.spentTotalFor(first) ?? 0n) - gainedTotal;
        // A transfer moves nothing in or out of the pool — publicAmount is exactly zero —
        // unless a submitter was paid. So a non-zero value here *is* the fee.
        relayed = isWithdraw && absPublic > 0n;
        relayerFee = relayed ? absPublic : 0n;
      } else if (absPublic > 0n && !isWithdraw) {
        kind = "deposit";
        amount = absPublic;
        // Deposits cannot be relayed: the value has to come from whoever sends it.
      } else {
        kind = "receive";
        amount = gainedTotal;
        relayed = isWithdraw && absPublic > 0n;
        relayerFee = relayed ? absPublic : 0n;
      }

      out.push({
        kind, amount, tokenAddress, txHash,
        blockNumber: first.blockNumber,
        gasFee: 0n, feePayer: "", relayed, relayerFee,
      });
    }

    // Costs come from receipts, one request each. Fetched together rather than in sequence,
    // and only for entries that survived the filtering above.
    const receipts = await Promise.all(
      out.map((e) => this.config.provider.getTransactionReceipt(e.txHash).catch(() => null)),
    );
    const me = (await this.config.signer.getAddress()).toLowerCase();
    out.forEach((e, i) => {
      const r = receipts[i];
      if (!r) return;
      e.gasFee = r.gasUsed * (r.gasPrice ?? 0n);
      e.feePayer = r.from;
      // Only for withdrawals, where publicAmount cannot separate the fee out. For anything
      // we authored, an address that is not ours means someone else submitted it, and the
      // relay path is the only mechanism for that.
      if (e.kind === "withdraw" && r.from.toLowerCase() !== me) e.relayed = true;
    });

    return out.sort((a, b) => b.blockNumber - a.blockNumber);
  }

  /// Total value of our notes consumed by a transaction, for working out what a send
  /// actually moved once change is deducted.
  private spentTotalFor(o: Output): bigint | null {
    const keys = this.keys!;
    let total = 0n;
    let found = false;
    for (const e of this.myEntries) {
      if (o.spentNullifiers.includes(computeNullifier(keys.nullifierKey, e.treeNumber, e.leafIndex))) {
        total += e.amount;
        found = true;
      }
    }
    return found ? total : null;
  }

  /// Facts that bear on how private a withdrawal will be.
  ///
  /// Deliberately not a score. A single number invites false confidence, and the honest
  /// inputs are legible on their own: how many notes exist to hide among, how many of them
  /// are yours, and whether anyone else has moved since you deposited. A score can be
  /// derived from these later once there is real usage to calibrate against — inventing one
  /// now would be a number with no meaning behind it.
  async privacyContext(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<PrivacyContext> {
    this.ensureInit();
    await this.ensureSync();

    // Counted from the scan rather than read from the pool. There is no single on-chain
    // counter to read: the pool is a sequence of trees, and its `leafIndex` is the position
    // within the tree currently filling, not a total. Every commitment ever inserted is an
    // output this scan has already seen.
    const anonymitySet = this.allOutputs.length;
    const mine = this.myEntries.filter((e) => e.tokenAddress === tokenAddress).length;

    // Blocks since our newest note landed. A withdrawal in the same block as its deposit
    // correlates the two by timing alone, whatever the proof hides.
    //
    // Ordered by global position, not by leafIndex. Across trees a leaf index says nothing
    // about age — leaf 5 of tree 1 is newer than leaf 100 of tree 0 — so comparing indices
    // alone picks the wrong note as newest, and then matches it against whichever output
    // happens to share that index in some other tree.
    const globalIndex = (o: { treeNumber: number; leafIndex: number }) =>
      (BigInt(o.treeNumber) << BigInt(POOL_LEVELS)) + BigInt(o.leafIndex);
    const newest = this.myEntries.reduce<bigint>((m, e) => {
      const g = globalIndex(e);
      return g > m ? g : m;
    }, -1n);
    const latest = await this.config.provider.getBlockNumber();
    const newestBlock =
      this.allOutputs.find((o) => globalIndex(o) === newest)?.blockNumber ?? latest;

    return {
      anonymitySet,
      myNotes: mine,
      blocksSinceLastNote: Math.max(0, latest - newestBlock),
      // Every commitment ever inserted, ours included — the set a withdrawal is
      // indistinguishable within.
      othersSinceLastNote: this.allOutputs.filter((o) => o.blockNumber > newestBlock).length,
    };
  }

  async scan(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<ScanEntry[]> {
    this.ensureInit();
    await this.ensureSync();
    return this.myEntries
      .filter(e => e.tokenAddress === tokenAddress)
      .map(e => ({
        ...e,
        spent: this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.treeNumber, e.leafIndex)),
      }));
  }
}
