import { ethers } from "ethers";
import { MerkleTree } from "./merkle";
import { SMT, aliasHashToSmtKey } from "./smt";
import { buildEntry, computeNullifier, OwnedEntry, ETH_TOKEN_ADDRESS } from "./entry";
import { decodeOutputBlob, tryDecryptOutput, poseidonHash } from "./crypto";

export const TRANSACT_ABI = [
  "event Transact(uint256 publicAmount, uint256 indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
];
export const REGISTRY_ABI = [
  "event AliasRegistered(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 registryLeafHash, bytes32 encryptionPubkey, uint32 registrySlot)",
  "event KeysUpdated(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 registryLeafHash, bytes32 encryptionPubkey)",
  "event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 newDataHash, bytes32 newLeafHash)",
  "event AliasTransferred(bytes32 indexed aliasHash, address indexed previousOwner, address indexed newOwner, bytes32 newSpendingPubkey, bytes32 newRegistryLeafHash, bytes32 newEncryptionPubkey)",
];

const DEFAULT_CHUNK_SIZE = 2_000;
const DELAY_MS = 50;
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface Output {
  commitment: bigint;
  leafIndex: number;
  encryptedBlob: string;
  tokenAddress: bigint;
  spentNullifiers: [bigint, bigint];
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
}

export interface RegistryEntry {
  aliasHash: string;
  registrySlot: number;        // position in the SMT, assigned at registration and never reused
  spendingPubkey: bigint;
  nullifierKeyHash: bigint;    // Poseidon(nullifierKey, 1) — not in events; read from contract for proof construction
  leafHash: bigint;            // Poseidon(spendingPubkey, nullifierKeyHash, dataHash) — emitted in events; used for SMT
  encryptionPubkey: Uint8Array;
  dataHash: bigint;
}

export interface ScanResult {
  poolTree: MerkleTree;
  smt: SMT;
  outputs: Output[];
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  spentNullifiers: Set<bigint>;
}

