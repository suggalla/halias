import { ethers } from "ethers";
import {
  init as initCrypto,
  deriveKeysFromWallet,
  poseidonHash,
  encryptOutput,
  encodeOutputBlob,
  HaliasKeys,
  Signer,
} from "./crypto";
import { buildEntry, computeNullifier, randomBlinding, OwnedEntry, ETH_TOKEN_ADDRESS } from "./entry";
import { MerkleTree } from "./merkle";
import { SMT, aliasHashToSmtKey } from "./smt";
import { proveTransact, dummyInput, dummyOutput, TransactOutput } from "./proof";
import { scanEvents, findMyOutputs, Output, RegistryEntry } from "./events";
import { deriveInviteKeys, packRelayerFee, InviteKeys, encodeInviteCode } from "./invite";
import {
  getContract,
  transact as contractTransact,
  register as contractRegister,
  updateKeys as contractUpdateKeys,
  updateAliasData as contractUpdateAliasData,
  transferAliasWithKeys as contractTransferAliasWithKeys,
  lookupAlias as contractLookupAlias,
  registerWithPoolNote as contractRegisterWithPoolNote,
  computeParamsHash,
  TransactParams,
  ZERO_TRANSACT_PARAMS,
} from "./contract";
import { CacheStore, serializeCache, deserializeCache } from "./cache";
import { randomBytes, toHex } from "./random";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POOL_LEVELS     = 32;
const REGISTRY_LEVELS = 32;

export interface HaliasConfig {
  provider: ethers.Provider;
  signer: ethers.Signer & Signer;
  chainId: number;
  contractAddress: string;
  artifacts: {
    transactWasm: string;
    transactZkey: string;
  };
  cache?: CacheStore;
  startBlock?: number;
  rpcChunkSize?: number;
  onProgress?: (pct: number) => void;
}

export interface DepositResult  { txHash: string; commitment: bigint; amount: bigint }
export interface SendResult     { txHash: string; commitment: bigint; amount: bigint }
export interface WithdrawResult { txHash: string; recipient: string; amount: bigint }
export interface BalanceResult  { total: bigint; entries: OwnedEntry[] }
export interface LookupResult   { spendingPubkey: bigint; nullifierKeyHash: bigint; encryptionPubkey: Uint8Array; dataHash: bigint }
// secret is the whole invite — anyone holding it can claim the note. Treat it like cash.
export interface InviteResult   { txHash: string; secret: bigint; inviteCode: string; amount: bigint }
export interface ScanEntry      extends OwnedEntry { spent: boolean }

export class Halias {
  private config: HaliasConfig;
  private contract: ethers.Contract;
  private keys: HaliasKeys | null = null;
  private poolTree: MerkleTree = new MerkleTree(POOL_LEVELS);
  private smt: SMT = new SMT();
  private aliasHashByPubkey = new Map<bigint, bigint>(); // spendingPubkey → aliasHash (bigint)
  private registryEntries: RegistryEntry[] = [];
  private myEntries: OwnedEntry[] = [];
  private allOutputs: Output[] = [];
  private spentNullifiers = new Set<bigint>();
  private nextDummyIdx = 0;
  private selfAliasHash: bigint | null = null;
  private lastBlock = 0;
  private synced = false;
  private initialized = false;

  constructor(config: HaliasConfig) {
    this.config = config;
    this.contract = getContract(config.contractAddress, config.signer);
  }

  async init(): Promise<void> {
    await initCrypto();
    this.keys = await deriveKeysFromWallet(this.config.signer);
    this.initialized = true;
  }

  private ensureInit() {
    if (!this.initialized) throw new Error("Call init() first");
  }

  private async ensureSync(): Promise<void> {
    if (this.synced) return;
    await this.loadCache();
    await this.refresh();
    this.synced = true;
  }

