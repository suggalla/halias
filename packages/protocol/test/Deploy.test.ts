import { expect } from "chai";
import { ethers } from "hardhat";
import { buildHaliasInitCode, predictCreate2Address } from "../scripts/haliasInitCode";

// The deploy path had no tests, and produced the two worst bugs of the day: a
// types/values mismatch in the constructor encoding, and admin being set to the CREATE2
// factory rather than the deployer — the latter shipped to Sepolia and permanently
// stranded every admin function on that deployment.
//
// Nothing here mocks the deployment. It builds the same init code deploy.ts builds and
// puts it through the same Create2Factory, so an encoding or constructor change that
// would break a real deploy breaks this first.
describe("CREATE2 deployment", function () {
  this.timeout(180000);

  let poseidonT3: string, poseidonT4: string, verifier: string, factory: any;
  let deployer: any, other: any;

  beforeEach(async function () {
    [deployer, other] = await ethers.getSigners();
    poseidonT3 = await (await (await ethers.getContractFactory("PoseidonT3")).deploy()).getAddress();
    poseidonT4 = await (await (await ethers.getContractFactory("PoseidonT4")).deploy()).getAddress();
    verifier   = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();
    factory    = await (await ethers.getContractFactory("Create2Factory")).deploy();
  });

  async function deployVia(salt: string, admin: string) {
    const { initCode, initCodeHash } = await buildHaliasInitCode({
      poseidonT3, poseidonT4, transactVerifier: verifier, admin,
    });
    const predicted = predictCreate2Address(await factory.getAddress(), salt, initCodeHash);
    await (await factory.deploy(initCode, salt)).wait();
    return { predicted, halias: await ethers.getContractAt("Halias", predicted) };
  }

  it("lands at the predicted address", async function () {
    // If the constructor encoding is wrong, initCodeHash changes and the contract
    // appears somewhere nobody computed — which is also how a mined vanity salt silently
    // stops matching.
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { predicted } = await deployVia(salt, deployer.address);
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
  });

  it("off-chain prediction matches the factory's own computeAddress", async function () {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { initCode, initCodeHash } = await buildHaliasInitCode({
      poseidonT3, poseidonT4, transactVerifier: verifier, admin: deployer.address,
    });
    expect(predictCreate2Address(await factory.getAddress(), salt, initCodeHash))
      .to.equal(await factory.computeAddress(initCode, salt));
  });

  it("sets admin to the passed address, not the factory", async function () {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { halias } = await deployVia(salt, deployer.address);
    expect(await halias.admin()).to.equal(deployer.address);
    expect(await halias.admin()).to.not.equal(await factory.getAddress());
  });

  it("leaves the admin functions genuinely callable after a CREATE2 deploy", async function () {
    // The real failure was not a wrong storage slot, it was that nothing could ever call
    // these again. Assert reachability, not just the value.
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { halias } = await deployVia(salt, deployer.address);

    await expect(halias.setRegistrationFee(ethers.parseEther("0.005"))).to.not.be.reverted;
    expect(await halias.registrationFee()).to.equal(ethers.parseEther("0.005"));
    await expect(halias.setBaseTokenURI("https://x/")).to.not.be.reverted;
    await expect(halias.transferAdmin(other.address)).to.not.be.reverted;
    await expect(halias.connect(other).acceptAdmin()).to.not.be.reverted;
    expect(await halias.admin()).to.equal(other.address);
  });

  it("can name an admin other than the deployer", async function () {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { halias } = await deployVia(salt, other.address);
    expect(await halias.admin()).to.equal(other.address);
    await expect(halias.setRegistrationFee(1n)).to.be.revertedWithCustomError(halias, "NotAdmin");
    await expect(halias.connect(other).setRegistrationFee(1n)).to.not.be.reverted;
  });

  it("is deployable and usable end to end at the CREATE2 address", async function () {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const { halias } = await deployVia(salt, deployer.address);

    // Libraries linked, SMT initialised, and a registration actually works.
    expect(await halias.LEVELS()).to.equal(32n);
    expect(await halias.REGISTRY_LEVELS()).to.equal(64n);
    expect(await halias.getRegistryRoot()).to.not.equal(ethers.ZeroHash);

    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await expect(halias.register(
      aliasHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32),
      ethers.keccak256(ethers.randomBytes(32)),
      { value: await halias.registrationFee() },
    )).to.not.be.reverted;
    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(deployer.address);
  });

  it("a different salt gives a different address, same code", async function () {
    const a = await deployVia(ethers.hexlify(ethers.randomBytes(32)), deployer.address);
    const b = await deployVia(ethers.hexlify(ethers.randomBytes(32)), deployer.address);
    expect(a.predicted).to.not.equal(b.predicted);
    expect(await ethers.provider.getCode(a.predicted))
      .to.equal(await ethers.provider.getCode(b.predicted));
  });

  it("changing a constructor argument changes the init code hash", async function () {
    // The property a vanity salt depends on: re-deploying against a different verifier
    // or admin must invalidate a previously mined salt rather than silently reuse it.
    const base = { poseidonT3, poseidonT4, transactVerifier: verifier, admin: deployer.address };
    const h1 = (await buildHaliasInitCode(base)).initCodeHash;
    const h2 = (await buildHaliasInitCode({ ...base, admin: other.address })).initCodeHash;
    expect(h1).to.not.equal(h2);
  });
});