export async function scanEvents(
  provider: ethers.Provider,
  contractAddress: string,
  fromBlock: number = 0,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (pct: number) => void,
): Promise<ScanResult> {
  const jsIface        = new ethers.Interface(TRANSACT_ABI);
  const regIface       = new ethers.Interface(REGISTRY_ABI);
  const jsTopic        = jsIface.getEvent("Transact")!.topicHash;
  const regTopic       = regIface.getEvent("AliasRegistered")!.topicHash;
  const keysUpdTopic   = regIface.getEvent("KeysUpdated")!.topicHash;
  const dataUpdTopic   = regIface.getEvent("AliasDataUpdated")!.topicHash;
  const transferTopic  = regIface.getEvent("AliasTransferred")!.topicHash;

  const latestBlock = await provider.getBlockNumber();

  const allLogs: ethers.Log[] = [];
  let cur = fromBlock;
  const total = latestBlock - fromBlock;
  while (cur <= latestBlock) {
    const end = Math.min(cur + chunkSize - 1, latestBlock);
    if (onProgress) onProgress(Math.floor(((cur - fromBlock) / (total || 1)) * 100));
    const chunk = await provider.getLogs({ address: contractAddress, fromBlock: cur, toBlock: end });
    allLogs.push(...chunk);
    cur = end + 1;
    if (cur <= latestBlock) await delay(DELAY_MS);
  }
  if (onProgress) onProgress(100);

  const outputsByLeafIndex = new Map<number, Output>();
  const spentNullifiers = new Set<bigint>();
  const registryByAlias = new Map<string, RegistryEntry>();
  const aliasHashByPubkey = new Map<bigint, bigint>();

  for (const log of allLogs) {
    const topic = log.topics[0];

    if (topic === jsTopic) {
      const e = jsIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const tokenAddress = BigInt(e.args[1]);
      const null0 = BigInt(e.args[2]);
      const null1 = BigInt(e.args[3]);
      spentNullifiers.add(null0);
      spentNullifiers.add(null1);

      const comm0 = BigInt(e.args[4]);
      const comm1 = BigInt(e.args[5]);
      const idx0  = Number(e.args[6]);
      const idx1  = Number(e.args[7]);
      const blob0 = e.args[8];
      const blob1 = e.args[9];

      const base = {
        spentNullifiers: [null0, null1] as [bigint, bigint],
        tokenAddress,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
      };
      outputsByLeafIndex.set(idx0, { commitment: comm0, leafIndex: idx0, encryptedBlob: blob0, ...base });
      outputsByLeafIndex.set(idx1, { commitment: comm1, leafIndex: idx1, encryptedBlob: blob1, ...base });

    } else if (topic === regTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash      = e.args[0] as string;
      const spendingPubkey = BigInt(e.args[1]);
      const entry: RegistryEntry = {
        aliasHash,
        registrySlot:      Number(e.args[4]) - 1,  // stored offset by one on-chain
        spendingPubkey,
        nullifierKeyHash:  0n,            // not in event; fetch from contract when building proofs
        leafHash:          BigInt(e.args[2]),  // Poseidon(pubkey, nullifierKeyHash, dataHash)
        encryptionPubkey:  ethers.getBytes(e.args[3]),
        dataHash:          0n,
      };
      registryByAlias.set(aliasHash, entry);
      aliasHashByPubkey.set(spendingPubkey, BigInt(aliasHash));

    } else if (topic === keysUpdTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash      = e.args[0] as string;
      const spendingPubkey = BigInt(e.args[1]);
      const existing       = registryByAlias.get(aliasHash);
      const entry: RegistryEntry = {
        aliasHash,
        registrySlot:      existing ? existing.registrySlot : 0,  // rotation keeps the original slot
        spendingPubkey,
        nullifierKeyHash:  0n,
        leafHash:          BigInt(e.args[2]),
        encryptionPubkey:  ethers.getBytes(e.args[3]),
        dataHash:          existing ? existing.dataHash : 0n,
      };
      registryByAlias.set(aliasHash, entry);
      if (existing) aliasHashByPubkey.delete(existing.spendingPubkey);
      aliasHashByPubkey.set(spendingPubkey, BigInt(aliasHash));

    } else if (topic === dataUpdTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash = e.args[0] as string;
      const existing = registryByAlias.get(aliasHash);
      if (existing) {
        existing.dataHash = BigInt(e.args[1]);
        existing.leafHash  = BigInt(e.args[2]);
        registryByAlias.set(aliasHash, existing);
      }

    } else if (topic === transferTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash = e.args[0] as string;
      const newSpendingPubkey = BigInt(e.args[3]);
      const existing = registryByAlias.get(aliasHash);
      const entry: RegistryEntry = {
        aliasHash,
        registrySlot:     existing ? existing.registrySlot : 0,  // transfer keeps the slot
        spendingPubkey:  newSpendingPubkey,
        nullifierKeyHash: 0n,
        leafHash:         BigInt(e.args[4]),
        encryptionPubkey: ethers.getBytes(e.args[5]),
        dataHash:         0n,
      };
      registryByAlias.set(aliasHash, entry);
      if (existing) aliasHashByPubkey.delete(existing.spendingPubkey);
      aliasHashByPubkey.set(newSpendingPubkey, BigInt(aliasHash));

    }
  }

  const sortedOutputs = [...outputsByLeafIndex.values()].sort((a, b) => a.leafIndex - b.leafIndex);
  const poolTree = new MerkleTree();
  for (const out of sortedOutputs) {
    poolTree.insert(out.commitment);
  }

  const registryEntries = [...registryByAlias.values()];
  const smt = new SMT();
  for (const entry of registryEntries) {
    smt.update(entry.registrySlot, aliasHashToSmtKey(BigInt(entry.aliasHash)), entry.leafHash);
  }

  return { poolTree, smt, outputs: sortedOutputs, registryEntries, aliasHashByPubkey, spentNullifiers };
}


export function findMyOutputs(
  outputs: Output[],
  spendingPubkey: bigint,
  nullifierKey: bigint,   // raw key — hashed internally before commitment check
  encryptionPrivKey: Uint8Array,
  tokenAddress: bigint = ETH_TOKEN_ADDRESS,
): OwnedEntry[] {
  const nullifierKeyHash = poseidonHash([nullifierKey, 1n]);
  const found: OwnedEntry[] = [];
  for (const out of outputs) {
    if (out.tokenAddress !== tokenAddress) continue;
    const decoded = decodeOutputBlob(out.encryptedBlob);
    if (!decoded) continue;
    const decrypted = tryDecryptOutput(decoded, encryptionPrivKey);
    if (!decrypted) continue;
    const entry = buildEntry(spendingPubkey, nullifierKeyHash, decrypted.blinding, decrypted.amount, tokenAddress);
    if (entry.commitment !== out.commitment) continue;
    found.push({ ...entry, leafIndex: out.leafIndex });
  }
  return found;
}
