import { ethers } from "ethers";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const HALIAS_ABI = [
  // Core operation — deposit (publicAmount > 0), transfer (= 0), withdraw (field-negative)
  "function transact((bytes32 poolRoot, bytes32 registryRoot, uint256 publicAmount, uint256 tokenAddress, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, address recipient, bytes32 externalData) p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof) external payable",
  // Alias registry
  "function register(bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey) external payable",
  "function updateKeys(bytes32 aliasHash, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external",
  "function updateAliasData(bytes32 aliasHash, bytes32 newDataHash) external",
  "function transferAliasWithKeys(bytes32 aliasHash, address newOwner, bytes32 newSpendingPubkey, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external",
  "function aliases(bytes32 aliasHash) external view returns (bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint64 registeredAt)",
  "function registrationFee() external view returns (uint256)",
  // Invite claim (pool-note model — spend a pool note atomically with registration)
  "function registerWithPoolNote((bytes32 poolRoot, bytes32 registryRoot, uint256 publicAmount, uint256 tokenAddress, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, address recipient, bytes32 externalData) p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof, bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey) external",
  // SMT state
  "function smtRoot() external view returns (bytes32)",
  "function getRegistryRoot() external view returns (bytes32)",
  "function getSmtSiblings(uint256 key) external view returns (bytes32[64] memory siblings)",
  // Pool state queries
  "function isKnownPoolRoot(bytes32) external view returns (bool)",
  "function spentNullifiers(bytes32) external view returns (bool)",
  // Events
  "event Transact(uint256 publicAmount, uint256 tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
  "event AliasRegistered(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 registryLeafHash, bytes32 encryptionPubkey)",
  "event KeysUpdated(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 registryLeafHash, bytes32 encryptionPubkey)",
  "event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 newDataHash, bytes32 newLeafHash)",
  "event AliasTransferred(bytes32 indexed aliasHash, address indexed previousOwner, address indexed newOwner, bytes32 newSpendingPubkey, bytes32 newRegistryLeafHash, bytes32 newEncryptionPubkey)",
  "event Withdrawal(address indexed recipient, uint256 amount, uint256 tokenAddress)",
];

export interface TransactParams {
  recipient:    string;  // unshield destination; address(this) only via registerWithPoolNote
  externalData: string;  // bytes32 hex commitment hook
}

export const ZERO_TRANSACT_PARAMS: TransactParams = {
  recipient:    ethers.ZeroAddress,
  externalData: ethers.ZeroHash,
};

function h32(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

export function getContract(address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, HALIAS_ABI, runner);
}

export async function transact(
  contract: ethers.Contract,
  poolRoot: bigint,
  registryRoot: bigint,
  publicAmount: bigint,
  tokenAddress: bigint,
  inputNullifiers: [bigint, bigint],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  value: bigint = 0n,
): Promise<ethers.ContractTransactionResponse> {
  return contract.transact(
    {
      poolRoot:          h32(poolRoot),
      registryRoot:      h32(registryRoot),
      publicAmount,
      tokenAddress,
      inputNullifiers:   [h32(inputNullifiers[0]), h32(inputNullifiers[1])],
      outputCommitments: [h32(outputCommitments[0]), h32(outputCommitments[1])],
      recipient:         params.recipient,
      externalData:      params.externalData,
    },
    encryptedOutput0,
    encryptedOutput1,
    proofBytes,
    { value },
  );
}

export async function register(
  contract: ethers.Contract,
  aliasHash: bigint,
  spendingPubkey: bigint,
  nullifierKeyHash: bigint,   // Poseidon(nullifierKey, 1) — caller must pre-compute
  encryptionPubkeyX: bigint,
  fee: bigint = ethers.parseEther("0.002"),
): Promise<ethers.ContractTransactionResponse> {
  return contract.register(
    h32(aliasHash),
    h32(spendingPubkey),
    h32(nullifierKeyHash),
    h32(encryptionPubkeyX),
    { value: fee },
  );
}

export async function updateKeys(
  contract: ethers.Contract,
  aliasHash: bigint,
  newNullifierKeyHash: bigint,   // Poseidon(newNullifierKey, 1)
  newEncryptionPubkey: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return contract.updateKeys(h32(aliasHash), h32(newNullifierKeyHash), h32(newEncryptionPubkey));
}

export async function updateAliasData(
  contract: ethers.Contract,
  aliasHash: bigint,
  newDataHash: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return contract.updateAliasData(h32(aliasHash), h32(newDataHash));
}

export async function transferAliasWithKeys(
  contract: ethers.Contract,
  aliasHash: bigint,
  newOwner: string,
  newSpendingPubkey: bigint,
  newNullifierKeyHash: bigint,   // Poseidon(newNullifierKey, 1)
  newEncryptionPubkey: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return contract.transferAliasWithKeys(
    h32(aliasHash), newOwner, h32(newSpendingPubkey), h32(newNullifierKeyHash), h32(newEncryptionPubkey),
  );
}

export async function lookupAlias(
  contract: ethers.Contract,
  aliasHash: bigint,
): Promise<{ spendingPubkey: bigint; nullifierKeyHash: bigint; encryptionPubkey: bigint; dataHash: bigint }> {
  const r = await contract.aliases(h32(aliasHash));
  return {
    spendingPubkey:   BigInt(r.spendingPubkey),
    nullifierKeyHash: BigInt(r.nullifierKeyHash),
    encryptionPubkey: BigInt(r.encryptionPubkey),
    dataHash:         BigInt(r.dataHash),
  };
}

export async function registerWithPoolNote(
  contract: ethers.Contract,
  poolRoot: bigint,
  registryRoot: bigint,
  publicAmount: bigint,
  inputNullifiers: [bigint, bigint],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  aliasHash: bigint,
  spendingPubkey: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkeyX: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return contract.registerWithPoolNote(
    {
      poolRoot:          h32(poolRoot),
      registryRoot:      h32(registryRoot),
      publicAmount,
      tokenAddress:      0n,
      inputNullifiers:   [h32(inputNullifiers[0]), h32(inputNullifiers[1])],
      outputCommitments: [h32(outputCommitments[0]), h32(outputCommitments[1])],
      recipient:         params.recipient,
      externalData:      params.externalData,
    },
    encryptedOutput0,
    encryptedOutput1,
    proofBytes,
    h32(aliasHash),
    h32(spendingPubkey),
    h32(nullifierKeyHash),
    h32(encryptionPubkeyX),
  );
}

export function computeParamsHash(
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  chainId: bigint,
  contractAddress: string,
): bigint {
  return BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "bytes", "bytes", "bytes32"],
      [chainId, contractAddress, params.recipient, encryptedOutput0, encryptedOutput1, params.externalData],
    )
  )) % FIELD_PRIME;
}
