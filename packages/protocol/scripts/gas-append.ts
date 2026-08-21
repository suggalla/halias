import { ethers } from "hardhat";
import { ensurePoseidon } from "./poseidon";

// Registration measured end to end against both write strategies. Same contract, same
// surrounding work — record, slot, prefix index, root stamp, event — differing only in how
// the tree is written, because MockAppendRegistry overrides nothing else.
async function main() {
  const [admin] = await ethers.getSigners();
  const { PoseidonT3, PoseidonT4 } = await ensurePoseidon();
  const libs = { PoseidonT3, PoseidonT4 };

  const mk = async (name: string) =>
    (await (await ethers.getContractFactory(name, { libraries: libs })).deploy(admin.address)).waitForDeployment();

  const rows: Record<string, number[]> = {};
  for (const name of ["HaliasRegistry", "MockAppendRegistry"]) {
    const reg: any = await mk(name);
    const used: number[] = [];
    for (let i = 0; i < 12; i++) {
      const h = ethers.keccak256(ethers.toUtf8Bytes(`alias${i}`));
      const rc = await (await reg.register(h, ethers.toBeHex(11n + BigInt(i), 32),
        ethers.toBeHex(22n, 32), ethers.toBeHex(33n, 32))).wait();
      used.push(Number(rc.gasUsed));
    }
    rows[name] = used;
  }

  const pick = (v: number[]) => v.slice(1);              // #1 pays one-off costs
  const avg  = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length);

  const cur = avg(pick(rows.HaliasRegistry));
  const app = avg(pick(rows.MockAppendRegistry));
  console.log(`  register, stored nodes      ${cur}`);
  console.log(`  register, append-only       ${app}`);
  console.log(`  difference                  ${cur - app}  (${((cur - app) / cur * 100).toFixed(1)}%)`);
  console.log("");
  console.log(`  stored nodes, #2..#12       ${pick(rows.HaliasRegistry).join(" ")}`);
  console.log(`  append-only,  #2..#12       ${pick(rows.MockAppendRegistry).join(" ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
