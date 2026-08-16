import { expect } from "chai";
import { buildPaymasterAndData, PaymasterPath } from "../src/paymaster";

const PM = "0x00000000000000000000000000000000000000Aa";

// Slices into the 53-byte paymasterAndData (hex string, "0x" + 106 hex chars).
const addr     = (d: string) => d.slice(2, 42);
const verifGas = (d: string) => BigInt("0x" + d.slice(42, 74));
const postGas  = (d: string) => BigInt("0x" + d.slice(74, 106));
const pathByte = (d: string) => d.slice(106, 108);

describe("buildPaymasterAndData", () => {
  it("produces a 53-byte value (0x + 106 hex chars)", () => {
    const d = buildPaymasterAndData(PM);
    expect(d).to.match(/^0x[0-9a-f]{106}$/);
    expect((d.length - 2) / 2).to.equal(53);
  });

  it("lowercases and embeds the paymaster address", () => {
    const d = buildPaymasterAndData(PM);
    expect(addr(d)).to.equal(PM.slice(2).toLowerCase());
  });

  it("encodes the default gas limits (100k / 50k)", () => {
    const d = buildPaymasterAndData(PM);
    expect(verifGas(d)).to.equal(100_000n);
    expect(postGas(d)).to.equal(50_000n);
  });

  it("honors custom gas limits", () => {
    const d = buildPaymasterAndData(PM, "pool-note", {
      verificationGasLimit: 250_000n,
      postOpGasLimit: 75_000n,
    });
    expect(verifGas(d)).to.equal(250_000n);
    expect(postGas(d)).to.equal(75_000n);
  });

  it("maps each path to its contract PATH_* byte", () => {
    const cases: [PaymasterPath, string][] = [
      ["pool-note", "00"],
      ["erc20-note", "01"],
      ["register", "02"],
    ];
    for (const [path, byte] of cases) {
      expect(pathByte(buildPaymasterAndData(PM, path))).to.equal(byte);
    }
  });

  it("defaults to the pool-note path", () => {
    expect(pathByte(buildPaymasterAndData(PM))).to.equal("00");
  });

  it("rejects a malformed paymaster address", () => {
    expect(() => buildPaymasterAndData("0x1234")).to.throw(/20-byte hex address/);
  });

  it("rejects an unknown path", () => {
    expect(() => buildPaymasterAndData(PM, "voucher" as PaymasterPath)).to.throw(/unknown paymaster path/);
  });
});
