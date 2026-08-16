import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Halias stack on Sepolia with account:", deployer.address);

  // Canonical EntryPoint v0.7 address on Sepolia
  const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

  // 1. Deploy Libraries
  console.log("Deploying Poseidon libraries...");
  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const poseidonT3 = await PoseidonT3.deploy();
  await poseidonT3.waitForDeployment();

  const PoseidonT4 = await ethers.getContractFactory("PoseidonT4");
  const poseidonT4 = await PoseidonT4.deploy();
  await poseidonT4.waitForDeployment();

  // 2. Deploy Verifier
  console.log("Deploying TransactVerifier...");
  const TransactVerifier = await ethers.getContractFactory("TransactVerifier");
  const verifier = await TransactVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("Verifier deployed to:", verifierAddress);

  // 3. Deploy Halias
  console.log("Deploying Halias...");
  const Halias = await ethers.getContractFactory("Halias", {
    libraries: {
      PoseidonT3: await poseidonT3.getAddress(),
      PoseidonT4: await poseidonT4.getAddress(),
    },
  });
  const halias = await Halias.deploy(verifierAddress, ENTRY_POINT);
  await halias.waitForDeployment();
  const haliasAddress = await halias.getAddress();
  console.log("Halias deployed to:", haliasAddress);

  // 4. Deploy Paymaster
  console.log("Deploying HaliasPaymaster...");
  const Paymaster = await ethers.getContractFactory("HaliasPaymaster");
  // Relayer = address(0) for testing (decentralized voucher path)
  const paymaster = await Paymaster.deploy(ENTRY_POINT, ethers.ZeroAddress, haliasAddress);
  await paymaster.waitForDeployment();
  const paymasterAddress = await paymaster.getAddress();
  console.log("Paymaster deployed to:", paymasterAddress);

  // 5. Link Paymaster to Halias
  console.log("Linking Paymaster to Halias...");
  await halias.setPaymaster(paymasterAddress);

  // 6. Stake the Paymaster (REQUIRED for global state access in ERC-4337)
  console.log("Staking Paymaster in EntryPoint...");
  // Stake 0.1 ETH with a 1-day unstake delay
  const stakeTx = await paymaster.addStakeToEntryPoint(86400, { value: ethers.parseEther("0.1") });
  await stakeTx.wait();
  console.log("Paymaster staked successfully.");

  // 7. Initial gas deposit directly from deployer
  console.log("Depositing initial gas for Paymaster...");
  const entryPoint = await ethers.getContractAt("IEntryPoint", ENTRY_POINT);
  const depositTx = await entryPoint.depositTo(paymasterAddress, { value: ethers.parseEther("0.1") });
  await depositTx.wait();
  console.log("Paymaster gas deposit complete.");

  console.log("\n=== Deployment Complete ===");
  console.log("Halias:", haliasAddress);
  console.log("Paymaster:", paymasterAddress);
  console.log("Verifier:", verifierAddress);
  console.log("EntryPoint:", ENTRY_POINT);
  console.log("\nReady for Immaculate Onboarding tests!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
