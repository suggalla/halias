Multiple frameworks detected: Foundry, Hardhat. Using Foundry (highest priority). Use --compile-force-framework to override.
'forge clean' running (wd: /mnt/e/Github/halias)
'forge config --json' running
'forge build --build-info packages/protocol' running (wd: /mnt/e/Github/halias)
**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [incorrect-exp](#incorrect-exp) (2 results) (High)
 - [incorrect-equality](#incorrect-equality) (1 results) (Medium)
 - [locked-ether](#locked-ether) (1 results) (Medium)
 - [events-maths](#events-maths) (1 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (1 results) (Low)
 - [timestamp](#timestamp) (5 results) (Low)
## incorrect-exp
Impact: High
Confidence: Medium
 - [ ] ID-0
[SMTRegistry._smtUpdate(bytes32,bytes32)](packages/protocol/contracts/base/SMTRegistry.sol#L92-L135) has bitwise-xor operator ^ instead of the exponentiation operator **: 
	 - [siblingPath = nodePath ^ 1](packages/protocol/contracts/base/SMTRegistry.sol#L112)

packages/protocol/contracts/base/SMTRegistry.sol#L92-L135


 - [ ] ID-1
[SMTRegistry.getSmtSiblings(uint256)](packages/protocol/contracts/base/SMTRegistry.sol#L149-L155) has bitwise-xor operator ^ instead of the exponentiation operator **: 
	 - [siblingPath = (pathKey >> i) ^ 1](packages/protocol/contracts/base/SMTRegistry.sol#L151)

packages/protocol/contracts/base/SMTRegistry.sol#L149-L155


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-2
[SMTRegistry.isKnownRegistryRoot(bytes32)](packages/protocol/contracts/base/SMTRegistry.sol#L137-L145) uses a dangerous strict equality:
	- [seen == 0](packages/protocol/contracts/base/SMTRegistry.sol#L143)

packages/protocol/contracts/base/SMTRegistry.sol#L137-L145


## locked-ether
Impact: Medium
Confidence: High
 - [ ] ID-3
Contract locking ether found:
	Contract [Create2Factory](packages/protocol/contracts/Create2Factory.sol#L2-L19) has payable functions:
	 - [Create2Factory.deploy(bytes,bytes32)](packages/protocol/contracts/Create2Factory.sol#L6-L12)
	But does not have a function to withdraw the ether

packages/protocol/contracts/Create2Factory.sol#L2-L19


## events-maths
Impact: Low
Confidence: Medium
 - [ ] ID-4
[HaliasDomain.register(bytes32,bytes32,bytes32,bytes32,string,bytes32)](packages/protocol/contracts/HaliasDomain.sol#L273-L303) should emit an event for: 
	- [accumulatedFees += msg.value](packages/protocol/contracts/HaliasDomain.sol#L294) 

packages/protocol/contracts/HaliasDomain.sol#L273-L303


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-5
Reentrancy in [HaliasDomain.claim(HaliasDomain.Registration,TransactParams,bytes,bytes,bytes,string)](packages/protocol/contracts/HaliasDomain.sol#L329-L359):
	External calls:
	- [_record(r,name)](packages/protocol/contracts/HaliasDomain.sol#L342)
		- [registry.register(r.aliasHash,r.spendingPubkey,r.nullifierKeyHash,r.encryptionPubkey)](packages/protocol/contracts/HaliasDomain.sol#L367)
	- [registry.armPendingLeaf(r.aliasHash)](packages/protocol/contracts/HaliasDomain.sol#L343)
	- [pool.transact(p,encryptedOutput0,encryptedOutput1,proof)](packages/protocol/contracts/HaliasDomain.sol#L349)
	- [registry.clearPendingLeaf()](packages/protocol/contracts/HaliasDomain.sol#L351)
	State variables written after the call(s):
	- [accumulatedFees += received](packages/protocol/contracts/HaliasDomain.sol#L356)

packages/protocol/contracts/HaliasDomain.sol#L329-L359


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-6
[SMTRegistry.isKnownRegistryRoot(bytes32)](packages/protocol/contracts/base/SMTRegistry.sol#L137-L145) uses timestamp for comparisons
	Dangerous comparisons:
	- [seen == 0](packages/protocol/contracts/base/SMTRegistry.sol#L143)
	- [block.timestamp - seen <= REGISTRY_ROOT_MAX_AGE](packages/protocol/contracts/base/SMTRegistry.sol#L144)

packages/protocol/contracts/base/SMTRegistry.sol#L137-L145


 - [ ] ID-7
[HaliasDomain.register(bytes32,bytes32,bytes32,bytes32,string,bytes32)](packages/protocol/contracts/HaliasDomain.sol#L273-L303) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > _commitTime(madeAt) + MAX_COMMIT_AGE](packages/protocol/contracts/HaliasDomain.sol#L289)

packages/protocol/contracts/HaliasDomain.sol#L273-L303


 - [ ] ID-8
[HaliasDomain.acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes)](packages/protocol/contracts/HaliasDomain.sol#L479-L506) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > deadline](packages/protocol/contracts/HaliasDomain.sol#L489)

packages/protocol/contracts/HaliasDomain.sol#L479-L506


 - [ ] ID-9
[HaliasDomain.commit(bytes32)](packages/protocol/contracts/HaliasDomain.sol#L239-L247) uses timestamp for comparisons
	Dangerous comparisons:
	- [prev != 0 && block.timestamp <= _commitTime(prev) + MAX_COMMIT_AGE](packages/protocol/contracts/HaliasDomain.sol#L241)

packages/protocol/contracts/HaliasDomain.sol#L239-L247


 - [ ] ID-10
[HaliasDomain._authorizeOwner(bytes32,bytes32,uint256,bytes)](packages/protocol/contracts/HaliasDomain.sol#L183-L207) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > deadline](packages/protocol/contracts/HaliasDomain.sol#L197)

packages/protocol/contracts/HaliasDomain.sol#L183-L207


