// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MerkleTreeWithHistory.sol";
import "./base/SMTRegistry.sol";
import "./base/Constants.sol";
import "./interfaces/IHalias.sol";
import "./interfaces/ITransactVerifier.sol";
import {IEntryPoint, IEntryPointStake} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "poseidon-solidity/PoseidonT3.sol";
import "poseidon-solidity/PoseidonT4.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

// Construction
error InvalidVerifier();
error InvalidEntryPoint();

// Access
error NotAdmin();
error NotAliasOwner();
error NotPendingAdmin();

// Registration
error InvalidAliasHash();
error InvalidOwner();
error InvalidSpendingPubkey();
error InvalidNullifierKeyHash();
error InvalidEncryptionPubkey();
error PubkeyOutOfField();
error NullifierKeyHashOutOfField();
error AliasTaken();
error WrongRegistrationFee();

// Vouchers / pool-note registration
error VoucherInsufficientForFee();
error VoucherTooLarge();
error NotAWithdrawal();
error MustWithdrawToSelf();
error PoolNoteMustBeETH();

// Pool/Registry Roots
error PoolRootUnknown();
error RegistryRootNotCurrent();

// Transact
error Input0AlreadySpent();
error Input1AlreadySpent();
error DuplicateNullifier();
error WithdrawCannotHaveValue();
error NoDestination();
error WrongDepositValue();
error ERC20CannotHaveETH();
error FeeOnTransferToken();
error InvalidTokenAddress();
error TransferCannotHaveValue();
error InvalidProof();

// Admin
error InvalidAdmin();
error NoFeesToWithdraw();
error RescueExceedsAvailable();

// Pool
error DirectETHNotAllowed();

// ── Halias ────────────────────────────────────────────────────────────────────

