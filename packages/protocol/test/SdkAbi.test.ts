import { expect } from "chai";
import { ethers, artifacts } from "hardhat";

const sdk = require("halias-sdk");

// The SDK hand-maintains ABI fragments as strings, independent of the compiled contract.
// Nothing forced the two to agree, and they silently diverged: the Transact event declared
// tokenAddress non-indexed while the contract had it indexed. The event *signature* is the
// same either way, so the topic hash matched and the log was found — but tokenAddress sits
// in topics rather than data, shifting every later field by a word and corrupting the
// trailing bytes offsets. The SDK could not decode a single Transact event, and no test
// noticed, because the protocol suite reads logs through typechain and the SDK suite feeds
// findMyOutputs hand-built objects.
//
// This compares fragment by fragment against the compiled artifact, so any future drift in
// a name, a type, or an indexed flag fails here rather than on a live chain.
describe("SDK ABI matches the compiled contract", function () {
  let contractIface: ethers.Interface;

  before(async function () {
    const artifact = await artifacts.readArtifact("Halias");
    contractIface = new ethers.Interface(artifact.abi);
  });

  function eventFragments(abi: string[]): ethers.EventFragment[] {
    const iface = new ethers.Interface(abi);
    return iface.fragments.filter(f => f.type === "event") as ethers.EventFragment[];
  }

  function functionFragments(abi: string[]): ethers.FunctionFragment[] {
    const iface = new ethers.Interface(abi);
    return iface.fragments.filter(f => f.type === "function") as ethers.FunctionFragment[];
  }

  it("every SDK event matches the contract, including indexed flags", function () {
    const sdkEvents = [
      ...eventFragments(sdk.TRANSACT_ABI),
      ...eventFragments(sdk.REGISTRY_ABI),
    ];
    expect(sdkEvents.length).to.be.greaterThan(0);

    for (const ev of sdkEvents) {
      const onChain = contractIface.getEvent(ev.name);
      expect(onChain, `contract has no event ${ev.name}`).to.not.equal(null);

      // topicHash only covers types, not indexing — compare the full canonical form.
      expect(ev.topicHash, `${ev.name} signature`).to.equal(onChain!.topicHash);
      expect(ev.inputs.length, `${ev.name} input count`).to.equal(onChain!.inputs.length);

      for (let i = 0; i < ev.inputs.length; i++) {
        const a = ev.inputs[i], b = onChain!.inputs[i];
        expect(a.type, `${ev.name}.${b.name} type`).to.equal(b.type);
        // A fragment parsed from human-readable ABI reports null for non-indexed, while
        // the JSON artifact reports false — compare truthiness, not identity.
        expect(!!a.indexed, `${ev.name}.${b.name} indexed flag`).to.equal(!!b.indexed);
      }
    }
  });

  it("every SDK function selector exists on the contract with the same signature", function () {
    for (const fn of functionFragments(sdk.HALIAS_ABI)) {
      const onChain = contractIface.getFunction(fn.format("sighash"));
      expect(onChain, `contract has no function ${fn.format("sighash")}`).to.not.equal(null);
      expect(fn.selector, `${fn.name} selector`).to.equal(onChain!.selector);
      expect(
        fn.outputs.map(o => o.type).join(","),
        `${fn.name} return types`,
      ).to.equal(onChain!.outputs.map(o => o.type).join(","));
    }
  });

  it("decodes a real Transact log end to end", async function () {
    // The regression proper: emit a genuine event and decode it with the SDK's own ABI.
    const [deployer] = await ethers.getSigners();
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    const halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), deployer.address);

    const amount = ethers.parseEther("1");
    const enc0 = "0x" + "ab".repeat(40);
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);
    const c0 = ethers.keccak256("0x03"), c1 = ethers.keccak256("0x04");

    const receipt = await (await halias.transact({
      poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
      publicAmount: amount, tokenAddress: 0n,
      inputNullifiers: [ethers.keccak256("0x01"), ethers.keccak256("0x02")],
      outputCommitments: [c0, c1],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    }, enc0, "0x", proof, { value: amount })).wait();

    const sdkIface = new ethers.Interface(sdk.TRANSACT_ABI);
    const topic = sdkIface.getEvent("Transact")!.topicHash;
    const log = receipt!.logs.find(l => l.topics[0] === topic);
    expect(log, "SDK ABI did not match the emitted topic").to.not.equal(undefined);

    const parsed = sdkIface.parseLog({ topics: [...log!.topics], data: log!.data })!;
    // Reaching the last argument is the point — the old ABI died here.
    expect(parsed.args.publicAmount).to.equal(amount);
    expect(parsed.args.tokenAddress).to.equal(0n);
    expect(parsed.args.outputCommitment0).to.equal(c0);
    expect(parsed.args.outputCommitment1).to.equal(c1);
    expect(parsed.args.outputLeafIndex0).to.equal(0n);
    expect(parsed.args.outputLeafIndex1).to.equal(1n);
    expect(parsed.args.encryptedOutput0).to.equal(enc0);
    expect(parsed.args.encryptedOutput1).to.equal("0x");
  });

  // packRelayerFee is a cross-package byte layout: the SDK writes it, Halias reads it
  // back in _decodeRelayerFee. A disagreement pays the wrong address, or nobody, and
  // neither side can detect it alone.
  describe("relayer fee layout", function () {
    let halias: any;
    let relayer: any;

    beforeEach(async function () {
      const [deployer, r] = await ethers.getSigners();
      relayer = r;
      const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
      const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
      const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
      halias = await (await ethers.getContractFactory("Halias", {
        libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
      })).deploy(await mv.getAddress(), deployer.address);
    });

    it("the contract pays exactly the relayer and fee the SDK packed", async function () {
      const fee = ethers.parseEther("0.01");
      const externalData = sdk.packRelayerFee(relayer.address, fee);

      // Fund the pool so there is something to withdraw, then withdraw with the fee set.
      const deposit = ethers.parseEther("1");
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);
      const base = {
        poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
        tokenAddress: 0n, recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
        inputNullifiers: [ethers.keccak256("0xa1"), ethers.keccak256("0xa2")],
        outputCommitments: [ethers.keccak256("0xa3"), ethers.keccak256("0xa4")],
      };
      await (await halias.transact({ ...base, publicAmount: deposit }, "0x", "0x", proof,
        { value: deposit })).wait();

      const [, , dest] = await ethers.getSigners();
      const withdrawAmt = ethers.parseEther("0.5");
      const FIELD_PRIME_ = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const beforeRelayer = await ethers.provider.getBalance(relayer.address);
      const beforeDest    = await ethers.provider.getBalance(dest.address);

      await (await halias.transact({
        ...base,
        poolRoot: await halias.getLastRoot(),
        publicAmount: FIELD_PRIME_ - withdrawAmt,
        recipient: dest.address,
        externalData,
        inputNullifiers: [ethers.keccak256("0xb1"), ethers.keccak256("0xb2")],
        outputCommitments: [ethers.keccak256("0xb3"), ethers.keccak256("0xb4")],
      }, "0x", "0x", proof)).wait();

      expect(await ethers.provider.getBalance(relayer.address) - beforeRelayer).to.equal(fee);
      expect(await ethers.provider.getBalance(dest.address) - beforeDest).to.equal(withdrawAmt - fee);
    });

    it("a zero packing means no relayer is paid", async function () {
      expect(sdk.packRelayerFee(ethers.ZeroAddress, 0n)).to.equal(ethers.ZeroHash);
    });
  });
});