  private async loadCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = await this.config.cache.load(String(this.config.chainId));
    if (!raw) return;
    try {
      const d = deserializeCache(raw);
      this.poolTree = d.poolTree;
      this.smt = d.smt;
      this.registryEntries = d.registryEntries;
      this.aliasHashByPubkey = d.aliasHashByPubkey;
      this.spentNullifiers = d.spentNullifiers;
      this.lastBlock = d.lastBlock;
    } catch (e) {
      console.warn("Failed to load cache:", e);
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = serializeCache({
      poolTree: this.poolTree,
      smt: this.smt,
      registryEntries: this.registryEntries,
      aliasHashByPubkey: this.aliasHashByPubkey,
      spentNullifiers: this.spentNullifiers,
      lastBlock: this.lastBlock,
    });
    await this.config.cache.save(String(this.config.chainId), raw);
  }

  async refresh(): Promise<void> {
    this.ensureInit();
    // Always rescan from the deployment block rather than from lastBlock + 1.
    //
    // scanEvents rebuilds the registry SMT from the events it sees, and the assignments
    // below replace rather than merge, so an incremental scan would return a tree built
    // only from the new range and silently discard every earlier registration. Combined
    // with lastBlock jumping to head after the first scan, a freshly registered account
    // could not find itself — which is exactly what the live Sepolia run hit.
    //
    // Rescanning is correct but O(history); making scanEvents merge into an existing
    // tree, so the cache can warm-start an incremental scan, is the follow-up.
    const fromBlock = this.config.startBlock ?? 0;
    const result = await scanEvents(
      this.config.provider,
      this.config.contractAddress,
      fromBlock,
      this.config.rpcChunkSize,
      this.config.onProgress,
    );

    // Rebuilt from scratch, so start from an empty tree rather than appending to the
    // commitments already inserted by a previous refresh.
    this.poolTree = new MerkleTree(POOL_LEVELS);

    for (const out of result.outputs) {
      this.poolTree.insert(out.commitment);
    }

    // Update SMT
    this.smt = result.smt;
    this.registryEntries = result.registryEntries;
    this.aliasHashByPubkey = result.aliasHashByPubkey;

    this.spentNullifiers = new Set(result.spentNullifiers);

    this.lastBlock = await this.config.provider.getBlockNumber();

    // Find our own regular outputs
    const keys = this.keys!;
    this.myEntries = findMyOutputs(
      result.outputs,
      keys.spendingPubkey,
      keys.nullifierKey,
      keys.encryption.privateKey,
    );

    // Retained so an invite claimer can locate the note belonging to a derived keypair.
    // Assigned, not appended: refresh() rescans from the start, so appending would
    // duplicate every output on each call.
    this.allOutputs = result.outputs;

    await this.saveCache();
  }

  private consumeDummyIdx(count: number): number {
    const start = this.nextDummyIdx;
    this.nextDummyIdx += count;
    return start;
  }

  private getArtifacts(): { wasmPath: string; zkeyPath: string } {
    return {
      wasmPath: this.config.artifacts.transactWasm,
      zkeyPath: this.config.artifacts.transactZkey,
    };
  }

  // Identity and position are separate, matching the circuit: aliasHash is the
  // field-reduced key hashed into the leaf, registrySlot is the tree position the
  // contract assigned. aliasHash must be reduced — a raw 256-bit keccak is >= p about
  // 81% of the time and would not match the on-chain leaf.
  private selfSmtProof() {
    const pubkey = this.keys!.spendingPubkey;
    const aliasHash = this.aliasHashByPubkey.get(pubkey);
    if (aliasHash === undefined) throw new Error("Account not registered or not synced");
    const entry = this.registryEntries.find(e => BigInt(e.aliasHash) === aliasHash)!;
    return {
      aliasHash: aliasHashToSmtKey(aliasHash),
      registrySlot: entry.registrySlot,
      siblings: this.smt.getSiblings(entry.registrySlot),
      dataHash: entry.dataHash,
    };
  }

  private recipientSmtProof(pubkey: bigint) {
    const aliasHash = this.aliasHashByPubkey.get(pubkey);
    if (aliasHash === undefined) throw new Error("Recipient pubkey not found in registry");
    const entry = this.registryEntries.find(e => BigInt(e.aliasHash) === aliasHash)!;
    return {
      aliasHash: aliasHashToSmtKey(aliasHash),
      registrySlot: entry.registrySlot,
      siblings: this.smt.getSiblings(entry.registrySlot),
      dataHash: entry.dataHash,
    };
  }

