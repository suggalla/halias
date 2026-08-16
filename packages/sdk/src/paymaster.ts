// Build the ERC-4337 v0.7 `paymasterAndData` bytes for a HaliasPaymaster-sponsored
// UserOp. The value is fully deterministic and validated entirely on-chain, so it is
// constructed client-side — no relayer or paymaster service required.
//
// Layout (53 bytes), EntryPoint owns [20:52]:
//   [0:20]   paymaster address
//   [20:36]  paymasterVerificationGasLimit (uint128 big-endian)
//   [36:52]  postOpGasLimit                (uint128 big-endian)
//   [52]     path byte (see PaymasterPath)
//
// The path byte must stay in sync with HaliasPaymaster's PATH_* constants.

export type PaymasterPath = "pool-note" | "erc20-note" | "register";

const PATH_BYTE: Record<PaymasterPath, number> = {
  "pool-note":  0x00,
  "erc20-note": 0x01,
  "register":   0x02,
};

export interface PaymasterDataOptions {
  // EntryPoint gas limits. Defaults mirror the former relayer service.
  verificationGasLimit?: bigint; // default 100_000
  postOpGasLimit?: bigint;       // default 50_000
}

const hex = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, "0");

export function buildPaymasterAndData(
  paymaster: string,
  path: PaymasterPath = "pool-note",
  opts: PaymasterDataOptions = {},
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(paymaster)) {
    throw new Error("paymaster must be a 20-byte hex address");
  }
  const pathByte = PATH_BYTE[path];
  if (pathByte === undefined) throw new Error(`unknown paymaster path: ${path}`);

  const verificationGas = opts.verificationGasLimit ?? 100_000n;
  const postOpGas       = opts.postOpGasLimit       ?? 50_000n;

  return (
    "0x" +
    paymaster.slice(2).toLowerCase() +
    hex(verificationGas, 16) +
    hex(postOpGas, 16) +
    hex(BigInt(pathByte), 1)
  );
}
