import { ethers } from "ethers";
import { normalizeAlias, AliasTakenError, aliasPrefix } from "./alias";
import { deriveKeysFromRoot, poseidonHash } from "./crypto";
import { buildEntry, computeNullifier, randomBlinding, OwnedEntry, ETH_TOKEN_ADDRESS, POOL_LEVELS, FIELD_PRIME } from "./entry";
import { PoolTrees } from "./merkle";
import { aliasHashToSmtKey } from "./smt";
import { proveTransact, dummyOutput, TransactOutput, POOL_INPUTS } from "./proof";
import { findMyOutputs, Output } from "./events";
import { deriveInviteKeys, inviteSecretAt, InviteKeys, encodeInviteCode } from "./invite";
import { encodeViewKey, viewKeysFrom } from "./viewkey";
import {
  
  
  
  transact as contractTransact,
  register as contractRegister,
  directRegistration as contractDirectRegistration,
  signOfferAlias as contractSignOfferAlias,
  signCancelOffer as contractSignCancelOffer,
  signUpdateAliasData as contractSignUpdateAliasData,
  acceptAlias as contractAcceptAlias,
  claim as contractClaim,
  registrationTuple,
  encodeRegistration,
  computeParamsHash,
  TransactParams,
  ZERO_TRANSACT_PARAMS,
  NO_RELAYER,
  getAliasesByPrefix,
} from "./contract";


import { HaliasCore } from "./client-core";
import { encodeRelayBlob } from "./relay";
import { buildTransactParams } from "./contract";
// Declared alongside the state they describe; re-exported here so `halias-sdk` importers
// see them on the same module as the class that returns them.
import type {
  HaliasConfig, DepositResult, SendResult, WithdrawResult,
  BalanceResult, LookupResult, InviteResult, ScanEntry, ConsolidateResult, TokenInfo,
} from "./client-core";
/// One invite this wallet created, and whether it can still be taken back.
export interface InviteSummary {
  /// Its derivation index — what {reclaimInvite} takes.
  index: number;
  secret: bigint;
  inviteCode: string;
  /// The alias it registered, derived from the secret.
  name: string;
  /// What it still holds, or null once the note has been spent.
  amount: bigint | null;
  /// False once claimed. Says nothing about who claimed it — nothing on chain does.
  claimable: boolean;
}

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
  BalanceResult, LookupResult, InviteResult, ScanEntry, ConsolidateResult, TokenInfo,
};

/// The public surface: everything a caller can do with an alias or a note.
export class Halias extends HaliasCore {
  // ── Operations ─────────────────────────────────────────────────────────────

  /// Register `alias` under this client's alias index.
  ///
  /// The name is always published, and withholding it is not offered. An unpublished alias is
  /// not unguessable: `aliasHash` is keccak of the name
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
  /// and matches them against the spending commitments the registry publishes; see
  /// {aliasIndexOf}.
  ///
  /// Throws {AliasTakenError} without sending anything if the name is already registered.
  async register(
    alias: string,
    /// "waiting" sits between them: the reveal cannot be estimated until a block later than
    /// the commit exists, and a caller that cannot say so shows a second step that appears
    /// stuck. See {register} in contract.ts.
    onStep?: (step: "commit" | "waiting" | "register") => void,
    /// One transaction instead of two, and no front-running protection. Only correct where
    /// the mempool is not public; see {directRegistration} on the contract. Defaults off, and
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

    const spendingBytes32 = this.keys!.spendingCommitment;
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
      ? await contractDirectRegistration(
          this.domain, `${cleanAlias}.hls`, spendingBytes32, nullifierKeyHash, encBytes32,
          fee, this.keys!.owner.address)
      : await contractRegister(
          this.domain, `${cleanAlias}.hls`, spendingBytes32, nullifierKeyHash, encBytes32,
          fee, this.keys!.owner.address, salt, onStep);
    return { txHash: await this.settle(tx) };
  }

  /// The alias this client's keys belong to, found by matching its spending commitment against
  /// what the registry publishes.
  ///
  /// {myAliases} cannot answer this for a view key: it asks who *owns* the alias NFT, and a
  /// viewer owns nothing. The registry is the right source either way — it is what binds a
  /// key to a name.
  async selfAlias(): Promise<{ aliasHash: string; name: string | null; slot: number } | null> {
    this.ensureInit();
    await this.ensureSync();
    const hash = this.aliasHashByPubkey.get(this.keys!.spendingCommitment);
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
      spendingCommitment:           this.keys!.spendingCommitment,
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
    const proof     = await this.registryProof(recipient.spendingCommitment);
    return this._deposit(amountEth, tokenAddress, {
      spendingCommitment:           recipient.spendingCommitment,
      nullifierKeyHash: recipient.nullifierKeyHash,
      encryptionPubkey: recipient.encryptionPubkey,
      proof,
    });
  }