  private selectEntry(amount: bigint, tokenAddress: bigint): OwnedEntry {
    const entry = this.myEntries.find(e =>
      e.amount >= amount &&
      e.tokenAddress === tokenAddress &&
      !this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.leafIndex))
    );
    if (!entry) throw new Error("Insufficient balance or no suitable UTXO found");
    return entry;
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  // publishName defaults on: without it the plaintext exists nowhere and a client that
  // loses local storage cannot recover the name. Pass false for an alias meant to be
  // unguessable — the hash is already public either way, so this only affects whether the
  // name can be read back rather than brute-forced.
  async register(alias: string, publishName: boolean = true): Promise<{ txHash: string }> {
    this.ensureInit();
    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash  = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));

    const spendingBytes32 = this.keys!.spendingPubkey;
    const encBytes32      = BigInt(ethers.hexlify(this.keys!.encryption.publicKey));

    const nullifierKeyHash = poseidonHash([this.keys!.nullifierKey, 1n]);
    const fee = await this.contract.registrationFee() as bigint;
    const tx = await contractRegister(
      this.contract, aliasHash, spendingBytes32, nullifierKeyHash, encBytes32,
      fee, publishName ? `${cleanAlias}.hls` : "",
    );
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash };
  }


  async deposit(amountEth: string, tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<DepositResult> {
    this.ensureInit();
    await this.ensureSync();

    const amount          = ethers.parseEther(amountEth);
    const keys            = this.keys!;
    const nullifierKeyHash = poseidonHash([keys.nullifierKey, 1n]);
    const blinding        = randomBlinding();
    const entry           = buildEntry(keys.spendingPubkey, nullifierKeyHash, blinding, amount, tokenAddress);
    const selfProof       = this.selfSmtProof();
    const dBase           = this.consumeDummyIdx(2);

    const { encrypted, viewTag } = encryptOutput(blinding, amount, keys.encryption.publicKey);
    const encryptedOutput0 = encodeOutputBlob(encrypted, viewTag);

    const out1 = dummyOutput(randomBlinding());
    const comm1 = poseidonHash([out1.pubkey, out1.nullifierKeyHash, out1.blinding, out1.amount, tokenAddress]);

    const paramsHash = computeParamsHash(ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", BigInt(this.config.chainId), this.config.contractAddress);
    const poolRoot     = this.poolTree.getRoot();
    const registryRoot = this.smt.root;

    const dummy0 = dummyInput(dBase, POOL_LEVELS);
    const dummy1 = dummyInput(dBase + 1, POOL_LEVELS);

    const { proofBytes } = await proveTransact({
      poolRoot, registryRoot, publicAmount: amount, tokenAddress, paramsHash,
      inputNullifiers:  [dummy0.nullifier, dummy1.nullifier],
      outputCommitments: [entry.commitment, comm1],
      inputs: [dummy0.input, dummy1.input],
      outputs: [
        {
          pubkey: keys.spendingPubkey,
          nullifierKeyHash,
          registrySlot:     selfProof.registrySlot,
          blinding,
          amount,
          aliasHash: selfProof.aliasHash,
          dataHash:  selfProof.dataHash,
          registrySiblings: selfProof.siblings,
        },
        out1,
      ],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.contract, poolRoot, registryRoot, amount, tokenAddress,
      [dummy0.nullifier, dummy1.nullifier],
      [entry.commitment, comm1],
      ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", proofBytes, amount,
    );
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash, commitment: entry.commitment, amount };
  }

  async send(
    recipientName: string,
    amountEth: string,
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
  ): Promise<SendResult> {
    this.ensureInit();
    await this.ensureSync();

    const sendAmount = ethers.parseEther(amountEth);
    const keys = this.keys!;
    const selfNullifierKeyHash = poseidonHash([keys.nullifierKey, 1n]);

    const recipient  = await this.lookup(recipientName);
    const entry      = this.selectEntry(sendAmount, tokenAddress);
    const nullifier  = computeNullifier(keys.nullifierKey, entry.leafIndex);
    const recProof   = this.recipientSmtProof(recipient.spendingPubkey);
    const selfProof  = this.selfSmtProof();

    const recipientBlinding = randomBlinding();
    const changeBlinding    = randomBlinding();
    const changeAmount = entry.amount - sendAmount;

    const recipientEntry = buildEntry(recipient.spendingPubkey, recipient.nullifierKeyHash, recipientBlinding, sendAmount, tokenAddress);
    const changeEntry    = buildEntry(keys.spendingPubkey, selfNullifierKeyHash, changeBlinding, changeAmount, tokenAddress);

    const recEncKey = recipient.encryptionPubkey;
    const { encrypted: recEnc, viewTag: recTag } = encryptOutput(recipientBlinding, sendAmount, recEncKey);
    const { encrypted: chgEnc, viewTag: chgTag } = encryptOutput(changeBlinding, changeAmount, keys.encryption.publicKey);

    const poolProof = this.poolTree.getProof(entry.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(dBase, POOL_LEVELS);

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
    const blob0 = flip ? encodeOutputBlob(chgEnc, chgTag) : encodeOutputBlob(recEnc, recTag);
    const blob1 = flip ? encodeOutputBlob(recEnc, recTag) : encodeOutputBlob(chgEnc, chgTag);

    const paramsHash  = computeParamsHash(ZERO_TRANSACT_PARAMS, blob0, blob1, BigInt(this.config.chainId), this.config.contractAddress);
    const poolRoot     = this.poolTree.getRoot();
    const registryRoot = this.smt.root;

    const { proofBytes } = await proveTransact({
      poolRoot, registryRoot, publicAmount: 0n, tokenAddress, paramsHash,
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

    const tx = await contractTransact(
      this.contract, poolRoot, registryRoot, 0n, tokenAddress,
      [nullifier, dummy.nullifier],
      [comm0, comm1],
      ZERO_TRANSACT_PARAMS, blob0, blob1, proofBytes,
    );
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash, commitment: recipientEntry.commitment, amount: sendAmount };
  }

  async withdraw(
    recipientAddress: string,
    amountEth: string,
    tokenAddress: bigint = ETH_TOKEN_ADDRESS,
    externalData: string = ethers.ZeroHash,
  ): Promise<WithdrawResult> {
    this.ensureInit();
    await this.ensureSync();

    const amount          = ethers.parseEther(amountEth);
    const keys            = this.keys!;
    const nullifierKeyHash = poseidonHash([keys.nullifierKey, 1n]);
    const entry           = this.selectEntry(amount, tokenAddress);
    const nullifier       = computeNullifier(keys.nullifierKey, entry.leafIndex);
    const changeAmount    = entry.amount - amount;

    const poolProof = this.poolTree.getProof(entry.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(dBase, POOL_LEVELS);

    let out0: TransactOutput;
    let comm0: bigint;
    let encBlob0 = "0x";

    if (changeAmount > 0n) {
      const changeBlinding = randomBlinding();
      const changeEntry    = buildEntry(keys.spendingPubkey, nullifierKeyHash, changeBlinding, changeAmount, tokenAddress);
      const selfProof      = this.selfSmtProof();
      const { encrypted: chgEnc, viewTag: chgTag } = encryptOutput(changeBlinding, changeAmount, keys.encryption.publicKey);
      encBlob0 = encodeOutputBlob(chgEnc, chgTag);
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

    const out1  = dummyOutput(randomBlinding());
    const comm1 = poseidonHash([out1.pubkey, out1.nullifierKeyHash, out1.blinding, out1.amount, tokenAddress]);

    const withdrawParams: TransactParams = { recipient: recipientAddress, externalData };
    const paramsHash  = computeParamsHash(withdrawParams, encBlob0, "0x", BigInt(this.config.chainId), this.config.contractAddress);
    const poolRoot     = this.poolTree.getRoot();
    const registryRoot = this.smt.root;
    const publicAmount = FIELD_PRIME - amount;

    const { proofBytes } = await proveTransact({
      poolRoot, registryRoot, publicAmount, tokenAddress, paramsHash,
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

    const tx = await contractTransact(
      this.contract, poolRoot, registryRoot, publicAmount, tokenAddress,
      [nullifier, dummy.nullifier],
      [comm0, comm1],
      withdrawParams, encBlob0, "0x", proofBytes,
    );
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash, recipient: recipientAddress, amount };
  }

  async balance(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<BalanceResult> {
    this.ensureInit();
    await this.ensureSync();
    const entries = this.myEntries.filter(e =>
      e.amount > 0n &&
      e.tokenAddress === tokenAddress &&
      !this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.leafIndex))
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
    return await this.contract.registrationFee() as bigint;
  }

  // Alias hashes this address owns, found by scanning registrations and checking the
  // ERC-721 owner. The contract does not implement ERC721Enumerable, so there is no
  // cheaper on-chain route — and the NAME cannot come back either, since aliasHash is a
  // keccak. A caller that wants to display names must remember what it registered.
  async myAliases(): Promise<{ aliasHash: string; slot: number }[]> {
    this.ensureInit();
    await this.ensureSync();
    const me = await this.config.signer.getAddress();
    const owned: { aliasHash: string; slot: number }[] = [];
    for (const e of this.registryEntries) {
      try {
        const owner = await this.contract.ownerOf(BigInt(e.aliasHash)) as string;
        if (owner.toLowerCase() === me.toLowerCase()) {
          owned.push({ aliasHash: e.aliasHash, slot: e.registrySlot });
        }
      } catch { /* burned or unowned */ }
    }
    return owned;
  }

  async lookup(alias: string): Promise<LookupResult> {
    this.ensureInit();
    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));
    const r = await contractLookupAlias(this.contract, aliasHash);
    if (r.spendingPubkey === 0n) throw new Error(`"${cleanAlias}.hls" is not registered`);
    return {
      spendingPubkey:   r.spendingPubkey,
      nullifierKeyHash: r.nullifierKeyHash,
      encryptionPubkey: ethers.getBytes(ethers.toBeHex(r.encryptionPubkey, 32)),
      dataHash:         r.dataHash,
    };
  }

  async updateKeys(
    alias: string,
    newViewingPrivKey: bigint,
    newEncryptionPublicKey: Uint8Array,
  ): Promise<{ txHash: string }> {
    this.ensureInit();
    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash  = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));

    const newNullifierKey     = poseidonHash([newViewingPrivKey]);
    const newNullifierKeyHash = poseidonHash([newNullifierKey, 1n]);
    const newEncPubkeyBig     = BigInt(ethers.hexlify(newEncryptionPublicKey));

    const tx = await contractUpdateKeys(this.contract, aliasHash, newNullifierKeyHash, newEncPubkeyBig);
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash };
  }

  async updateAliasData(alias: string, newDataHash: bigint): Promise<{ txHash: string }> {
    this.ensureInit();
    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash  = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));

    const tx = await contractUpdateAliasData(this.contract, aliasHash, newDataHash);
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash };
  }

  async sweepAndTransfer(
    alias: string,
    recipientAddress: string,
    newOwner: string,
    newOwnerKeys: { spendingPubkey: bigint; nullifierKey: bigint; encryptionPubkey: bigint },
  ): Promise<{ sweepTxHashes: string[]; transferTxHash: string }> {
    this.ensureInit();
    await this.ensureSync();

    const sweepTxHashes: string[] = [];
    const keys = this.keys!;

    const unspent = this.myEntries.filter(e =>
      e.amount > 0n &&
      !this.spentNullifiers.has(computeNullifier(keys.nullifierKey, e.leafIndex))
    );
    for (const entry of unspent) {
      const result = await this.withdraw(recipientAddress, ethers.formatEther(entry.amount));
      sweepTxHashes.push(result.txHash);
    }

    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash  = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));
    const newOwnerNullifierKeyHash = poseidonHash([newOwnerKeys.nullifierKey, 1n]);
    const tx = await contractTransferAliasWithKeys(
      this.contract, aliasHash, newOwner,
      newOwnerKeys.spendingPubkey, newOwnerNullifierKeyHash, newOwnerKeys.encryptionPubkey,
    );
    const receipt = await tx.wait();
    return { sweepTxHashes, transferTxHash: receipt!.hash };
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
    await this.ensureSync();

    const amount = ethers.parseEther(amountEth);
    const secret = randomBlinding();
    const temp   = deriveInviteKeys(secret);

    // Unnamed account: random key, no name preimage, invisible to alias lookup.
    const tempAliasHash = BigInt(ethers.hexlify(randomBytes(32))) % FIELD_PRIME;
    const registrationFee = await this.contract.registrationFee() as bigint;

    // No name: the invite account's aliasHash is random, so there is no plaintext behind
    // it and nothing to publish.
    const regTx = await contractRegister(
      this.contract, tempAliasHash, temp.spendingPubkey,
      temp.nullifierKeyHash, temp.encryptionPubkeyField, registrationFee, "",
    );
    await regTx.wait();
    await this.refresh();

    const entry = buildEntry(temp.spendingPubkey, temp.nullifierKeyHash, temp.blinding, amount, ETH_TOKEN_ADDRESS);

    // Encrypted to the temp key derived from the secret, so holding the secret is
    // sufficient to discover and decrypt the note — nothing else is transmitted.
    const { encrypted, viewTag } = encryptOutput(temp.blinding, amount, temp.encryption.publicKey);
    const encryptedOutput0 = encodeOutputBlob(encrypted, viewTag);

    const out1  = dummyOutput(randomBlinding());
    const comm1 = poseidonHash([out1.pubkey, out1.nullifierKeyHash, out1.blinding, out1.amount, ETH_TOKEN_ADDRESS]);

    const dBase  = this.consumeDummyIdx(2);
    const dummy0 = dummyInput(dBase, POOL_LEVELS);
    const dummy1 = dummyInput(dBase + 1, POOL_LEVELS);

    const paramsHash   = computeParamsHash(ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", BigInt(this.config.chainId), this.config.contractAddress);
    const poolRoot     = this.poolTree.getRoot();
    const registryRoot = this.smt.root;
    const tempEntry    = this.registryEntries.find(e => BigInt(e.aliasHash) === tempAliasHash);
    if (!tempEntry) throw new Error("Invite account did not appear in the registry after refresh");
    const siblings     = this.smt.getSiblings(tempEntry.registrySlot);

    const { proofBytes } = await proveTransact({
      poolRoot, registryRoot, publicAmount: amount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   [dummy0.nullifier, dummy1.nullifier],
      outputCommitments: [entry.commitment, comm1],
      inputs: [dummy0.input, dummy1.input],
      outputs: [
        { pubkey: temp.spendingPubkey, nullifierKeyHash: temp.nullifierKeyHash, blinding: temp.blinding,
          amount, aliasHash: tempAliasHash, registrySlot: tempEntry.registrySlot,
          dataHash: 0n, registrySiblings: siblings },
        out1,
      ],
    }, this.getArtifacts());

    const tx = await contractTransact(
      this.contract, poolRoot, registryRoot, amount, ETH_TOKEN_ADDRESS,
      [dummy0.nullifier, dummy1.nullifier],
      [entry.commitment, comm1],
      ZERO_TRANSACT_PARAMS, encryptedOutput0, "0x", proofBytes, amount,
    );
    const receipt = await tx.wait();
    await this.refresh();

    return { txHash: receipt!.hash, secret, inviteCode: encodeInviteCode(secret), amount };
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
  async claimInvite(
    secret: bigint,
    alias: string,
    opts: { relayerFee?: bigint; relayer?: string } = {},
  ): Promise<{ txHash: string }> {
    this.ensureInit();
    await this.ensureSync();

    const relayerFee = opts.relayerFee ?? 0n;
    const relayer    = opts.relayer ?? ethers.ZeroAddress;
    if (relayerFee > 0n && relayer === ethers.ZeroAddress)
      throw new Error("relayerFee requires a relayer address");

    const temp = deriveInviteKeys(secret);
    const note = this.findInviteNote(temp);
    if (!note) throw new Error("No unspent invite note found for this secret");

    const cleanAlias = alias.replace(/\.hls$/, "").toLowerCase();
    const aliasHash  = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cleanAlias + ".hls")));
    const smtKey     = aliasHash % FIELD_PRIME;

    const keys             = this.keys!;
    const nullifierKeyHash = poseidonHash([keys.nullifierKey, 1n]);
    const encBytes32       = BigInt(ethers.hexlify(keys.encryption.publicKey));

    const registrationFee = await this.contract.registrationFee() as bigint;
    const absAmount       = registrationFee + relayerFee;
    if (note.amount < absAmount)
      throw new Error(`Invite note ${ethers.formatEther(note.amount)} ETH cannot cover fee + relayer (${ethers.formatEther(absAmount)} ETH)`);

    // Mirror _doRegister locally: the change output must prove against the post-register
    // root. The slot is the next one the contract will hand out — registerWithPoolNote
    // registers before it verifies, so by proof-check time this is the claimer's slot.
    const ownSlot = Number(await this.contract.nextAliasSlot() as bigint);
    const postSmt = this.smt.clone();
    postSmt.update(ownSlot, smtKey, poseidonHash([keys.spendingPubkey, nullifierKeyHash, 0n]));

    const changeAmount = note.amount - absAmount;
    const changeBlind  = randomBlinding();
    const changeOut = changeAmount > 0n
      ? { pubkey: keys.spendingPubkey, nullifierKeyHash, blinding: changeBlind, amount: changeAmount,
          aliasHash: smtKey, registrySlot: ownSlot, dataHash: 0n,
          registrySiblings: postSmt.getSiblings(ownSlot) }
      : dummyOutput(randomBlinding());
    const comm0 = poseidonHash([changeOut.pubkey, changeOut.nullifierKeyHash, changeOut.blinding, changeOut.amount, ETH_TOKEN_ADDRESS]);

    const out1  = dummyOutput(randomBlinding());
    const comm1 = poseidonHash([out1.pubkey, out1.nullifierKeyHash, out1.blinding, out1.amount, ETH_TOKEN_ADDRESS]);

    const poolProof = this.poolTree.getProof(note.leafIndex);
    const dBase     = this.consumeDummyIdx(1);
    const dummy     = dummyInput(dBase, POOL_LEVELS);

    const nullifier0   = computeNullifier(temp.nullifierKey, note.leafIndex);
    const externalData = relayerFee > 0n ? packRelayerFee(relayer, relayerFee) : ethers.ZeroHash;
    const params: TransactParams = { recipient: this.config.contractAddress, externalData };

    const publicAmount = FIELD_PRIME - absAmount;
    const paramsHash   = computeParamsHash(params, "0x", "0x", BigInt(this.config.chainId), this.config.contractAddress);
    const poolRoot     = this.poolTree.getRoot();

    const { proofBytes } = await proveTransact({
      poolRoot, registryRoot: postSmt.root, publicAmount, tokenAddress: ETH_TOKEN_ADDRESS, paramsHash,
      inputNullifiers:   [nullifier0, dummy.nullifier],
      outputCommitments: [comm0, comm1],
      inputs: [
        { spendingPrivKey: temp.spendingPrivKey, viewingPrivKey: temp.viewingPrivKey,
          blinding: note.blinding, amount: note.amount,
          pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
        dummy.input,
      ],
      outputs: [changeOut, out1],
    }, this.getArtifacts());

    const tx = await contractRegisterWithPoolNote(
      this.contract,
      poolRoot, postSmt.root, publicAmount,
      [nullifier0, dummy.nullifier],
      [comm0, comm1],
      params, "0x", "0x", proofBytes,
      aliasHash, keys.spendingPubkey, nullifierKeyHash, encBytes32, `${cleanAlias}.hls`,
    );
    const receipt = await tx.wait();
    await this.refresh();
    return { txHash: receipt!.hash };
  }

  // Locate the unspent pool note belonging to an invite's temp keypair. The note is a
  // perfectly ordinary output encrypted to the temp encryption key, so the normal
  // decrypt-and-match path finds it — no special-case scanning.
  private findInviteNote(temp: InviteKeys): OwnedEntry | null {
    const owned = findMyOutputs(
      this.allOutputs, temp.spendingPubkey, temp.nullifierKey, temp.encryption.privateKey,
    );
    return owned.find(e => !this.spentNullifiers.has(computeNullifier(temp.nullifierKey, e.leafIndex))) ?? null;
  }

  async scan(tokenAddress: bigint = ETH_TOKEN_ADDRESS): Promise<ScanEntry[]> {
    this.ensureInit();
    await this.ensureSync();
    return this.myEntries
      .filter(e => e.tokenAddress === tokenAddress)
      .map(e => ({
        ...e,
        spent: this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.leafIndex)),
      }));
  }
}
