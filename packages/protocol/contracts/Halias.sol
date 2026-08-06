// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MerkleTreeWithHistory.sol";
import "./base/SMTRegistry.sol";
import "./base/Constants.sol";
import "./interfaces/IHalias.sol";
import "./interfaces/ITransactVerifier.sol";
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

// Pool-note registration (invite claim)
error PoolNoteWrongFee();
error NotAWithdrawal();
error MustWithdrawToSelf();
error PoolNoteMustBeETH();
error RetainRequiresRegistration();

// Relayer fee
error RelayerFeeExceedsWithdrawal();
error RelayerFeeOnNonWithdrawal();
error RelayerCannotBePool();

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

// ERC-721 surface
error UseTransferAliasWithKeys();
error AliasApprovalsDisabled();

// ── Halias ────────────────────────────────────────────────────────────────────

contract Halias is MerkleTreeWithHistory, SMTRegistry, ReentrancyGuard, ERC721 {
    using Address for address payable;
    using SafeERC20 for IERC20;

    ITransactVerifier public immutable transactVerifier;
    address public admin;
    address public pendingAdmin;

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
    event RelayerPaid(address indexed relayer, uint256 fee);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ── Logic ──────────────────────────────────────────────────────────────────

    constructor(address _transactVerifier) ERC721("Halias", "HLS") {
        if (_transactVerifier == address(0)) revert InvalidVerifier();

        transactVerifier = ITransactVerifier(_transactVerifier);
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

        accumulatedFees += msg.value;

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

    // ── Invite claim: register paying the fee from shielded funds ─────────────
    //
    // The inviter funds a pool note held by a temp keypair derived from the invite
    // secret and shares that secret out-of-band. The claimer derives the keypair and
    // calls this to register a name in one transaction, paying registrationFee out of
    // the note rather than from their own balance. They still pay their own gas.
    //
    // Ordering matters: _doRegister runs FIRST so the claimer's own registry leaf is in
    // the tree before the proof is checked. The change output is a note addressed to the
    // freshly registered alias, and the circuit enforces registry membership for every
    // non-zero output — so it must prove against the POST-registration root. _smtUpdate
    // pushes that root into smtRoots immediately, so isKnownRegistryRoot accepts it.
    // The claimer computes it off-chain from the current tree plus their own leaf.
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
        if (p.tokenAddress != 0)                              revert PoolNoteMustBeETH();
        (bool isWithdraw, uint256 absAmount) = _payment(p.publicAmount);
        if (!isWithdraw)                                      revert NotAWithdrawal();
        if (p.recipient != address(this))                     revert MustWithdrawToSelf();

        // The note covers the registration fee plus, optionally, a relayer's gas. Anything
        // beyond that belongs in a change output under the claimer's own keys rather than
        // stranded in the contract, so the total must be exact.
        (address relayer, uint256 relayerFee) = _decodeRelayerFee(p.externalData);
        if (relayerFee > 0 && relayer == address(0))          revert NoDestination();
        if (relayerFee > 0 && relayer == address(this))       revert RelayerCannotBePool();
        if (absAmount != registrationFee + relayerFee)        revert PoolNoteWrongFee();

        _doRegister(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey);

        // Spend the pool note. recipient == address(this) retains the ETH here rather than
        // sending it out, so this function is responsible for splitting it.
        _transactCore(p, encryptedOutput0, encryptedOutput1, proof, true);

        accumulatedFees += registrationFee;

        // Paying the submitter out of the note is what lets a claimer with zero ETH be
        // registered by a third party — no paymaster, no sponsor, no deposit anywhere.
        if (relayerFee > 0) {
            payable(relayer).sendValue(relayerFee);
            emit RelayerPaid(relayer, relayerFee);
        }
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
        _transactCore(p, encryptedOutput0, encryptedOutput1, proof, false);
    }

    // retainToSelf is true only for registerWithPoolNote, the one path where a withdrawal
    // legitimately keeps its ETH inside the contract. Through transact() that would burn a
    // note and credit nothing — accumulatedFees is untouched and there is no ETH rescue
    // path, so the funds would be unrecoverable.
    function _transactCore(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof,
        bool retainToSelf
    ) internal {
        // Checks — nullifiers first: cheapest possible revert for front-run victims.
        if (spentNullifiers[p.inputNullifiers[0]])                    revert Input0AlreadySpent();
        if (spentNullifiers[p.inputNullifiers[1]])                    revert Input1AlreadySpent();
        if (p.inputNullifiers[0] == p.inputNullifiers[1])             revert DuplicateNullifier();
        if (!isKnownPoolRoot(p.poolRoot))                             revert PoolRootUnknown();
        if (!isKnownRegistryRoot(p.registryRoot))                     revert RegistryRootNotCurrent();

        _checkPayment(p, retainToSelf);
        _verifyTransact(p, encryptedOutput0, encryptedOutput1, proof);

        // Effects — spend inputs and insert outputs before any external transfer.
        spentNullifiers[p.inputNullifiers[0]] = true;
        spentNullifiers[p.inputNullifiers[1]] = true;

        uint32 idx0 = _insert(p.outputCommitments[0]);
        uint32 idx1 = _insert(p.outputCommitments[1]);
        // One publish for both inserts — the intermediate root is never observable.
        _commitPoolRoot();

        // Interactions — ETH/token movement last (CEI: safe independent of nonReentrant).
        _settlePayment(p);

        emit Transact(
            p.publicAmount, p.tokenAddress,
            p.inputNullifiers[0], p.inputNullifiers[1],
            p.outputCommitments[0], p.outputCommitments[1],
            idx0, idx1,
            encryptedOutput0, encryptedOutput1
        );
    }

    // Optional relayer fee, packed into externalData:
    //   [0:20]  relayer address   (high 160 bits)
    //   [20:32] fee in wei        (low 96 bits — 7.9e10 ETH, far above any real fee)
    // externalData is committed inside paramsHash, so the prover fixes both the relayer and
    // the fee. A relayer can only choose to submit or not; it cannot alter the destination,
    // the amount, or its own cut, so submitting is trustless in both directions. This lets a
    // user with zero ETH pay for inclusion out of their own shielded funds, with no sponsor.
    // Zero means no relayer, which is the ordinary self-submitted path.
    function _decodeRelayerFee(bytes32 externalData)
        internal pure returns (address relayer, uint256 fee)
    {
        relayer = address(uint160(uint256(externalData) >> 96));
        fee     = uint256(uint96(uint256(externalData)));
    }

    // publicAmount is signed in the field: positive is a deposit, "negative"
    // (p - amount) a withdrawal. Validation and settlement both need the sign and the
    // magnitude, and they must never disagree, so the derivation lives in one place.
    function _payment(uint256 publicAmount)
        internal pure returns (bool isWithdraw, uint256 absAmount)
    {
        isWithdraw = publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        absAmount  = isWithdraw ? FIELD_PRIME - publicAmount : publicAmount;
    }

    function _token(TransactParams calldata p) internal pure returns (address) {
        return address(uint160(p.tokenAddress));
    }

    // Cheap input validation — msg.value, destination, token sanity. Pure checks, no
    // state mutation or external calls, so it runs early (fail-fast, before the proof).
    function _checkPayment(TransactParams calldata p, bool retainToSelf) internal view {
        (bool isWithdraw, uint256 absAmount) = _payment(p.publicAmount);

        if (p.recipient == address(this) && !retainToSelf) revert RetainRequiresRegistration();

        if (p.externalData != bytes32(0)) {
            // A fee is paid out of the ETH leaving the pool, so it only exists on an ETH
            // withdrawal. On a transfer or deposit there is no outflow to pay it from.
            if (!isWithdraw || p.tokenAddress != 0)   revert RelayerFeeOnNonWithdrawal();
            (address relayer, uint256 fee) = _decodeRelayerFee(p.externalData);
            // Paying the pool itself would send ETH that no accounting entry covers — it is
            // neither collateral nor fees, so it would be stranded. receive() would reject
            // it anyway; rejecting here names the actual problem.
            if (fee > 0 && relayer == address(0))     revert NoDestination();
            if (fee > 0 && relayer == address(this))  revert RelayerCannotBePool();
            // No cap beyond the outflow itself: the fee is committed in paramsHash, so it is
            // the prover's own authorised figure, not something a submitter can inflate.
            if (fee > absAmount)                      revert RelayerFeeExceedsWithdrawal();
        }

        if (p.tokenAddress == 0) {
            if (isWithdraw) {
                if (msg.value != 0) revert WithdrawCannotHaveValue();
                if (p.recipient == address(0)) revert NoDestination();
            } else {
                if (p.publicAmount > 0) {
                    if (msg.value != p.publicAmount) revert WrongDepositValue();
                } else {
                    if (msg.value != 0) revert TransferCannotHaveValue();
                }
            }
        } else {
            if (msg.value != 0) revert ERC20CannotHaveETH();
            if (_token(p).code.length == 0) revert InvalidTokenAddress();
            if (isWithdraw && p.recipient == address(0)) revert NoDestination();
        }
    }

    // Balance effects + external transfers — runs last (CEI), after inputs are spent
    // and outputs inserted, so settlement is safe independent of the nonReentrant guard.
    function _settlePayment(TransactParams calldata p) internal {
        (bool isWithdraw, uint256 absAmount) = _payment(p.publicAmount);

        if (p.tokenAddress == 0) {
            // recipient == address(this): registerWithPoolNote retains the ETH, which that
            // function books into accumulatedFees — no transfer here.
            // Deposit: ETH already arrived with msg.value (validated in _checkPayment) — nothing to move.
            if (isWithdraw && p.recipient != address(this)) {
                // Invariant: fee + payout == absAmount. fee <= absAmount by _checkPayment.
                uint256 payout = absAmount;
                if (p.externalData != bytes32(0)) {
                    (address relayer, uint256 fee) = _decodeRelayerFee(p.externalData);
                    if (fee > 0) {
                        payout -= fee;
                        payable(relayer).sendValue(fee);
                        emit RelayerPaid(relayer, fee);
                    }
                }
                // A withdrawal may be entirely consumed by the fee — that is the shape of a
                // claimer's first transaction, where the change output holds the balance.
                if (payout > 0) payable(p.recipient).sendValue(payout);
                emit Withdrawal(p.recipient, payout, 0);
            }
        } else {
            address token = _token(p);
            if (isWithdraw) {
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

    // ── ERC-721 surface ────────────────────────────────────────────────────────
    //
    // An alias is a token so wallets and explorers can display it, but it is not a
    // tradeable one. A bare ERC-721 transfer would move ownership while leaving the
    // registry leaf — and therefore the spending keys — untouched, so the previous owner
    // could still spend notes sent to the alias afterwards. transferAliasWithKeys exists
    // precisely to move ownership and rotate keys in one step.
    //
    // The approval calls are disabled for the same reason. With transfers blocked they
    // could never authorise anything, so leaving them live would only offer a surface for
    // sites to farm meaningless alias approvals and habituate users to signing them.
    //
    // safeTransferFrom(from, to, id) delegates to the 4-argument overload below, so both
    // transfer entry points are covered.

    function transferFrom(address, address, uint256) public pure override {
        revert UseTransferAliasWithKeys();
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert UseTransferAliasWithKeys();
    }

    function approve(address, uint256) public pure override {
        revert AliasApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert AliasApprovalsDisabled();
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // Pool ETH arrives through transact(), which is payable, and registration fees through
    // register(). Nothing else should push ETH here: untracked ETH is neither pool
    // collateral nor withdrawable fees, so it would be permanently stranded.
    receive() external payable {
        revert DirectETHNotAllowed();
    }
}