  private async _deposit(
    amountEth: string,
    tokenAddress: bigint,
    to: {
      spendingCommitment: bigint;
      nullifierKeyHash: bigint;
      encryptionPubkey?: Uint8Array;
      proof: { aliasHash: bigint; registrySlot: number; siblings: bigint[]; dataHash: bigint; registryRoot: bigint };
    },
  ): Promise<DepositResult> {
    // Decimals first: `amountEth` is a human figure and means nothing without them. USDC's
    // 6 make "1.0" a millionth of what 18 would compute.
    await this.tokenInfo(tokenAddress);

    const amount   = this.parseAmount(amountEth, tokenAddress);
    const blinding = randomBlinding();
    const entry    = buildEntry(to.spendingCommitment, to.nullifierKeyHash, blinding, amount, tokenAddress);

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

    const pad = this.padInputs([], this.poolAnchor());

    // Sealed to the recipient's key, so only they can find and spend it. Paying an alias
    // whose note you encrypted to yourself would burn the funds.
    const encryptedOutput0 = this.sealNote(blinding, amount, to.encryptionPubkey);

    const { out: out1, commitment: comm1 } = this.filler(tokenAddress);

    const paramsHash = computeParamsHash(ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", BigInt(this.config.chainId), this.config.poolAddress);
    const registryRoot = to.proof.registryRoot;

    const { proofBytes } = await proveTransact({
      poolRoot: pad.poolRoot, treeNumber: pad.treeNumber, registryRoot, publicAmount: amount, tokenAddress, paramsHash,
      inputNullifiers:  pad.inputNullifiers,
      outputCommitments: [entry.commitment, comm1],
      inputs: pad.inputs,
      outputs: [
        {
          spendingCommitment:           to.spendingCommitment,
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
      this.pool, pad.poolRoot, pad.treeNumber, registryRoot, amount, tokenAddress,
      pad.inputNullifiers,
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

    await this.tokenInfo(tokenAddress);

    const sendAmount = this.parseAmount(amountEth, tokenAddress);
    const keys = this.keys!;
    const selfNullifierKeyHash = this.myNullifierKeyHash();

    const relayerFeeAmount = opts.relayerFee ?? 0n;
    if (relayerFeeAmount > 0n && !opts.relayer)
      throw new Error("relayerFee requires a relayer address to pay it to");

    const recipient  = await this.lookup(recipientName);
    // The fee comes out of the same notes, so they have to cover both. Two of them whenever
    // two exist — see selectEntries: filling both input slots is what keeps a wallet's note
    // count falling instead of climbing.
    const spend      = this.selectEntries(sendAmount + relayerFeeAmount, tokenAddress);
    const inputs     = this.buildInputs(spend);
    const recProof   = await this.registryProof(recipient.spendingCommitment);
    const selfProof  = await this.selfRegistryProof();

    const recipientBlinding = randomBlinding();
    const changeBlinding    = randomBlinding();
    const changeAmount = inputs.total - sendAmount - relayerFeeAmount;

    const recipientEntry = buildEntry(recipient.spendingCommitment, recipient.nullifierKeyHash, recipientBlinding, sendAmount, tokenAddress);
    const changeEntry    = buildEntry(keys.spendingCommitment, selfNullifierKeyHash, changeBlinding, changeAmount, tokenAddress);

    const recEncKey = recipient.encryptionPubkey;
    const recBlob = this.sealNote(recipientBlinding, sendAmount, recEncKey);
    const chgBlob = this.sealNote(changeBlinding, changeAmount);

    const recipientOut: TransactOutput = {
      spendingCommitment:           recipient.spendingCommitment,
      nullifierKeyHash: recipient.nullifierKeyHash,
      registrySlot:     recProof.registrySlot,
      blinding:         recipientBlinding,
      amount:           sendAmount,
      aliasHash:        recProof.aliasHash,
      dataHash:         recProof.dataHash,
      registrySiblings: recProof.siblings,
    };
    const changeOut: TransactOutput = {
      spendingCommitment:           keys.spendingCommitment,
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
      poolRoot: inputs.poolRoots, treeNumber: inputs.treeNumbers,
      registryRoot, publicAmount, tokenAddress, paramsHash,
      inputNullifiers:   inputs.nullifiers,
      outputCommitments: [comm0, comm1],
      inputs:            inputs.inputs,
      outputs: [out0, out1],
    }, this.getArtifacts());

    if (opts.prepare) {
      const built = buildTransactParams(
        inputs.poolRoots, inputs.treeNumbers, registryRoot, publicAmount, tokenAddress,
        inputs.nullifiers, [comm0, comm1], sendParams,
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
      this.pool, inputs.poolRoots, inputs.treeNumbers, registryRoot, publicAmount, tokenAddress,
      inputs.nullifiers,
      [comm0, comm1],
      sendParams,
      blob0, blob1, proofBytes,
    );
    return { txHash: await this.settle(tx), commitment: recipientEntry.commitment, amount: sendAmount };
  }

  /// Merge several notes into one.
  ///
  /// A transfer to nobody: both inputs are the caller's, the single output is the caller's,
  /// and `publicAmount` is zero, so no value enters or leaves the pool. On chain it is
  /// indistinguishable from any other transfer — two nullifiers, two commitments, one of
  /// which happens to be a zero-value filler exactly as a change-free transfer produces.
  private async mergeNotes(
    group: OwnedEntry[],
    tokenAddress: bigint,
    relayerFeeAmount: bigint,
    relayer?: string,
  ): Promise<string> {
    const keys      = this.keys!;
    const inputs    = this.buildInputs(group);
    const selfProof = await this.selfRegistryProof();

    const merged   = inputs.total - relayerFeeAmount;
    const blinding = randomBlinding();
    const entry    = buildEntry(keys.spendingCommitment, this.myNullifierKeyHash(), blinding, merged, tokenAddress);
    const blob     = this.sealNote(blinding, merged);

    const mergedOut: TransactOutput = {
      spendingCommitment:           keys.spendingCommitment,
      nullifierKeyHash: this.myNullifierKeyHash(),
      registrySlot:     selfProof.registrySlot,
      blinding,
      amount:           merged,
      aliasHash:        selfProof.aliasHash,
      dataHash:         selfProof.dataHash,
      registrySiblings: selfProof.siblings,
    };
    const { out: fill, commitment: fillComm } = this.filler(tokenAddress);

    // Which slot the real output lands in is randomised for the same reason it is on a
    // transfer: a fixed position would make consolidations recognisable as a class.
    const flip = Math.random() < 0.5;
    const [out0, out1]   = flip ? [fill, mergedOut] : [mergedOut, fill];
    const [comm0, comm1] = flip ? [fillComm, entry.commitment] : [entry.commitment, fillComm];
    const [blob0, blob1] = flip ? ["0x", blob] : [blob, "0x"];

    const params: TransactParams = relayerFeeAmount > 0n
      ? { recipient: ethers.ZeroAddress,
          relayerFee: { relayer: relayer!, amount: relayerFeeAmount },
          externalData: ethers.ZeroHash }
      : ZERO_TRANSACT_PARAMS;
    const paramsHash   = computeParamsHash(params, blob0, blob1, BigInt(this.config.chainId), this.config.poolAddress);
    const publicAmount = relayerFeeAmount > 0n ? FIELD_PRIME - relayerFeeAmount : 0n;

    const { proofBytes } = await proveTransact({
      poolRoot: inputs.poolRoots, treeNumber: inputs.treeNumbers,
      registryRoot: selfProof.registryRoot, publicAmount, tokenAddress, paramsHash,
      inputNullifiers:   inputs.nullifiers,
      outputCommitments: [comm0, comm1],
      inputs:            inputs.inputs,
      outputs: [out0, out1],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.pool, inputs.poolRoots, inputs.treeNumbers, selfProof.registryRoot, publicAmount,
      tokenAddress, inputs.nullifiers, [comm0, comm1], params, blob0, blob1, proofBytes,
    );
    return this.settle(tx);
  }

  /// Merge notes until the balance can be spent in one transaction.
  ///
  /// The circuit takes POOL_INPUTS inputs, so a balance spread wider than that cannot be
  /// paid out in full however it is selected — the wallet holds the money and cannot move it.
  /// Ordinary spending already fights this (see {selectEntries}, which always fills both
  /// input slots and so nets one note fewer per transaction), but a wallet paid more often
  /// than it spends still accumulates, and this is the deliberate fix.
  ///
  /// With `target`, merges only until the largest POOL_INPUTS notes cover that amount — the fewest transactions
  /// that unblock a specific payment. Without one, merges all the way down to a single note.
  ///
  /// Each merge is a separate transaction with its own proof, so this is slow and costs gas
  /// per step; `onProgress` is called before each so a caller can say so. It is safe to
  /// interrupt — every merge that landed stands on its own.
  async consolidate(
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
    opts: {
      target?: bigint;
      relayerFee?: bigint;
      relayer?: string;
      onProgress?: (p: { step: number; of: number; notes: number }) => void;
    } = {},
  ): Promise<ConsolidateResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();
    await this.tokenInfo(tokenAddress);

    const fee = opts.relayerFee ?? 0n;
    if (fee > 0n && !opts.relayer)
      throw new Error("relayerFee requires a relayer address to pay it to");

    const target = opts.target;
    const txHashes: string[] = [];

    // Recomputed each round rather than planned up front: every merge is a real transaction,
    // and notes may arrive while it runs.
    const done = () => {
      const notes = this.spendable(tokenAddress);
      if (target === undefined) return notes.length <= 1;
      // Sorted ascending, so the last POOL_INPUTS are the largest. Stopping at two here was a
      // bug once the circuit took four: it kept merging after the target was already reachable,
      // spending a fee and a round trip to reach a state it was already in.
      if (notes.length <= POOL_INPUTS) return true;
      return notes.slice(-POOL_INPUTS).reduce((t, e) => t + e.amount, 0n) >= target;
    };

    if (target !== undefined) {
      const total = this.spendable(tokenAddress).reduce((s, e) => s + e.amount, 0n);
      // Every merge burns a fee, so the reachable total is what is left after all of them.
      // A merge removes POOL_INPUTS - 1 notes, so the count is that many fewer than the note
      // count — using notes.length - 1 assumed pairwise merging and over-estimated the cost,
      // which refused consolidations that would in fact have succeeded.
      const count = this.spendable(tokenAddress).length;
      const worst = BigInt(Math.ceil(Math.max(0, count - 1) / (POOL_INPUTS - 1))) * fee;
      if (total - worst < target)
        throw new Error(
          `Balance ${this.formatAmount(total, tokenAddress)} ${this.symbolOf(tokenAddress)} ` +
          `cannot cover ${this.formatAmount(target, tokenAddress)} after ` +
          `${this.formatAmount(worst, tokenAddress)} of consolidation fees`);
    }

    // What is left to do, for the progress report. Reaching a target means getting it inside
    // the largest POOL_INPUTS notes, so the count is how many must disappear from the top;
    // tidying to one note is every note but the last.
    //
    // Each merge spends POOL_INPUTS notes and creates one, so it removes POOL_INPUTS - 1.
    const perMerge = POOL_INPUTS - 1;
    const remaining = () => {
      const notes = this.spendable(tokenAddress);
      if (target === undefined) return Math.ceil(Math.max(0, notes.length - 1) / perMerge);
      let sum = 0n, n = 0;
      for (let i = notes.length - 1; i >= 0 && sum < target; i--) { sum += notes[i].amount; n++; }
      return Math.ceil(Math.max(0, n - POOL_INPUTS) / perMerge);
    };

    const of = remaining();
    for (let step = 0; !done(); step++) {
      const notes = this.spendable(tokenAddress);
      opts.onProgress?.({ step, of: Math.max(of, step + 1), notes: notes.length });

      // How many to take, and which. A merge fills every input slot it can — taking only two
      // when the circuit holds four is what made a six-note wallet cost four transactions
      // instead of two.
      //
      // Which end depends on what is being asked for. Reaching a target wants the largest,
      // because that is the fastest route to a set that covers it. Tidying wants the
      // smallest, so an interrupted run has still cleared the dust.
      const take = Math.min(POOL_INPUTS, notes.length);
      const group = target === undefined
        ? notes.slice(0, take)
        : notes.slice(-take);

      txHashes.push(await this.mergeNotes(group, tokenAddress, fee, opts.relayer));
    }

    const left = this.spendable(tokenAddress);
    return { txHashes, notes: left.length, total: left.reduce((s, e) => s + e.amount, 0n) };
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

    await this.tokenInfo(tokenAddress);

    const amount          = this.parseAmount(amountEth, tokenAddress);
    const keys            = this.keys!;
    const nullifierKeyHash = this.myNullifierKeyHash();
    const spend           = this.selectEntries(amount, tokenAddress);
    const inputs          = this.buildInputs(spend);
    const changeAmount    = inputs.total - amount;

    let out0: TransactOutput;
    let comm0: bigint;
    let encBlob0 = "0x";

    // Read whether or not there is change: the root it carries is what the proof commits to,
    // and a full withdrawal still has to name a registry root the pool will accept.
    const selfProof = await this.selfRegistryProof();

    if (changeAmount > 0n) {
      const changeBlinding = randomBlinding();
      const changeEntry    = buildEntry(keys.spendingCommitment, nullifierKeyHash, changeBlinding, changeAmount, tokenAddress);
      encBlob0 = this.sealNote(changeBlinding, changeAmount);
      out0 = {
        spendingCommitment:           keys.spendingCommitment,
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
      comm0 = poseidonHash([out0.spendingCommitment, out0.nullifierKeyHash, out0.blinding, out0.amount, tokenAddress]);
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
      poolRoot: inputs.poolRoots, treeNumber: inputs.treeNumbers,
      registryRoot, publicAmount, tokenAddress, paramsHash,
      inputNullifiers:   inputs.nullifiers,
      outputCommitments: [comm0, comm1],
      inputs:            inputs.inputs,
      outputs: [out0, out1],
      outputsEmpty: exit,
    }, this.getArtifacts());

    const built = buildTransactParams(
      inputs.poolRoots, inputs.treeNumbers, registryRoot, publicAmount, tokenAddress,
      inputs.nullifiers, [comm0, comm1], withdrawParams, 0n, exit,
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
    const token = await this.tokenInfo(tokenAddress);
    const entries = this.spendable(tokenAddress);
    const total   = entries.reduce((s, e) => s + e.amount, 0n);
    return {
      token, total, entries,
      sendableNow: entries.slice(-POOL_INPUTS).reduce((s, e) => s + e.amount, 0n),
    };
  }

  /// Every token this alias actually holds a spendable note in, with what it holds.
  ///
  /// Discovered rather than configured. A note names its own token — it is bound into the
  /// commitment and published as an indexed field on {Transact} — so the set of assets someone
  /// holds is a fact about their notes, not something an app has to be told. Anyone can send
  /// this alias any ERC-20, and a client that only knows about a curated list would show a
  /// balance of zero while the money sat there unspendable.
  ///
  /// Costs nothing extra: the notes are already decrypted by the time this is reachable, so
  /// this walks memory. Only the symbol and decimals are read from chain, once per token.
  ///
  /// ETH is always included even at zero, because it is the asset every deployment holds and
  /// an empty list reads as "something is broken" rather than "you have not been paid yet".
  async heldTokens(): Promise<BalanceResult[]> {
    this.ensureInit();
    await this.ensureSync();

    const seen = new Set<bigint>([ETH_TOKEN_ADDRESS]);
    for (const e of this.myEntries) {
      if (e.amount > 0n) seen.add(e.tokenAddress);
    }

    const out: BalanceResult[] = [];
    for (const t of seen) {
      // A token whose contract will not answer `decimals()` cannot be denominated, and
      // guessing 18 would misreport the balance rather than omit it. Skipped, and skipped
      // loudly enough to find: ETH can never take this path.
      try {
        out.push(await this.balance(t));
      } catch {
        if (t === ETH_TOKEN_ADDRESS) throw new Error("ETH balance could not be read");
      }
    }
    // ETH first, then by what is held — the assets someone actually has, before the ones they
    // merely could have.
    return out.sort((a, b) =>
      a.token.address === ETH_TOKEN_ADDRESS ? -1
      : b.token.address === ETH_TOKEN_ADDRESS ? 1
      : b.total > a.total ? 1 : b.total < a.total ? -1 : 0);
  }

  // The aliasHash this account's spending key is registered under, or null if it has
  // never registered. A name cannot be recovered from it — aliasHash is a keccak — so a
  // caller that wants to display the name must remember what it registered.
  async myAliasHash(): Promise<bigint | null> {
    this.ensureInit();
    await this.ensureSync();
    return this.aliasHashByPubkey.get(this.keys!.spendingCommitment) ?? null;
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
  /// deriving candidates and matching against the `spendingCommitment` the registry published
  /// at registration, which means a wallet alone is enough to restore everything. An alias
  /// whose index is not found within `maxIndex` comes back as `null`: it is still owned and
  /// still visible, but this wallet cannot currently spend from it.
  ///
  /// Static because it enumerates identities rather than acting as one — a client is bound
  /// to a single alias.
  /// Every alias this root can act as, whether or not the connected address owns the name.
  ///
  /// Enumerated by key, not by ownership. Listing what `ownerOf` says the connected wallet
  /// holds would tie the answer to one EOA, so switching accounts would hide aliases you can
  /// still spend from. Ownership and spending are separate powers:
  /// only updateAliasData, offerAlias and cancelOffer check the NFT, while the pool checks
  /// nullifiers, roots and a proof that your spending key is the one registered here.
  ///
  /// So the question this answers is "which aliases do these keys control", which is what a
  /// wallet list is for. `owner` is reported alongside so a caller can tell that the *name* is
  /// held elsewhere and disable the three operations that need it.
  ///
  /// An alias that has been handed over does not appear: the registry holds the new owner's
  /// key, so nothing here matches it. Nor does one merely offered and not yet accepted.
  static async discoverAliases(
    config: HaliasConfig,
    maxIndex: number = 32,
    root?: bigint,
  ): Promise<{
    aliasHash: string; slot: number; name: string | null;
    index: number | null; owner: string | null; root: bigint;
  }[]> {
    // Pass `root` on any call after the first. Without it every enumeration re-stretches the
    // phrase, and enumeration happens after each registration.
    const probe = new Halias(config);
    await probe.init(0, root);
    await probe.ensureSync();
    const derived = probe.derivationRoot;

    const found: {
      aliasHash: string; slot: number; name: string | null;
      index: number | null; owner: string | null; root: bigint;
    }[] = [];

    for (let i = 0; i < maxIndex; i++) {
      // Derived from the root the probe already obtained, so this loop costs nothing beyond
      // hashing — deriving per index from a seed source would re-run PBKDF2 `maxIndex` times.
      const spendingCommitment = deriveKeysFromRoot(derived, i).spendingCommitment;
      const aliasHash = probe.aliasHashByPubkey.get(spendingCommitment);
      if (aliasHash === undefined) continue;

      const h = "0x" + aliasHash.toString(16).padStart(64, "0");
      const entry = probe.registryEntries.find(
        (e) => e.aliasHash.toLowerCase() === h.toLowerCase(),
      );
      let owner: string | null = null;
      try { owner = await probe.domain.ownerOf(aliasHash) as string; } catch { /* burned */ }

      found.push({
        aliasHash: entry?.aliasHash ?? h,
        slot: entry?.registrySlot ?? 0,
        name: probe.namesByAlias.get(entry?.aliasHash ?? h) ?? null,
        index: i,
        owner,
        root: derived,
      });
    }
    return found;
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

  /// Aliases these keys control.
  ///
  /// Matched by spending commitment against the registry, not by asking who holds the NFT. Since
  /// the owner is derived from the phrase and never transacts, "who owns it" is no longer a
  /// question the connected wallet can answer — and it was never the question a wallet list
  /// wanted. Ownership travels alongside for the three operations that need it.
  async myAliases(): Promise<
    { aliasHash: string; slot: number; name: string | null; owner: string | null }[]
  > {
    this.ensureInit();
    await this.ensureSync();
    const hash = this.aliasHashByPubkey.get(this.keys!.spendingCommitment);
    if (hash === undefined) return [];

    const h = "0x" + hash.toString(16).padStart(64, "0");
    const entry = this.registryEntries.find(
      (e) => e.aliasHash.toLowerCase() === h.toLowerCase(),
    );
    let owner: string | null = null;
    try { owner = await this.domain.ownerOf(hash) as string; } catch { /* burned */ }

    return [{
      aliasHash: entry?.aliasHash ?? h,
      slot: entry?.registrySlot ?? 0,
      name: this.namesByAlias.get(entry?.aliasHash ?? h) ?? null,
      owner,
    }];
  }

  async lookup(alias: string): Promise<LookupResult> {
    this.ensureInit();
    const cleanAlias = normalizeAlias(alias);
    const aliasHash = this.aliasHashOf(alias);

    // From the scan first, and the reason is privacy rather than latency.
    //
    // `aliases(aliasHash)` is a targeted read: it tells whatever node answers which alias this
    // client is interested in, and since names are published at registration the hash reverses
    // trivially. On the send path that is the recipient of a payment which publishes nothing —
    // the one call that undoes what the rest of this is for.
    //
    // Nothing has to be fetched to avoid it. Every field of a registration is carried by
    // AliasRegistered, which this client already scans in bulk into `registryEntries`, so the
    // answer is usually sitting in memory. See docs/rpc-surface.md.
    await this.ensureSync();
    const known = this.registryEntries.find(
      (e) => BigInt(e.aliasHash) === aliasHash && e.nullifierKeyHash !== 0n,
    );
    if (known) {
      return {
        spendingCommitment: known.spendingCommitment,
        nullifierKeyHash:   known.nullifierKeyHash,
        encryptionPubkey:   known.encryptionPubkey,
        dataHash:           known.dataHash,
      };
    }

    // Not in the scan: registered after this client's cursor, or read from a cache written
    // before the event carried `nullifierKeyHash`.
    //
    // Asked for by group rather than by name. The old fallback called `aliases(aliasHash)`,
    // which is the targeted read the paragraph above exists to avoid — rare, but rarity is
    // not privacy, and the case it fires in is a freshly registered recipient, which is
    // exactly when someone is about to be paid. The group is 12 bits of the hash, so the
    // node learns one of 4096 buckets and nothing about which member was wanted.
    const group = await getAliasesByPrefix(this.registry, aliasPrefix(aliasHash));
    const hit = group.find((e) => e.aliasHash === aliasHash);
    const r = hit ?? { spendingCommitment: 0n, nullifierKeyHash: 0n, encryptionPubkey: 0n, dataHash: 0n };
    if (r.spendingCommitment === 0n) throw new Error(`"${cleanAlias}.hls" is not registered`);
    return {
      spendingCommitment:   r.spendingCommitment,
      nullifierKeyHash: r.nullifierKeyHash,
      encryptionPubkey: ethers.getBytes(ethers.toBeHex(r.encryptionPubkey, 32)),
      dataHash:         r.dataHash,
    };
  }

  // There is no `updateKeys`. It rotated the nullifier and encryption keys but never the
  // spending commitment, so the one compromise that loses funds was the one it could not answer.
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
    const auth = await this.ownerSigner(aliasHash);
    const signed = await contractSignOfferAlias(this.domain, aliasHash, to, auth.signer,
                                                { nonce: auth.nonce });
    return { txHash: await this.settle(await signed.submit(this.config.signer, await this.nextNonce())) };
  }

  async cancelOffer(alias: string): Promise<{ txHash: string }> {
    this.ensureInit();
    this.ensureSpendable();
    const auth = await this.ownerSigner(this.aliasHashOf(alias));
    const signed = await contractSignCancelOffer(
      this.domain, this.aliasHashOf(alias), auth.signer, { nonce: auth.nonce });
    return { txHash: await this.settle(await signed.submit(this.config.signer, await this.nextNonce())) };
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
    const accepting = await this.acceptingSigner(aliasHash);
    const accepted = await contractAcceptAlias(
      this.domain,
      aliasHash,
      {
        spendingCommitment:   keys.spendingCommitment,
        nullifierKeyHash: this.myNullifierKeyHash(),
        encryptionPubkey: BigInt(ethers.hexlify(keys.encryption.publicKey)),
      },
      accepting.signer,
      { deadlineSeconds: opts.deadlineSeconds, nonce: accepting.nonce },
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
    const auth = await this.ownerSigner(this.aliasHashOf(alias));
    const signed = await contractSignUpdateAliasData(
      this.domain, this.aliasHashOf(alias), newDataHash, auth.signer, { nonce: auth.nonce });
    return { txHash: await this.settle(await signed.submit(this.config.signer, await this.nextNonce())) };
  }

  /// Whichever key the offer on `aliasHash` was actually made to.
  ///
  /// An offer names an address, and the acceptance has to be signed by that address — so this
  /// picks between the derived owner key for this index and the connected wallet by asking
  /// the contract which one is pending, rather than assuming.
  private async acceptingSigner(aliasHash: bigint): Promise<{ signer: ethers.Signer; nonce: bigint }> {
    const [, pendingRaw, nonce] = await this.aliasAuth(aliasHash);
    const pending = pendingRaw.toLowerCase();
    const wallet = (await this.config.signer.getAddress()).toLowerCase();

    // Only an offer naming the connected wallet needs that wallet to sign; everything else
    // is signed by this index's derived owner key, which is what an offer to "you" names.
    //
    // Deliberately does not refuse when nothing is pending. Preparing a signature is an
    // offline act and legitimately outlives the offer it was written against — that is how a
    // cancellation is enforced, at redemption rather than at signing, and refusing here would
    // hide the case instead of testing it.
    if (pending === wallet) return { signer: this.config.signer, nonce };
    return { signer: new ethers.Wallet(this.keys!.owner.privateKey, this.config.provider), nonce };
  }

  /// Who must sign for this alias, and with what nonce — one call rather than three.
  private async aliasAuth(aliasHash: bigint): Promise<[string, string, bigint]> {
    const r = await this.domain.aliasAuth(ethers.toBeHex(aliasHash, 32));
    return [r[0] as string, r[1] as string, r[2] as bigint];
  }

  /// The address an offer should name for this client to be able to accept it.
  ///
  /// The derived owner of this alias index — so handing an alias to a different index of the
  /// same phrase, which is how keys are rotated, names an address that changes with the index.
  get ownerAddress(): string {
    this.ensureInit();
    return this.keys!.owner.address;
  }

  /// Whichever key can authorise an owner action on `aliasHash`.
  ///
  /// Normally the derived one: it is what registration names, it holds no ETH, and it only
  /// ever signs — the connected wallet submits and pays, which is why the name is not tied to
  /// whichever wallet that happens to be.
  ///
  /// But an alias can be handed to any address, including an ordinary EOA, so the derived key
  /// is not the owner by assumption. Resolved against the chain, falling back to the connected
  /// wallet when that is the holder, and refusing outright when neither is — which is a far
  /// better answer than a signature that recovers to nobody and reverts as NotSignedByAuthority.
  private async ownerSigner(aliasHash: bigint): Promise<{ signer: ethers.Signer; nonce: bigint }> {
    const [ownerRaw, , nonce] = await this.aliasAuth(aliasHash);
    const owner = ownerRaw.toLowerCase();
    if (owner === ethers.ZeroAddress) throw new Error("That alias is not registered");

    if (owner === this.keys!.owner.address.toLowerCase()) {
      return { signer: new ethers.Wallet(this.keys!.owner.privateKey, this.config.provider), nonce };
    }
    const wallet = (await this.config.signer.getAddress()).toLowerCase();
    if (owner === wallet) return { signer: this.config.signer, nonce };
    throw new Error(
      `This alias is owned by ${owner}, which is neither its derived owner key nor the ` +
      `connected wallet — nothing here can authorise the change`,
    );
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
    // Per token, not per note. Each note names its own token and a sweep has to honour
    // that — withdrawing on the default would move an ERC-20 note as if it were ETH, the
    // wrong asset and the wrong scale once the token is not 18 decimals.
    //
    // Per NOTE was the earlier shape and it is now wasteful: a transaction spends
    // POOL_INPUTS notes, so a four-note wallet emptied in four withdrawals where one moves
    // the lot. It still terminated, because `selectEntries` reads live state and value is
    // conserved, but it paid for four proofs and four transactions to do it.
    const byToken = new Map<bigint, bigint>();
    for (const e of unspent) {
      byToken.set(e.tokenAddress, (byToken.get(e.tokenAddress) ?? 0n) + e.amount);
    }

    for (const [token] of byToken) {
      await this.tokenInfo(token);
      // Drain in whatever one transaction can move. `sendableNow` is re-read each round
      // because a withdrawal leaves change, so the reachable amount changes as this runs.
      // Guarded on progress rather than on a count: if a round moves nothing the balance
      // cannot be reached at all, and looping again would only repeat that.
      for (;;) {
        const bal = await this.balance(token);
        const chunk = bal.sendableNow < bal.total ? bal.sendableNow : bal.total;
        if (chunk === 0n) break;
        const result = await this.withdraw(
          recipientAddress, this.formatAmount(chunk, token), token,
        );
        sweepTxHashes.push(result.txHash);
      }
    }

    // The nonce is ethers' to resolve, not this function's to carry forward from the sweep.
    // Signing the offer reads the owner and the alias nonce first, and that round trip is
    // enough for the provider's view of the pending nonce to catch up — a hard-coded one is
    // worse than none once anything else can land in between.
    const auth = await this.ownerSigner(this.aliasHashOf(alias));
    const signed = await contractSignOfferAlias(
      this.domain, this.aliasHashOf(alias), newOwner, auth.signer, { nonce: auth.nonce });
    const tx = await signed.submit(this.config.signer, await this.nextNonce());
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
  async createInvite(
    amountEth: string,
    /// Which of the four phases is in flight. Creating an invite is three transactions and a
    /// proof, and the longest wait — fetching a 39MB proving key and generating against it —
    /// prompts for nothing while it runs. Without this the whole minute is one "Working…",
    /// which is indistinguishable from a hang.
    onStep?: (step: "commit" | "waiting" | "register" | "proving" | "funding") => void,
  ): Promise<InviteResult> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const amount = ethers.parseEther(amountEth);

    // Derived from this wallet's root, not random. A random secret exists only in the value
    // this function returns: close the window without saving it and the note is stranded
    // forever, on the one flow whose entire purpose is funding someone who has nothing. From
    // the root it can be recomputed on any device holding the phrase, which is what makes
    // {listInvites} and {reclaimInvite} possible at all.
    //
    // The index is the first whose invite alias is unregistered. Registration is the record —
    // there is no separate ledger to keep in step, and an invite created on another device
    // shows up here because the chain already knows about it.
    const index  = await this.nextInviteIndex();
    const secret = inviteSecretAt(this.derivationRoot, index);
    const temp   = deriveInviteKeys(secret);

    // The invite account needs a registry entry — its note is a non-zero output, and those
    // must prove membership — so it needs a name like any other alias.
    //
    // Derived from the secret rather than random, and through a hash rather than directly:
    // deterministic means the claimer recomputes it instead of being sent it, and hashing
    // means publishing the name does not publish the secret that spends the note.
    //
    // What stops someone registering the name first is the derivation, not the prefix. The
    // name carries 64 bits of keccak(secret), so squatting a *particular* invite means
    // guessing them — and the inviter registers it in the same flow that generates the
    // secret, so there is no window in which anyone else could know it.
    //
    // The prefix is a label, not a namespace: `invite-…` is a perfectly valid user alias
    // (hyphens are allowed), and nothing here treats the prefix as meaningful. Anyone may
    // register one; they simply cannot register *this* one.
    // 128 bits of it, not 64. The old width was a birthday bound: two invites collide with
    // even odds at around 2^32 of them, and the loser's registration reverts as taken. It
    // failed safely, but only because it failed loudly. At 128 bits the bound is 2^64, which
    // is past anything this will ever see, and the label still fits the 63-character
    // convention the rest of the namespace keeps — the whole hash would not.
    const inviteName = `invite-${ethers.keccak256(ethers.toBeHex(secret, 32)).slice(2, 34)}.hls`;
    const tempAliasHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(inviteName)));
    const registrationFee = await this.domain.registrationFee() as bigint;

    // One transaction, not three.
    //
    // Registering the invite alias and funding it are the same call: `domain.claim` records a
    // registration and runs a pool transaction inside it, which is exactly what redeeming an
    // invite already does. Creating one is the same shape with different ownership — insert an
    // alias, address a note to it — so it needs no new contract surface and no new armed path.
    //
    // What that buys, beyond two fewer wallet prompts and the block a reveal has to wait for:
    // it is atomic. There is no longer a state where the alias is registered and the note is
    // not, so the half-built invite that OPEN-ITEMS #5 describes cannot occur.
    //
    // It also makes creating and redeeming indistinguishable on chain. Both are `claim` with a
    // registration and an outflow of exactly the registration fee; nothing separates the two.
    const keys                 = this.keys!;
    const selfNullifierKeyHash = this.myNullifierKeyHash();

    // The fee comes out of the notes now, because the pool has to be the one paying it — the
    // domain measures what it received and refuses anything but `registrationFee`. That is
    // better for the wallet, not worse: paying from the EOA meant that address publicly sent
    // the fee to the controller, tying it to a registration. Now it only pays gas.
    const spend  = this.selectEntries(amount + registrationFee, ETH_TOKEN_ADDRESS);
    const inputs = this.buildInputs(spend);

    // Where the invite's leaf will go, and the witness for it.
    //
    // `nextAliasSlot` is unassigned — nobody holds it — and getSmtSiblings answers for an empty
    // slot as it does for a full one. Those siblings prove the slot is empty against the
    // current root, and the circuit derives the tree that results from filling it. Nothing is
    // predicted, so an unrelated registration landing in between cannot invalidate this.
    const inviteSlot      = Number(await this.registry.nextAliasSlot() as bigint);
    const inviteSmtKey    = aliasHashToSmtKey(tempAliasHash);
    const inviteLeafValue = poseidonHash([temp.spendingCommitment, temp.nullifierKeyHash, 0n]);
    const pendingLeaf     = poseidonHash([inviteSmtKey, inviteLeafValue, 1n]);

    const blockTag = await this.headBlock();
    const [pendingSiblingsRaw, registryRootRaw] = await Promise.all([
      this.registry.getSmtSiblings(inviteSlot, { blockTag }) as Promise<string[]>,
      this.registry.getRegistryRoot({ blockTag }) as Promise<string>,
    ]);
    const pendingSiblings = pendingSiblingsRaw.map(BigInt);
    const registryRoot    = BigInt(registryRootRaw);

    // The change goes to this alias, which is already registered — and that is what makes this
    // harder than a redemption. A claim's only real output sits at the very slot being
    // inserted, so its siblings are the pending ones. Here the change sits somewhere else in
    // the tree, and every output is checked against the root *including* the insertion
    // (transactCore: "Against effectiveRoot, not registryRoot"). Inserting a leaf moves the
    // sibling path of anything sharing an ancestor with it, so the change's witness has to come
    // from the tree as it will be, not as it is.
    //
    // Derived from the local mirror, and only after that mirror is shown to reproduce the root
    // the chain just reported. Siblings from a stale tree against a fresh root is the failure
    // that produces a proof verifying against nothing, with no error to say why.
    const selfProof = await this.selfRegistryProof();
    if (selfProof.registryRoot !== registryRoot || this.registrySMT.root !== registryRoot) {
      throw new Error(
        "Registry mirror is behind the chain — refresh and try again",
      );
    }
    const afterInsert = this.registrySMT.clone();
    afterInsert.update(inviteSlot, inviteSmtKey, inviteLeafValue);
    const changeSiblings = afterInsert.getSiblings(selfProof.registrySlot);

    // The blinding is `temp.blinding`, not random: the claimer recomputes it from the secret
    // to find and spend this note. A random one would strand the funds.
    const changeBlinding = randomBlinding();
    const changeAmount   = inputs.total - amount - registrationFee;

    const inviteEntry = buildEntry(temp.spendingCommitment, temp.nullifierKeyHash, temp.blinding, amount, ETH_TOKEN_ADDRESS);
    const changeEntry = buildEntry(keys.spendingCommitment, selfNullifierKeyHash, changeBlinding, changeAmount, ETH_TOKEN_ADDRESS);

    // Encrypted to the temp key derived from the secret, so holding the secret is
    // sufficient to discover and decrypt the note — nothing else is transmitted.
    const inviteBlob = this.sealNote(temp.blinding, amount, temp.encryption.publicKey);
    const changeBlob = this.sealNote(changeBlinding, changeAmount);

    // Not shuffled, unlike a send. Order here matches what a redemption produces, and matching
    // it is the point: two flows that lay their outputs out differently are two flows an
    // observer can tell apart.
    const inviteOut: TransactOutput = {
      spendingCommitment: temp.spendingCommitment, nullifierKeyHash: temp.nullifierKeyHash,
      registrySlot: inviteSlot, blinding: temp.blinding, amount,
      aliasHash: inviteSmtKey, dataHash: 0n, registrySiblings: pendingSiblings,
    };
    const changeOut: TransactOutput = {
      spendingCommitment: keys.spendingCommitment, nullifierKeyHash: selfNullifierKeyHash,
      registrySlot: selfProof.registrySlot, blinding: changeBlinding, amount: changeAmount,
      aliasHash: selfProof.aliasHash, dataHash: selfProof.dataHash,
      registrySiblings: changeSiblings,
    };

    // The registration the proof authorises. Hashing it into externalData is what stops a
    // submitter minting the alias to itself — the domain recomputes it from its own arguments
    // and refuses anything that does not match.
    const registration = {
      owner:            temp.ownerAddress,
      aliasHash:        tempAliasHash,
      spendingCommitment:   temp.spendingCommitment,
      nullifierKeyHash: temp.nullifierKeyHash,
      encryptionPubkey: temp.encryptionPubkeyField,
    };
    const params: TransactParams = {
      recipient:    this.config.controllerAddress,
      relayerFee:   NO_RELAYER,
      externalData: encodeRegistration(registration),
    };

    // Negative by exactly the fee: the pool pays the domain, which measures what arrived and
    // rejects anything else.
    const publicAmount = FIELD_PRIME - registrationFee;
    const paramsHash   = computeParamsHash(params, inviteBlob, changeBlob, BigInt(this.config.chainId), this.config.poolAddress);

    // The long one. The first call fetches the proving key before it can even start, and this
    // is the claim circuit rather than the ordinary one.
    onStep?.("proving");
    const { proofBytes } = await proveTransact({
      poolRoot: inputs.poolRoots, treeNumber: inputs.treeNumbers,
      registryRoot, publicAmount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   inputs.nullifiers,
      outputCommitments: [inviteEntry.commitment, changeEntry.commitment],
      inputs:            inputs.inputs,
      outputs: [inviteOut, changeOut],
      pending: { leaf: pendingLeaf, slot: inviteSlot, siblings: pendingSiblings },
    }, this.getArtifacts());

    onStep?.("funding");
    const tx = await contractClaim(
      this.domain, registration,
      inputs.poolRoots, inputs.treeNumbers, registryRoot, publicAmount,
      inputs.nullifiers, [inviteEntry.commitment, changeEntry.commitment],
      params, inviteBlob, changeBlob, proofBytes, inviteName, pendingLeaf,
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
    // So the claimer's own alias has to be in the tree the proof checks against, and it is not
    // registered yet. Predicting the post-registration root is the obvious answer and the wrong
    // one: any other registry write landing in between invalidates the claim (F1) — cheap to
    // trigger on purpose, and worst on the onboarding path.
    //
    // Nothing is predicted. The proof carries the insertion: it proves against the
    // CURRENT root, shows the target slot is empty there, and derives the tree that results
    // from adding this leaf. Whatever else lands afterwards, that root stays valid for the
    // freshness window, and the derivation is unaffected by it.
    const ownSlot     = Number(await this.registry.nextAliasSlot() as bigint);
    const leafValue   = poseidonHash([keys.spendingCommitment, nullifierKeyHash, 0n]);
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
      ? { spendingCommitment: keys.spendingCommitment, nullifierKeyHash, blinding: changeBlind, amount: changeAmount,
          aliasHash: smtKey, registrySlot: ownSlot, dataHash: 0n,
          registrySiblings: pendingSiblings }
      : dummyOutput(randomBlinding());
    const comm0 = poseidonHash([changeOut.spendingCommitment, changeOut.nullifierKeyHash, changeOut.blinding, changeOut.amount, ETH_TOKEN_ADDRESS]);

    // Encrypt the change to the claimer's own key.
    //
    // Both ciphertexts must be real. Passing "0x" loses the remainder permanently: the
    // commitment lands in the pool but there is no blob to decrypt, so findMyOutputs can never
    // see it, and the blinding is generated here and never persisted. The note would be
    // unspendable by anyone, including its owner — on the flow whose entire purpose is
    // onboarding someone with no funds.
    const changeBlob = changeAmount > 0n
      ? (() => {
          return this.sealNote(changeBlind, changeAmount);
        })()
      : "0x";

    const { out: out1, commitment: comm1 } = this.filler(ETH_TOKEN_ADDRESS);

    const anchor    = this.poolAnchor(note.treeNumber);
    const poolProof = this.poolTrees.tree(note.treeNumber).getProof(note.leafIndex);
    const nullifier0 = computeNullifier(temp.nullifierKey, note.treeNumber, note.leafIndex);
    const pad = this.padInputs([{
      input: {
        spendingPrivKey: temp.spendingPrivKey, viewingPrivKey: temp.viewingPrivKey,
        blinding: note.blinding, amount: note.amount,
        pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements,
      },
      nullifier: nullifier0, root: anchor.root, tree: note.treeNumber,
    }], anchor);

    // The registration the proof authorises. Hashing it into externalData is what stops a
    // relayer minting the alias to itself: the domain recomputes this from its own
    // arguments and refuses anything that does not match, and the hash is inside
    // paramsHash, so a submitter cannot alter it without invalidating the proof.
    const registration = {
      owner:            await this.config.signer.getAddress(),
      aliasHash,
      spendingCommitment:   keys.spendingCommitment,
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
      poolRoot: pad.poolRoot, treeNumber: pad.treeNumber, registryRoot, publicAmount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   pad.inputNullifiers,
      outputCommitments: [comm0, comm1],
      inputs: pad.inputs,
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
            pad.poolRoot, pad.treeNumber, registryRoot, publicAmount, ETH_TOKEN_ADDRESS,
            pad.inputNullifiers, [comm0, comm1], params, pendingLeaf,
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
      pad.poolRoot, pad.treeNumber, registryRoot, publicAmount,
      pad.inputNullifiers,
      [comm0, comm1],
      params, changeBlob, "0x", proofBytes, `${cleanAlias}.hls`, pendingLeaf,
    );
    return { txHash: await this.settle(tx) };
  }

  // Locate the unspent pool note belonging to an invite's temp keypair. The note is a
  // perfectly ordinary output encrypted to the temp encryption key, so the normal
  // decrypt-and-match path finds it — no special-case scanning.
  /// The name an invite registers, which is a pure function of its secret.
  private inviteNameFor(secret: bigint): string {
    return `invite-${ethers.keccak256(ethers.toBeHex(secret, 32)).slice(2, 34)}.hls`;
  }

  /// The registry key for an invite's name.
  ///
  /// Hashed directly rather than through {aliasHashOf}, which normalises first and rejects the
  /// hyphen: user aliases are alphanumeric, and `invite-…` is deliberately outside that set so
  /// nobody can type one by hand. The registration hashes the raw string, so this must too —
  /// anything else looks up a name that was never written.
  private inviteAliasHash(name: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(name));
  }

  /// The first invite index this wallet has not used.
  ///
  /// Read off the chain rather than from local state. The invite's alias registration *is* the
  /// record, so an invite created from another device — or before this browser's cache was
  /// cleared — is already accounted for, and two devices cannot pick the same index.
  private async nextInviteIndex(limit = 256): Promise<number> {
    for (let i = 0; i < limit; i++) {
      const name = this.inviteNameFor(inviteSecretAt(this.derivationRoot, i));
      const taken = await this.registry.isRegistered(this.inviteAliasHash(name)) as boolean;
      if (!taken) return i;
    }
    throw new Error(`No free invite index below ${limit}`);
  }

  /// Every invite this wallet has created, and whether it is still claimable.
  ///
  /// Enumerable because the secrets are derived rather than random — see {inviteSecretAt}.
  /// Walks indices until it finds `gap` consecutive unregistered ones, which tolerates a
  /// registration that reverted mid-flow without scanning to the limit every time.
  ///
  /// `claimable` is the question worth asking: an invite whose note has been spent is done,
  /// whoever spent it. It says nothing about *who* claimed it, because nothing on chain does —
  /// the claimer's change note is addressed to their own alias and is indistinguishable from
  /// any other output.
  async listInvites(opts: { limit?: number; gap?: number } = {}): Promise<InviteSummary[]> {
    this.ensureInit();
    await this.ensureSync();

    const limit = opts.limit ?? 256;
    const gap   = opts.gap ?? 3;
    const out: InviteSummary[] = [];
    let missed = 0;

    for (let i = 0; i < limit && missed < gap; i++) {
      const secret = inviteSecretAt(this.derivationRoot, i);
      const name   = this.inviteNameFor(secret);
      if (!(await this.registry.isRegistered(this.inviteAliasHash(name)) as boolean)) {
        missed++;
        continue;
      }
      missed = 0;

      const temp = deriveInviteKeys(secret);
      const note = await this.findInviteNote(temp);
      out.push({
        index: i,
        secret,
        inviteCode: encodeInviteCode(secret),
        name,
        // Null once spent: the note is gone, so there is no amount left to report.
        amount: note?.amount ?? null,
        claimable: note !== null,
      });
    }
    return out;
  }

  /// Take back an unclaimed invite, returning its funds to this alias.
  ///
  /// A transfer whose input is the invite note and whose output is this client's own note.
  /// The invite's spending key comes from the secret, which this wallet can recompute — so
  /// this needs nothing that was written down at the time.
  ///
  /// Racy by nature and safely so: if the recipient claims between the proof and its
  /// inclusion, the nullifier is already spent and the pool refuses this. Nobody loses
  /// anything but the gas.
  async reclaimInvite(index: number): Promise<{ txHash: string; amount: bigint }> {
    this.ensureInit();
    this.ensureSpendable();
    await this.ensureSync();

    const secret = inviteSecretAt(this.derivationRoot, index);
    const temp   = deriveInviteKeys(secret);
    const note   = await this.findInviteNote(temp);
    if (!note) throw new Error(`Invite ${index} has already been claimed, or was never created`);

    const keys             = this.keys!;
    const nullifierKeyHash = this.myNullifierKeyHash();
    const selfProof        = await this.selfRegistryProof();

    // One real input — the invite's — padded out to the circuit's width.
    const anchor    = this.poolAnchor(note.treeNumber);
    const poolProof = this.poolTrees.tree(note.treeNumber).getProof(note.leafIndex);
    const nullifier0 = computeNullifier(temp.nullifierKey, note.treeNumber, note.leafIndex);
    const pad = this.padInputs([{
      input: {
        spendingPrivKey: temp.spendingPrivKey, viewingPrivKey: temp.viewingPrivKey,
        blinding: note.blinding, amount: note.amount,
        pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements,
      },
      nullifier: nullifier0, root: anchor.root, tree: note.treeNumber,
    }], anchor);

    const blinding = randomBlinding();
    const out0 = {
      spendingCommitment: keys.spendingCommitment,
      nullifierKeyHash,
      blinding,
      amount:         note.amount,
      aliasHash:      selfProof.aliasHash,
      registrySlot:   selfProof.registrySlot,
      dataHash:       selfProof.dataHash,
      registrySiblings: selfProof.siblings,
    };
    const comm0 = poseidonHash([
      out0.spendingCommitment, out0.nullifierKeyHash, out0.blinding, out0.amount, ETH_TOKEN_ADDRESS,
    ]);
    const blob0 = this.sealNote(blinding, note.amount);
    const { out: out1, commitment: comm1 } = this.filler(ETH_TOKEN_ADDRESS);

    const params: TransactParams = {
      recipient:    ethers.ZeroAddress,
      relayerFee:   NO_RELAYER,
      externalData: ethers.ZeroHash,
    };
    const paramsHash = computeParamsHash(
      params, blob0, "0x", BigInt(this.config.chainId), this.config.poolAddress,
    );

    const { proofBytes } = await proveTransact({
      poolRoot: pad.poolRoot, treeNumber: pad.treeNumber,
      registryRoot: selfProof.registryRoot, publicAmount: 0n,
      tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   pad.inputNullifiers,
      outputCommitments: [comm0, comm1],
      inputs: pad.inputs,
      outputs: [out0, out1],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.pool,
      pad.poolRoot, pad.treeNumber,
      selfProof.registryRoot, 0n, ETH_TOKEN_ADDRESS,
      pad.inputNullifiers,
      [comm0, comm1], params, blob0, "0x", proofBytes,
    );
    return { txHash: await this.settle(tx), amount: note.amount };
  }

  /// Every output ever addressed to an invite's keys, spent or not.
  ///
  /// Split out from {findInviteNote} because "no unspent note" has two causes that need
  /// telling apart: an invite that was claimed, and one that was registered but never funded.
  /// The first is finished, the second is a half-built invite waiting to be resumed.
  private async ownedInviteOutputs(temp: InviteKeys): Promise<OwnedEntry[]> {
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
    return findMyOutputs(
      this.allOutputs, temp.spendingCommitment, temp.nullifierKey, temp.encryption.privateKey,
    );
  }

  private async findInviteNote(temp: InviteKeys): Promise<OwnedEntry | null> {
    const owned = await this.ownedInviteOutputs(temp);
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
    await this.tokenInfo(tokenAddress);
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
    const selfAlias = this.aliasHashByPubkey.get(keys.spendingCommitment);
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
    await this.tokenInfo(tokenAddress);

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
    await this.tokenInfo(tokenAddress);
    return this.myEntries
      .filter(e => e.tokenAddress === tokenAddress)
      .map(e => ({
        ...e,
        spent: this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.treeNumber, e.leafIndex)),
      }));
  }
}
