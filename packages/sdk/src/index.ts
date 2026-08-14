export { init, poseidonHash, deriveKeysFromRoot } from "./crypto";
export { encryptOutput, decryptOutput, encodeOutputBlob, decodeOutputBlob } from "./crypto";
export type { NaclKeypair, HaliasKeys, EncryptedOutput } from "./crypto";

export { generateMnemonic, isValidMnemonic, rootFromMnemonic, MnemonicSource, RootSource } from "./seed";
export { encodeViewKey, decodeViewKey, viewKeysFrom, keysFromViewKeys } from "./viewkey";
export type { ViewKeys } from "./viewkey";
export type { SeedSource } from "./seed";

export { MerkleTree } from "./merkle";

export { buildEntry, computeNullifier, randomBlinding, ETH_TOKEN_ADDRESS, NULLIFIER_DOMAIN } from "./entry";
export type { Entry, OwnedEntry } from "./entry";

export { proveTransact, dummyInput, dummyOutput } from "./proof";
export type { ArtifactPaths, TransactInput, TransactOutput, TransactProveInput } from "./proof";

export { scanEvents, findMyOutputs } from "./events";
export type { Output, RegistryEntry, ScanResult } from "./events";

export {
  getPool, getRegistry, getController,
  transact, register, acceptAlias, lookupAlias, claim,
  signUpdateAliasData, signOfferAlias, signCancelOffer,
  computeParamsHash, encodeRegistration, buildTransactParams,
  ZERO_TRANSACT_PARAMS, NO_RELAYER,
} from "./contract";
export type { TransactParams, RelayerFee, Registration } from "./contract";

export { Halias } from "./halias";
export { normalizeAlias, fullAlias, isValidAlias, InvalidAliasError, AliasTakenError } from "./alias";
export { encodeRelayBlob, decodeRelayBlob, quoteRelay, submitRelay, suggestRelayFee } from "./relay";
export type { RelayPayload, RelayQuote } from "./relay";
export type { HistoryEntry, PrivacyContext } from "./halias";
export type { HaliasConfig, DepositResult, SendResult, WithdrawResult, BalanceResult, LookupResult } from "./halias";


export { FileCache, BrowserCache } from "./cache";
export type { CacheStore, CacheData } from "./cache";

// Exported so the protocol package can assert these match the compiled contract.
export { TRANSACT_ABI, REGISTRY_ABI } from "./events";
export {
  deriveInviteKeys,
  encodeInviteCode, decodeInviteCode,
} from "./invite";
export type { InviteKeys } from "./invite";
export { POOL_ABI, REGISTRY_ABI as POOL_REGISTRY_ABI, CONTROLLER_ABI } from "./contract";
