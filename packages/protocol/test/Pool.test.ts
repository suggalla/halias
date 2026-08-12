import { expect } from "chai";
import { ethers } from "hardhat";

// HaliasPool, exercised against the real HaliasRegistry.
//
// MockTransactVerifier accepts every proof, so nothing here proves a circuit constraint —
// these tests are about the Solidity that decides where value goes. Claim.test.ts is where
// the real verifier runs.
//
// The pool was extracted from the monolith with three behavioural widenings that no test
// had ever executed: the destination requirement was relaxed to only apply when a payout
// actually exists, the uint96 ceiling on the relayer fee was dropped, and relayer fees were
// extended from ETH to arbitrary tokens. Each of those has a test below that fails if the
// widening is reverted, and each has one that fails if it was widened too far.

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO_PROOF  = "0x" + "00".repeat(256);
const NO_RELAYER  = { relayer: ethers.ZeroAddress, amount: 0n };

const withdrawOf = (amount: bigint) => FIELD_PRIME - amount;
const rand32     = () => ethers.keccak256(ethers.randomBytes(32));

describe("HaliasPool", function () {
  this.timeout(120000);

  let pool: any, registry: any, token: any, feeToken: any;
  let poolAddr: string, registryAddr: string, verifierAddr: string;
  let registrar: any, user: any, recipient: any, relayer: any;

  async function baseParams(overrides: any = {}) {
    return {
      poolRoot: [await pool.getLastRoot(), await pool.getLastRoot()], treeNumber: [0, 0],
      registryRoot:      await registry.getRegistryRoot(),
      publicAmount:      0n,
      tokenAddress:      ethers.ZeroAddress,
      inputNullifiers:   [rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient:         ethers.ZeroAddress,
      relayerFee:        NO_RELAYER,
      externalData:      ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
      ...overrides,
    };
  }

  const send = (p: any, opts: any = {}) => pool.transact(p, "0x", "0x", ZERO_PROOF, opts);

  // Puts ETH in the pool so withdrawals have something to draw against.
  async function depositETH(amount: bigint) {
    await (await send(await baseParams({ publicAmount: amount }), { value: amount })).wait();
  }

  async function depositToken(t: any, amount: bigint) {
    await (await t.mint(user.address, amount)).wait();
    await (await t.connect(user).approve(poolAddr, amount)).wait();
    await (await pool.connect(user).transact(
      await baseParams({ publicAmount: amount, tokenAddress: await t.getAddress() }),
      "0x", "0x", ZERO_PROOF,
    )).wait();
  }

  beforeEach(async function () {
    [registrar, user, recipient, relayer] = await ethers.getSigners();

    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    // The registry hashes leaves with PoseidonT4 and nodes with T3; the pool tree only
    // ever hashes pairs, so it links T3 alone.
    const registryLibs = { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() };
    const poolLibs     = { PoseidonT3: await t3.getAddress() };

    verifierAddr = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    // The registrar does not exist yet, so a signer stands in for it. That is the whole of
    // the registry's write authority — no mock registry is involved anywhere here.
    registry     = await (await ethers.getContractFactory("HaliasRegistry", { libraries: registryLibs })).deploy(registrar.address);
    registryAddr = await registry.getAddress();

    pool     = await (await ethers.getContractFactory("HaliasPool", { libraries: poolLibs })).deploy(verifierAddr, registryAddr);
    poolAddr = await pool.getAddress();

    token    = await (await ethers.getContractFactory("MockERC20")).deploy("Test", "TST", 18);
    feeToken = await (await ethers.getContractFactory("MockFeeToken")).deploy();
  });

  // ── Construction ────────────────────────────────────────────────────────────

  describe("construction", function () {
    it("rejects a zero verifier or registry", async function () {
      const F = await ethers.getContractFactory("HaliasPool", {
        libraries: { PoseidonT3: await (await (await ethers.getContractFactory("PoseidonT3")).deploy()).getAddress() },
      });
      await expect(F.deploy(ethers.ZeroAddress, registryAddr)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(verifierAddr, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("exposes exactly one mutating function", async function () {
      // The property the whole split exists to create: no admin, no owner, no rescue. If
      // a state-changing function is ever added, this is where it has to be justified.
      const mutating = pool.interface.fragments.filter(
        (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability),
      ).map((f: any) => f.name);
      expect(mutating).to.deep.equal(["transact"]);
    });

    it("reads the live registry through the interface", async function () {
      // Proves IHaliasRegistry actually matches HaliasRegistry's ABI. Nothing else in the
      // build checks this, because the pool only ever holds an address.
      await expect(send(await baseParams())).to.not.be.reverted;
    });
  });

  // ── Roots ───────────────────────────────────────────────────────────────────

  // ── Exit path ───────────────────────────────────────────────────────────────

  describe("exit", function () {
    // An exit spends its inputs and creates nothing. It exists first as a safety valve: every
    // ordinary transact inserts two commitments, so a full tree would otherwise revert
    // deposits, transfers AND withdrawals together and strand every note in the pool with no
    // admin to rescue it. It is also much cheaper, because the tree walk is most of the cost.

    it("inserts nothing and does not move the root", async function () {
      const before = await pool.getLastRoot();
      const idx    = await pool.leafIndex();
      await (await send(await baseParams({ outputsEmpty: true }))).wait();
      expect(await pool.getLastRoot()).to.equal(before);
      expect(await pool.leafIndex()).to.equal(idx);
    });

    it("emits PoolExit rather than Transact, so a scanner inserts nothing", async function () {
      // The distinction has to live in the event. A scanner that inserted for an exit would
      // build a tree that disagrees with this contract's, and the only symptom is every
      // proof afterwards being rejected with nothing to say why.
      const p = await baseParams({ outputsEmpty: true });
      await expect(send(p)).to.emit(pool, "PoolExit")
        .withArgs(p.publicAmount, p.tokenAddress, p.inputNullifiers[0], p.inputNullifiers[1]);
      await expect(send(await baseParams({ outputsEmpty: true, inputNullifiers: [rand32(), rand32()] })))
        .to.not.emit(pool, "Transact");
    });

    it("still spends its nullifiers", async function () {
      const p = await baseParams({ outputsEmpty: true });
      await (await send(p)).wait();
      expect(await pool.spentNullifiers(p.inputNullifiers[0])).to.equal(true);
      expect(await pool.spentNullifiers(p.inputNullifiers[1])).to.equal(true);
      await expect(send(p)).to.be.revertedWithCustomError(pool, "NullifierAlreadySpent");
    });

    it("still pays out", async function () {
      await depositETH(ethers.parseEther("1"));
      const to = ethers.Wallet.createRandom().address;
      const amount = ethers.parseEther("0.4");
      await (await send(await baseParams({
        outputsEmpty: true, publicAmount: withdrawOf(amount), recipient: to,
      }))).wait();
      expect(await ethers.provider.getBalance(to)).to.equal(amount);
    });

    it("costs far less than the ordinary path", async function () {
      // The whole reason it is available outside the full-tree case. The tree walk is 32
      // Poseidon hashes at ~58k each; skipping it is most of a transact.
      const a = await (await send(await baseParams())).wait();
      const b = await (await send(await baseParams({ outputsEmpty: true }))).wait();
      expect(b!.gasUsed).to.be.lessThan(a!.gasUsed / 2n);
    });
  });

  describe("roots", function () {
    it("rejects an unknown pool root", async function () {
      await expect(send(await baseParams({ poolRoot: [rand32(), rand32()], treeNumber: [0, 0]})))
        .to.be.revertedWithCustomError(pool, "PoolRootUnknown");
    });

    it("rejects the zero pool root", async function () {
      await expect(send(await baseParams({ poolRoot: [ethers.ZeroHash, ethers.ZeroHash], treeNumber: [0, 0]})))
        .to.be.revertedWithCustomError(pool, "PoolRootUnknown");
    });

    it("rejects a registry root the registry never published", async function () {
      await expect(send(await baseParams({ registryRoot: rand32() })))
        .to.be.revertedWithCustomError(pool, "RegistryRootNotCurrent");
    });

    it("accepts a historical pool root, not just the newest", async function () {
      // A client one block behind is the common case, not an attack. Nullifiers prevent
      // double spends; root freshness is not load-bearing for the pool tree.
      const oldRoot = await pool.getLastRoot();
      await depositETH(ethers.parseEther("1"));
      expect(await pool.getLastRoot()).to.not.equal(oldRoot);
      await expect(send(await baseParams({ poolRoot: [oldRoot, oldRoot], treeNumber: [0, 0]}))).to.not.be.reverted;
    });

    it("accepts a registry root that is no longer current", async function () {
      const oldRoot = await registry.getRegistryRoot();
      await (await registry.register(rand32(), ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), rand32())).wait();
      expect(await registry.getRegistryRoot()).to.not.equal(oldRoot);
      await expect(send(await baseParams({ registryRoot: oldRoot }))).to.not.be.reverted;
    });
  });

  // ── Nullifiers ──────────────────────────────────────────────────────────────

  describe("nullifiers", function () {
    it("names which of the two inputs was already spent", async function () {
      const n0 = rand32(), n1 = rand32();
      await (await send(await baseParams({ publicAmount: ethers.parseEther("1"), inputNullifiers: [n0, n1] }),
        { value: ethers.parseEther("1") })).wait();

      await expect(send(await baseParams({ inputNullifiers: [n0, rand32()] })))
        .to.be.revertedWithCustomError(pool, "NullifierAlreadySpent").withArgs(n0);

      // Slot 1 is a separate branch: it is only reached when slot 0 is fresh.
      await expect(send(await baseParams({ inputNullifiers: [rand32(), n1] })))
        .to.be.revertedWithCustomError(pool, "NullifierAlreadySpent").withArgs(n1);
    });

    it("rejects the same nullifier used twice in one transaction", async function () {
      // Both lookups miss, so nothing above catches this — it would spend one note twice
      // inside a single call.
      const n = rand32();
      await expect(send(await baseParams({ inputNullifiers: [n, n] })))
        .to.be.revertedWithCustomError(pool, "DuplicateNullifier");
    });
  });

  // ── msg.value ───────────────────────────────────────────────────────────────

  // Four separate errors collapsed into one comparison against a single expected figure.
  // The risk in collapsing is that some shape stops being checked, so every shape is here.
  describe("msg.value", function () {
    it("requires exactly the deposit amount", async function () {
      const amount = ethers.parseEther("1");
      await expect(send(await baseParams({ publicAmount: amount }), { value: amount - 1n }))
        .to.be.revertedWithCustomError(pool, "WrongMsgValue").withArgs(amount, amount - 1n);
      await expect(send(await baseParams({ publicAmount: amount }), { value: amount + 1n }))
        .to.be.revertedWithCustomError(pool, "WrongMsgValue").withArgs(amount, amount + 1n);
      await expect(send(await baseParams({ publicAmount: amount }), { value: amount })).to.not.be.reverted;
    });

    it("refuses value on a withdrawal", async function () {
      await depositETH(ethers.parseEther("2"));
      await expect(send(
        await baseParams({ publicAmount: withdrawOf(ethers.parseEther("1")), recipient: recipient.address }),
        { value: 1n },
      )).to.be.revertedWithCustomError(pool, "WrongMsgValue").withArgs(0n, 1n);
    });

    it("refuses value on a transfer", async function () {
      await expect(send(await baseParams({ publicAmount: 0n }), { value: 1n }))
        .to.be.revertedWithCustomError(pool, "WrongMsgValue").withArgs(0n, 1n);
    });

    it("refuses ETH alongside a token deposit", async function () {
      await expect(send(
        await baseParams({ publicAmount: 1000n, tokenAddress: await token.getAddress() }),
        { value: 1n },
      )).to.be.revertedWithCustomError(pool, "WrongMsgValue").withArgs(0n, 1n);
    });
  });

  // ── Token sanity ────────────────────────────────────────────────────────────

  it("rejects a token address with no code", async function () {
    await expect(send(await baseParams({ publicAmount: 1000n, tokenAddress: user.address })))
      .to.be.revertedWithCustomError(pool, "InvalidTokenAddress");
  });

  it("rejects a fee-on-transfer token", async function () {
    // The pool would credit a note for the full amount while receiving less, leaving the
    // last withdrawal of that token unpayable.
    const amount = ethers.parseEther("10");
    await (await feeToken.mint(user.address, amount)).wait();
    await (await feeToken.connect(user).approve(poolAddr, amount)).wait();
    await expect(pool.connect(user).transact(
      await baseParams({ publicAmount: amount, tokenAddress: await feeToken.getAddress() }),
      "0x", "0x", ZERO_PROOF,
    )).to.be.revertedWithCustomError(pool, "FeeOnTransferToken");
  });

  // ── Payees ──────────────────────────────────────────────────────────────────

  describe("payees", function () {
    it("requires a recipient when there is a payout", async function () {
      await depositETH(ethers.parseEther("2"));
      await expect(send(await baseParams({
        publicAmount: withdrawOf(ethers.parseEther("1")), recipient: ethers.ZeroAddress,
      }))).to.be.revertedWithCustomError(pool, "BadPayee");
    });

    it("allows a zero recipient when the fee consumes the whole withdrawal", async function () {
      // WIDENING. This is the shape of every relayed transfer: the outflow exists only to
      // pay the relayer, so naming a recipient would mean naming someone who gets nothing.
      const amount = ethers.parseEther("1");
      await depositETH(amount);
      const before = await ethers.provider.getBalance(relayer.address);

      await expect(send(await baseParams({
        publicAmount: withdrawOf(amount),
        recipient:    ethers.ZeroAddress,
        relayerFee:   { relayer: relayer.address, amount },
      }))).to.not.be.reverted;

      expect(await ethers.provider.getBalance(relayer.address) - before).to.equal(amount);
    });

    it("refuses the pool as recipient or as relayer", async function () {
      // Value the pool holds against no note is stranded: no admin, no rescue, gone.
      const amount = ethers.parseEther("1");
      await depositETH(amount * 2n);

      await expect(send(await baseParams({ publicAmount: withdrawOf(amount), recipient: poolAddr })))
        .to.be.revertedWithCustomError(pool, "BadPayee");

      await expect(send(await baseParams({
        publicAmount: withdrawOf(amount),
        recipient:    recipient.address,
        relayerFee:   { relayer: poolAddr, amount: 1n },
      }))).to.be.revertedWithCustomError(pool, "BadPayee");
    });

    it("refuses a zero relayer with a non-zero fee", async function () {
      await depositETH(ethers.parseEther("2"));
      await expect(send(await baseParams({
        publicAmount: withdrawOf(ethers.parseEther("1")),
        recipient:    recipient.address,
        relayerFee:   { relayer: ethers.ZeroAddress, amount: 1n },
      }))).to.be.revertedWithCustomError(pool, "BadPayee");
    });

    it("reverts the whole transact when a payout fails", async function () {
      // The verifier contract has no receive(). A swallowed failure here would burn the
      // note and pay nobody.
      const amount = ethers.parseEther("1");
      await depositETH(amount);
      await expect(send(await baseParams({ publicAmount: withdrawOf(amount), recipient: verifierAddr })))
        .to.be.reverted;
    });
  });

  // ── Relayer fee ─────────────────────────────────────────────────────────────

  describe("relayer fee", function () {
    it("rejects a fee larger than the withdrawal it is paid from", async function () {
      const amount = ethers.parseEther("1");
      await depositETH(amount * 2n);
      await expect(send(await baseParams({
        publicAmount: withdrawOf(amount),
        recipient:    recipient.address,
        relayerFee:   { relayer: relayer.address, amount: amount + 1n },
      }))).to.be.revertedWithCustomError(pool, "RelayerFeeExceedsWithdrawal");
    });

    it("rejects a fee on a transfer or a deposit, which have no outflow", async function () {
      await expect(send(await baseParams({
        publicAmount: 0n, relayerFee: { relayer: relayer.address, amount: 1n },
      }))).to.be.revertedWithCustomError(pool, "RelayerFeeRequiresWithdrawal");

      const amount = ethers.parseEther("1");
      await expect(send(await baseParams({
        publicAmount: amount, relayerFee: { relayer: relayer.address, amount: 1n },
      }), { value: amount })).to.be.revertedWithCustomError(pool, "RelayerFeeRequiresWithdrawal");
    });

    it("splits a withdrawal between relayer and recipient", async function () {
      const total = ethers.parseEther("1");
      const fee   = ethers.parseEther("0.1");
      await depositETH(total);

      const relayerBefore   = await ethers.provider.getBalance(relayer.address);
      const recipientBefore = await ethers.provider.getBalance(recipient.address);

      await expect(send(await baseParams({
        publicAmount: withdrawOf(total),
        recipient:    recipient.address,
        relayerFee:   { relayer: relayer.address, amount: fee },
      }))).to.emit(pool, "Withdrawal").withArgs(recipient.address, total - fee, relayer.address, fee, 0n);

      expect(await ethers.provider.getBalance(relayer.address) - relayerBefore).to.equal(fee);
      expect(await ethers.provider.getBalance(recipient.address) - recipientBefore).to.equal(total - fee);
      expect(await ethers.provider.getBalance(poolAddr)).to.equal(0n);
    });

    it("pays a fee in the token being withdrawn", async function () {
      // WIDENING. Previously any fee on a token withdrawal was rejected, which left a user
      // holding only token notes with no way to pay for inclusion at all.
      const tokenAddr = await token.getAddress();
      const total = 1_000_000n, fee = 250_000n;
      await depositToken(token, total);

      await expect(pool.connect(user).transact(await baseParams({
        publicAmount: withdrawOf(total),
        tokenAddress: tokenAddr,
        recipient:    recipient.address,
        relayerFee:   { relayer: relayer.address, amount: fee },
      }), "0x", "0x", ZERO_PROOF))
        .to.emit(pool, "Withdrawal")
        .withArgs(recipient.address, total - fee, relayer.address, fee, BigInt(tokenAddr));

      expect(await token.balanceOf(relayer.address)).to.equal(fee);
      expect(await token.balanceOf(recipient.address)).to.equal(total - fee);
      expect(await pool.poolTokenBalance(tokenAddr)).to.equal(0n);
    });

    it("allows a fee above the old uint96 ceiling", async function () {
      // WIDENING. The 96-bit cap was an artefact of packing the fee beside an address in
      // one word. Nothing was ever checked against it — the real bound is the outflow — so
      // a fee that would previously have been truncated must now settle in full.
      const tokenAddr = await token.getAddress();
      const total = 1n << 100n;
      const fee   = (1n << 96n) + 1n;      // one wei past what uint96 could hold
      await depositToken(token, total);

      await (await pool.connect(user).transact(await baseParams({
        publicAmount: withdrawOf(total),
        tokenAddress: tokenAddr,
        recipient:    recipient.address,
        relayerFee:   { relayer: relayer.address, amount: fee },
      }), "0x", "0x", ZERO_PROOF)).wait();

      expect(await token.balanceOf(relayer.address)).to.equal(fee);
      expect(await token.balanceOf(recipient.address)).to.equal(total - fee);
    });
  });

  // ── Balances ────────────────────────────────────────────────────────────────

  describe("balances", function () {
    it("tracks the token ledger across deposit and withdrawal", async function () {
      const tokenAddr = await token.getAddress();
      await depositToken(token, 1000n);
      expect(await pool.poolTokenBalance(tokenAddr)).to.equal(1000n);

      await (await pool.connect(user).transact(await baseParams({
        publicAmount: withdrawOf(400n),
        tokenAddress: tokenAddr,
        recipient:    recipient.address,
      }), "0x", "0x", ZERO_PROOF)).wait();

      expect(await pool.poolTokenBalance(tokenAddr)).to.equal(600n);
      expect(await token.balanceOf(poolAddr)).to.equal(600n);
    });

    it("refuses to withdraw more of a token than its notes cover", async function () {
      const tokenAddr = await token.getAddress();
      await depositToken(token, 1000n);
      // Fund the pool past its ledger so the ERC-20 transfer itself would succeed. Only
      // the ledger stands between this and paying out another token's collateral.
      await (await token.mint(poolAddr, 10_000n)).wait();

      await expect(pool.connect(user).transact(await baseParams({
        publicAmount: withdrawOf(1001n),
        tokenAddress: tokenAddr,
        recipient:    recipient.address,
      }), "0x", "0x", ZERO_PROOF)).to.be.revertedWithCustomError(pool, "PoolBalanceExceeded");
    });

    it("refuses to withdraw more ETH than the pool holds", async function () {
      await depositETH(ethers.parseEther("1"));
      await expect(send(await baseParams({
        publicAmount: withdrawOf(ethers.parseEther("2")),
        recipient:    recipient.address,
      }))).to.be.revertedWithCustomError(pool, "PoolBalanceExceeded");
    });

    it("keeps two tokens' ledgers independent", async function () {
      const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 18);
      await depositToken(token, 1000n);
      await depositToken(other, 5000n);
      expect(await pool.poolTokenBalance(await token.getAddress())).to.equal(1000n);
      expect(await pool.poolTokenBalance(await other.getAddress())).to.equal(5000n);
    });
  });

  // ── Tree ────────────────────────────────────────────────────────────────────

  describe("commitments", function () {
    it("rejects a zero commitment", async function () {
      // Zero is the empty-subtree sentinel: inserting it would make an empty position
      // indistinguishable from a filled one.
      await expect(send(await baseParams({ outputCommitments: [ethers.ZeroHash, rand32()] })))
        .to.be.revertedWithCustomError(pool, "ZeroCommitment");
      await expect(send(await baseParams({ outputCommitments: [rand32(), ethers.ZeroHash] })))
        .to.be.revertedWithCustomError(pool, "ZeroCommitment");
    });

    it("assigns sequential leaf index pairs", async function () {
      await expect(send(await baseParams())).to.emit(pool, "Transact");
      expect(await pool.leafIndex()).to.equal(2n);
      await (await send(await baseParams())).wait();
      expect(await pool.leafIndex()).to.equal(4n);
    });
  });

  // ── receive() ───────────────────────────────────────────────────────────────

  it("refuses ETH pushed at it directly", async function () {
    // Untracked ETH is covered by no note and cannot be withdrawn by anyone.
    await expect(registrar.sendTransaction({ to: poolAddr, value: 1n }))
      .to.be.revertedWithCustomError(pool, "DirectETHNotAllowed");
  });

  // ── paramsHash ──────────────────────────────────────────────────────────────

  describe("paramsHash", function () {
    it("binds the relayer and the fee", async function () {
      // The fee moved from a packed word into a struct. If either member fell out of the
      // preimage a submitter could rewrite it and keep the proof valid.
      const p = await baseParams({ recipient: recipient.address });
      const base = await pool.computeParamsHash(p, "0x", "0x");

      const other = await pool.computeParamsHash(
        { ...p, relayerFee: { relayer: relayer.address, amount: 0n } }, "0x", "0x");
      const amount = await pool.computeParamsHash(
        { ...p, relayerFee: { relayer: ethers.ZeroAddress, amount: 1n } }, "0x", "0x");

      expect(base).to.not.equal(other);
      expect(base).to.not.equal(amount);
      expect(other).to.not.equal(amount);
    });

    it("binds the recipient, the ciphertexts and externalData", async function () {
      const p = await baseParams({ recipient: recipient.address });
      const base = await pool.computeParamsHash(p, "0x", "0x");

      expect(await pool.computeParamsHash({ ...p, recipient: relayer.address }, "0x", "0x")).to.not.equal(base);
      expect(await pool.computeParamsHash({ ...p, externalData: rand32() }, "0x", "0x")).to.not.equal(base);
      expect(await pool.computeParamsHash(p, "0xdead", "0x")).to.not.equal(base);
      expect(await pool.computeParamsHash(p, "0x", "0xdead")).to.not.equal(base);
    });

    it("stays inside the field", async function () {
      const p = await baseParams({ recipient: recipient.address });
      expect(await pool.computeParamsHash(p, "0x", "0x")).to.be.lessThan(FIELD_PRIME);
    });
  });
});