contract Halias is MerkleTreeWithHistory, SMTRegistry, ReentrancyGuard, ERC721 {
    using Address for address payable;
    using SafeERC20 for IERC20;

    ITransactVerifier public immutable transactVerifier;
    IEntryPoint       public immutable entryPoint;
    address public admin;
    address public pendingAdmin;

    uint256 public constant GAS_RESERVE_BPS = 5000; // 50% of registration fee seeds EntryPoint

    struct AliasData {
        bytes32 spendingPubkey;
        bytes32 nullifierKeyHash;  // Poseidon(nullifierKey, 1) — raw key never stored; prevents nullifier enumeration
        bytes32 encryptionPubkey;
        bytes32 dataHash;          // attestations/reputation data commitment
        uint64  registeredAt;      // block.timestamp at registration
    }

    // tokenId = uint256(aliasHash); ERC-721 tracks ownership
    mapping(bytes32 => AliasData) public aliases;
    mapping(bytes32 => bool) public spentNullifiers;
    mapping(address => uint256) public poolTokenBalance; // ERC-20 pool collateral; guards rescueToken

    string private _baseTokenURI;

    uint256 public registrationFee = 0.002 ether;
    uint256 public constant MAX_VOUCHER_GAS_BUDGET = 0.01 ether;
    uint256 public accumulatedFees;

    // ── Events ─────────────────────────────────────────────────────────────────

    // registryLeafHash = Poseidon(spendingPubkey, nullifierKeyHash, dataHash).
    // nullifierKey is never emitted or stored raw — only its Poseidon hash is retained,
    // preventing observers from enumerating nullifiers to trace spending patterns.
    // spendingPubkey is emitted for off-chain indexers (already public in registry storage).
    event AliasRegistered(
        bytes32 indexed aliasHash,
        bytes32 spendingPubkey,
        bytes32 registryLeafHash,
        bytes32 encryptionPubkey
    );
    event KeysUpdated(
        bytes32 indexed aliasHash,
        bytes32 spendingPubkey,
        bytes32 registryLeafHash,
        bytes32 encryptionPubkey
    );
    event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 newDataHash, bytes32 newLeafHash);
    event AliasTransferred(
        bytes32 indexed aliasHash,
        address indexed previousOwner,
        address indexed newOwner,
        bytes32 newSpendingPubkey,
        bytes32 newRegistryLeafHash,
        bytes32 newEncryptionPubkey
    );
    event Transact(
        uint256 publicAmount,
        uint256 indexed tokenAddress,
        bytes32 indexed inputNullifier0,
        bytes32 indexed inputNullifier1,
        bytes32 outputCommitment0,
        bytes32 outputCommitment1,
        uint32 outputLeafIndex0,
        uint32 outputLeafIndex1,
        bytes encryptedOutput0,
        bytes encryptedOutput1
    );
    event Withdrawal(address indexed recipient, uint256 amount, uint256 indexed tokenAddress);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ── Logic ──────────────────────────────────────────────────────────────────

    constructor(address _transactVerifier, address _entryPoint) ERC721("Halias", "HLS") {
        if (_transactVerifier == address(0)) revert InvalidVerifier();
        if (_entryPoint == address(0))       revert InvalidEntryPoint();

        transactVerifier = ITransactVerifier(_transactVerifier);
        entryPoint = IEntryPoint(_entryPoint);
        admin = msg.sender;

        _initSMT();
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAliasOwner(bytes32 aliasHash) {
        if (ownerOf(uint256(aliasHash)) != msg.sender) revert NotAliasOwner();
        _;
    }

    // ── Registration ───────────────────────────────────────────────────────────

    function _doRegister(
        bytes32 aliasHash,
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,   // Poseidon(nullifierKey, 1) — pre-computed by caller; raw key never on-chain
        bytes32 encryptionPubkey
    ) internal {
        if (aliasHash        == bytes32(0)) revert InvalidAliasHash();
        if (spendingPubkey   == bytes32(0)) revert InvalidSpendingPubkey();
        if (nullifierKeyHash == bytes32(0)) revert InvalidNullifierKeyHash();
        if (encryptionPubkey == bytes32(0)) revert InvalidEncryptionPubkey();
        if (uint256(spendingPubkey)   >= FIELD_PRIME) revert PubkeyOutOfField();
        if (uint256(nullifierKeyHash) >= FIELD_PRIME) revert NullifierKeyHashOutOfField();
        if (_ownerOf(uint256(aliasHash)) != address(0)) revert AliasTaken();

        _mint(msg.sender, uint256(aliasHash));
        aliases[aliasHash] = AliasData(spendingPubkey, nullifierKeyHash, encryptionPubkey, bytes32(0), uint64(block.timestamp));

        bytes32 leaf = bytes32(PoseidonT4.hash([uint256(spendingPubkey), uint256(nullifierKeyHash), 0]));
        _smtUpdate(aliasHash, leaf);

        emit AliasRegistered(aliasHash, spendingPubkey, leaf, encryptionPubkey);
    }

    function register(
        bytes32 aliasHash,
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,   // Poseidon(nullifierKey, 1) — compute off-chain before calling
        bytes32 encryptionPubkey
    ) external payable nonReentrant {
        if (msg.value != registrationFee) revert WrongRegistrationFee();

        uint256 gasReserve = msg.value * GAS_RESERVE_BPS / 10000;
        accumulatedFees += msg.value - gasReserve;
        entryPoint.depositTo{value: gasReserve}(address(this));

        _doRegister(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey);
    }

    function updateKeys(
        bytes32 aliasHash,
        bytes32 newNullifierKeyHash,   // Poseidon(newNullifierKey, 1) — compute off-chain before calling
        bytes32 newEncryptionPubkey
    ) external onlyAliasOwner(aliasHash) {
        if (newNullifierKeyHash    == bytes32(0)) revert InvalidNullifierKeyHash();
        if (uint256(newNullifierKeyHash) >= FIELD_PRIME) revert NullifierKeyHashOutOfField();
        if (newEncryptionPubkey    == bytes32(0)) revert InvalidEncryptionPubkey();

        AliasData storage data = aliases[aliasHash];
        data.nullifierKeyHash = newNullifierKeyHash;
        data.encryptionPubkey = newEncryptionPubkey;

        bytes32 leaf = bytes32(PoseidonT4.hash([uint256(data.spendingPubkey), uint256(newNullifierKeyHash), uint256(data.dataHash)]));
        _smtUpdate(aliasHash, leaf);

        emit KeysUpdated(aliasHash, data.spendingPubkey, leaf, newEncryptionPubkey);
    }

    function updateAliasData(
        bytes32 aliasHash,
        bytes32 newDataHash
    ) external onlyAliasOwner(aliasHash) {
        _writeDataHash(aliasHash, newDataHash);
    }

    function _writeDataHash(bytes32 aliasHash, bytes32 newDataHash) internal {
        AliasData storage data = aliases[aliasHash];
        data.dataHash = newDataHash;
        bytes32 leaf = bytes32(PoseidonT4.hash([uint256(data.spendingPubkey), uint256(data.nullifierKeyHash), uint256(newDataHash)]));
        _smtUpdate(aliasHash, leaf);
        emit AliasDataUpdated(aliasHash, newDataHash, leaf);
    }

    function transferAliasWithKeys(
        bytes32 aliasHash,
        address newOwner,
        bytes32 newSpendingPubkey,
        bytes32 newNullifierKeyHash,   // Poseidon(newNullifierKey, 1) — compute off-chain before calling
        bytes32 newEncryptionPubkey
    ) external onlyAliasOwner(aliasHash) {
        if (newOwner              == address(0)) revert InvalidOwner();
        if (newSpendingPubkey     == bytes32(0)) revert InvalidSpendingPubkey();
        if (newNullifierKeyHash   == bytes32(0)) revert InvalidNullifierKeyHash();
        if (newEncryptionPubkey   == bytes32(0)) revert InvalidEncryptionPubkey();
        if (uint256(newSpendingPubkey)   >= FIELD_PRIME) revert PubkeyOutOfField();
        if (uint256(newNullifierKeyHash) >= FIELD_PRIME) revert NullifierKeyHashOutOfField();

        address prev = msg.sender;
        _transfer(prev, newOwner, uint256(aliasHash));

        AliasData storage data = aliases[aliasHash];
        data.spendingPubkey   = newSpendingPubkey;
        data.nullifierKeyHash = newNullifierKeyHash;
        data.encryptionPubkey = newEncryptionPubkey;
        data.dataHash         = bytes32(0); // reset reputation on transfer

        bytes32 leaf = bytes32(PoseidonT4.hash([uint256(newSpendingPubkey), uint256(newNullifierKeyHash), 0]));
        _smtUpdate(aliasHash, leaf);

        emit AliasTransferred(aliasHash, prev, newOwner, newSpendingPubkey, leaf, newEncryptionPubkey);
    }

    // ── Zero-ETH bootstrapping ────────────────────────────────────────────────
    //
    // Sponsor deposits a pool note via transact() assigned to a temp keypair, shares the
    // temp private data out-of-band. Recipient derives the keypair, generates a ZK proof,
    // and calls registerWithPoolNote() to atomically spend the note and register.
    // MAX_VOUCHER_GAS_BUDGET scopes this path to bootstrapping; larger notes use change outputs.
    function registerWithPoolNote(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof,
        bytes32 aliasHash,
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey
    ) external nonReentrant {
        if (p.tokenAddress != 0)                                      revert PoolNoteMustBeETH();
        if (p.publicAmount < (FIELD_PRIME - MAX_ABS_AMOUNT))         revert NotAWithdrawal();
        uint256 absAmount = FIELD_PRIME - p.publicAmount;
        if (absAmount < registrationFee)                              revert VoucherInsufficientForFee();
        if (absAmount > registrationFee + MAX_VOUCHER_GAS_BUDGET)    revert VoucherTooLarge();
        if (p.recipient != address(this))                             revert MustWithdrawToSelf();

        // Spend the pool note; ETH stays in Halias (recipient = address(this) skips sendValue)
        _transactCore(p, encryptedOutput0, encryptedOutput1, proof);

        accumulatedFees += absAmount;

        _doRegister(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey);
    }

    // ── Transact ───────────────────────────────────────────────────────────────

    function _computeParamsHash(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1
    ) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(
            block.chainid,
            address(this),
            p.recipient,
            encryptedOutput0,
            encryptedOutput1,
            p.externalData
        ))) % FIELD_PRIME;
    }

    function computeParamsHash(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1
    ) external view returns (uint256) {
        return _computeParamsHash(p, encryptedOutput0, encryptedOutput1);
    }

    function _verifyTransact(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) internal view {
        uint256 paramsHash = _computeParamsHash(p, encryptedOutput0, encryptedOutput1);

        uint256[9] memory pubSignals;
        pubSignals[0] = uint256(p.poolRoot);
        pubSignals[1] = uint256(p.registryRoot);
        pubSignals[2] = p.publicAmount;
        pubSignals[3] = p.tokenAddress;
        pubSignals[4] = paramsHash;
        pubSignals[5] = uint256(p.inputNullifiers[0]);
        pubSignals[6] = uint256(p.inputNullifiers[1]);
        pubSignals[7] = uint256(p.outputCommitments[0]);
        pubSignals[8] = uint256(p.outputCommitments[1]);

        (uint[2] memory pA, uint[2][2] memory pB, uint[2] memory pC) =
            abi.decode(proof, (uint[2], uint[2][2], uint[2]));

        if (!transactVerifier.verifyProof(pA, pB, pC, pubSignals)) revert InvalidProof();
    }

    function transact(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) external payable nonReentrant {
        _transactCore(p, encryptedOutput0, encryptedOutput1, proof);
    }

    function _transactCore(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) internal {
        // Nullifier checks first: cheapest possible revert for front-run victims.
        if (spentNullifiers[p.inputNullifiers[0]])                    revert Input0AlreadySpent();
        if (spentNullifiers[p.inputNullifiers[1]])                    revert Input1AlreadySpent();
        if (p.inputNullifiers[0] == p.inputNullifiers[1])             revert DuplicateNullifier();
        if (!isKnownPoolRoot(p.poolRoot))                             revert PoolRootUnknown();
        if (!isKnownRegistryRoot(p.registryRoot))                     revert RegistryRootNotCurrent();

        _processPayment(p);

        _verifyTransact(p, encryptedOutput0, encryptedOutput1, proof);

        spentNullifiers[p.inputNullifiers[0]] = true;
        spentNullifiers[p.inputNullifiers[1]] = true;

        uint32 idx0 = _insert(p.outputCommitments[0]);
        uint32 idx1 = _insert(p.outputCommitments[1]);

        emit Transact(
            p.publicAmount, p.tokenAddress,
            p.inputNullifiers[0], p.inputNullifiers[1],
            p.outputCommitments[0], p.outputCommitments[1],
            idx0, idx1,
            encryptedOutput0, encryptedOutput1
        );
    }

    function _processPayment(TransactParams calldata p) internal {
        bool isWithdraw = p.publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        uint256 absAmount = isWithdraw ? (FIELD_PRIME - p.publicAmount) : p.publicAmount;

        if (p.tokenAddress == 0) {
            if (isWithdraw) {
                if (msg.value != 0) revert WithdrawCannotHaveValue();
                if (p.recipient == address(0)) revert NoDestination();
                // recipient == address(this): ETH stays in contract for paymaster gas — no transfer needed
                if (p.recipient != address(this)) {
                    payable(p.recipient).sendValue(absAmount);
                    emit Withdrawal(p.recipient, absAmount, 0);
                }
            } else {
                if (p.publicAmount > 0) {
                    if (msg.value != p.publicAmount) revert WrongDepositValue();
                } else {
                    if (msg.value != 0) revert TransferCannotHaveValue();
                }
            }
        } else {
            if (msg.value != 0) revert ERC20CannotHaveETH();
            address token = address(uint160(p.tokenAddress));
            if (token.code.length == 0) revert InvalidTokenAddress();
            if (isWithdraw) {
                if (p.recipient == address(0)) revert NoDestination();
                poolTokenBalance[token] -= absAmount;
                IERC20(token).safeTransfer(p.recipient, absAmount);
                emit Withdrawal(p.recipient, absAmount, p.tokenAddress);
            } else if (p.publicAmount > 0) {
                uint256 balBefore = IERC20(token).balanceOf(address(this));
                IERC20(token).safeTransferFrom(msg.sender, address(this), p.publicAmount);
                if (IERC20(token).balanceOf(address(this)) < balBefore + p.publicAmount) revert FeeOnTransferToken();
                poolTokenBalance[token] += p.publicAmount;
            }
        }
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setRegistrationFee(uint256 _fee) external onlyAdmin {
        emit FeeUpdated(registrationFee, _fee);
        registrationFee = _fee;
    }

    function setBaseTokenURI(string memory baseURI) external onlyAdmin {
        _baseTokenURI = baseURI;
    }

    function withdrawFees(address payable to, uint256 amount) external onlyAdmin {
        if (amount > accumulatedFees) revert NoFeesToWithdraw();
        accumulatedFees -= amount;
        to.sendValue(amount);
        emit FeesWithdrawn(to, amount);
    }

    function withdrawEntryPointDeposit(address payable to, uint256 amount) external onlyAdmin {
        entryPoint.withdrawTo(to, amount);
    }

    // IEntryPointStake wrappers — stakes Halias so HaliasPaymaster can read
    // halias.registrationFee() during validatePaymasterUserOp (ERC-7562: a staked
    // contract's storage may be read by other entities).
    function addStake(uint32 unstakeDelaySec) external payable onlyAdmin {
        IEntryPointStake(address(entryPoint)).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyAdmin {
        IEntryPointStake(address(entryPoint)).unlockStake();
    }

    function withdrawStake(address payable to) external onlyAdmin {
        IEntryPointStake(address(entryPoint)).withdrawStake(to);
    }

    // Recover ERC-20 tokens sent directly to this contract via token.transfer() rather
    // than through transact(). The ERC-20 spec gives recipients no way to reject a push
    // transfer, so accidental or mistaken sends cannot be prevented on-chain.
    // poolTokenBalance tracks the pool's exact ERC-20 liability (sum of all outstanding
    // notes for this token), so only the surplus above that is rescuable — pool
    // collateral is never at risk.
    function rescueToken(address token, address to, uint256 amount) external onlyAdmin {
        uint256 available = IERC20(token).balanceOf(address(this)) - poolTokenBalance[token];
        if (amount > available) revert RescueExceedsAvailable();
        IERC20(token).safeTransfer(to, amount);
    }

    function transferAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidAdmin();
        pendingAdmin = _admin;
        emit AdminTransferInitiated(admin, _admin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address old = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(old, admin);
    }

    function transferFrom(address, address, uint256) public pure override {
        revert("use transferAliasWithKeys");
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert("use transferAliasWithKeys");
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // Only the EntryPoint may push ETH directly (EP returns ETH via withdrawTo in some paths).
    // Pool ETH arrives through transact(), which is payable.
    receive() external payable {
        if (msg.sender != address(entryPoint)) revert DirectETHNotAllowed();
    }
}
