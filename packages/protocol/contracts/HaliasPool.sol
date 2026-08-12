// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MerkleTreeWithHistory.sol";
import "./base/Constants.sol";
import "./interfaces/IHaliasPool.sol";
import "./interfaces/IHaliasRegistry.sol";
import "./interfaces/ITransactVerifier.sol";
// SafeERC20 brings IERC20 with it; importing both only duplicates the symbol.
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

// Construction
error ZeroAddress();

// Relayer fee
error RelayerFeeExceedsWithdrawal();
error RelayerFeeRequiresWithdrawal();

// Roots
error PoolRootUnknown();
error PoolRootWrongTree();
error RegistryRootNotCurrent();
error PendingLeafNotArmed();

// Transact
error NullifierAlreadySpent(bytes32 nullifier);
error DuplicateNullifier();
error WrongMsgValue(uint256 expected, uint256 actual);
error InvalidTokenAddress();
error FeeOnTransferToken();
error InvalidProof();

// Settlement
error BadPayee();
error PoolBalanceExceeded();

// Pool
error DirectETHNotAllowed();

/// @title  HaliasPool — the shielded pool
/// @notice Holds every note commitment, every nullifier, and custody of every asset in
///         the system. Deposits, transfers, and withdrawals are one proof shape;
///         `publicAmount`'s sign is what distinguishes them.
/// @dev    There is no admin, no owner, and no upgrade path. Once deployed, the only way
///         value moves is a valid Groth16 proof — there is no key that can pause, drain,
///         redirect, or rescue, including for the deployer. That is load-bearing rather
///         than stylistic, and every design choice here defers to it.
///
///         The registry lives in a separate contract and is referenced read-only. The
///         circuit proves registry membership for every non-zero output — "you can only
///         send to a registered alias" — so the pool must confirm the proven root was
///         really published. It never calls anything that mutates registry state.
///
///         Registration is not this contract's concern. A claimer registering a name out
///         of a funded note is, from here, an ordinary withdrawal whose payout is entirely
///         consumed by the relayer fee; the domain contract handles naming and calls
///         {transact} afterwards, once its new root is live.
contract HaliasPool is MerkleTreeWithHistory, ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;

    /// @notice Groth16 verifier for the transact circuit.
    ITransactVerifier public immutable transactVerifier;

    /// @notice Registry whose published roots outputs are proven against.
    /// @dev    Immutable and admin-less by construction, so it is trusted for the root
    ///         read in {transact}. `nonReentrant` covers it regardless.
    IHaliasRegistry public immutable registry;

    /// @notice Nullifiers already spent. A note is spendable exactly once.
    mapping(bytes32 => bool) public spentNullifiers;

    /// @notice The pool's exact ERC-20 liability: the sum of outstanding notes per token.
    /// @dev    Nothing authorises against it — with no admin there is no rescue path to
    ///         guard — but it is kept because it makes over-withdrawal impossible: the
    ///         pool can never pay out more of a token than its notes actually cover.
    mapping(address => uint256) public poolTokenBalance;

    /// @dev Who is paid what, resolved once per call from {TransactParams}. Validation and
    ///      settlement must never disagree about the direction, the magnitude, or the
    ///      split between relayer and recipient; deriving all of it here and passing it
    ///      down is what guarantees that, rather than trusting two call sites to
    ///      recompute identically.
    ///
    ///      Each payee sits beside its amount because that is the pair every consumer
    ///      wants — {_checkPayee} and {_payOut} take exactly one of these. Holding all of
    ///      it in one place also makes the invariant legible in one read:
    ///      `relayerFee + recipientPayout == absAmount` on a withdrawal.
    ///
    ///      This is derived, never supplied. Nothing here is caller-controlled, which is
    ///      why it is a separate type from {TransactParams} rather than part of it: a
    ///      field the caller can set is a field that can lie, and everything in
    ///      {TransactParams} is committed to in `paramsHash`.
    struct Payment {
        bool    isWithdraw;
        uint256 absAmount;
        address relayer;          // zero when self-submitted, in which case relayerFee is zero
        uint256 relayerFee;       // the relayer's cut; zero on the ordinary self-submitted path
        address recipient;        // withdrawal destination
        uint256 recipientPayout;  // absAmount - relayerFee, and legitimately zero when the fee takes it all
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    event Transact(
        uint256 publicAmount,
        uint256 indexed tokenAddress,
        bytes32 indexed inputNullifier0,
        bytes32 indexed inputNullifier1,
        bytes32 outputCommitment0,
        bytes32 outputCommitment1,
        uint32 outputTreeNumber,
        uint32 outputLeafIndex0,
        uint32 outputLeafIndex1,
        bytes encryptedOutput0,
        bytes encryptedOutput1
    );
    /// @notice A transaction that spent its inputs and created no notes.
    /// @dev    Separate from {Transact} rather than a flag on it, because a scanner must not
    ///         insert anything into its copy of the tree for one of these. Folding it in
    ///         would mean every client remembering to check a flag before inserting, and the
    ///         failure mode of forgetting is a tree that silently disagrees with the
    ///         contract's — which surfaces as every proof being rejected, with nothing to
    ///         say why.
    event PoolExit(
        uint256 publicAmount,
        uint256 indexed tokenAddress,
        bytes32 indexed inputNullifier0,
        bytes32 indexed inputNullifier1
    );

    /// @notice Value left the pool. Covers both destinations, because they always move
    ///         together: a relayed withdrawal pays the submitter and the recipient in one
    ///         settlement, and either half may legitimately be zero.
    /// @dev    Both parties are indexed so each can filter its own history, which is the
    ///         whole reason this is one event rather than folded into {Transact} —
    ///         that one has already spent its three topics.
    event Withdrawal(
        address indexed recipient,
        uint256 amount,
        address indexed relayer,
        uint256 fee,
        uint256 indexed tokenAddress
    );

    // ── Construction ───────────────────────────────────────────────────────────

    /// @dev Both dependencies are immutable and neither can be rotated. The registry is
    ///      deployed first so its address is known here; nothing in the registry points
    ///      back at a pool, which keeps the deployment order linear and the reference
    ///      strictly one-way.
    constructor(address _transactVerifier, address _registry) {
        if (_transactVerifier == address(0) || _registry == address(0)) revert ZeroAddress();

        transactVerifier = ITransactVerifier(_transactVerifier);
        registry         = IHaliasRegistry(_registry);
    }

    // ── Transact ───────────────────────────────────────────────────────────────

    /// @notice Spend up to two notes and create two new ones, optionally moving value in
    ///         or out of the pool.
    /// @param  p                 Transaction parameters; `publicAmount`'s sign selects
    ///                           deposit, transfer, or withdrawal.
    /// @param  encryptedOutput0  Ciphertext for the recipient of the first output note.
    /// @param  encryptedOutput1  Ciphertext for the recipient of the second output note.
    /// @param  proof             ABI-encoded Groth16 proof (pA, pB, pC).
    function transact(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) external payable nonReentrant {
        // Checks — nullifiers first: cheapest possible revert for front-run victims.
        if (spentNullifiers[p.inputNullifiers[0]])
            revert NullifierAlreadySpent(p.inputNullifiers[0]);
        if (spentNullifiers[p.inputNullifiers[1]])
            revert NullifierAlreadySpent(p.inputNullifiers[1]);
        if (p.inputNullifiers[0] == p.inputNullifiers[1])  revert DuplicateNullifier();
        // Each input names its own tree, and the tree must be the one its root belongs to.
        // Without this check the nullifier's tree component is unconstrained, and the holder
        // of a note could re-spend it under a different tree number — a fresh, unspent
        // nullifier every time, for the same note. Unlimited theft, not a liveness bug.
        for (uint256 i = 0; i < 2; i++) {
            (bool known, uint32 rootTree) = poolRootTree(p.poolRoot[i]);
            if (!known) revert PoolRootUnknown();
            if (rootTree != p.treeNumber[i]) revert PoolRootWrongTree();
        }
        if (!registry.isKnownRegistryRoot(p.registryRoot)) revert RegistryRootNotCurrent();

        // The insertion the proof is allowed to perform, and the only thing standing between
        // "you can only pay a registered alias" and a prover inserting their own keys into a
        // tree of their choosing. One comparison covers both paths: the registry arms a leaf
        // only during a claim, and reads zero otherwise, so an ordinary transaction must
        // carry zero and behaves exactly as it did before this existed.
        if (p.pendingLeaf != registry.pendingLeaf()) revert PendingLeafNotArmed();

        Payment memory pay = _decodePayment(p);
        _checkPayment(p, pay);
        _verifyTransact(p, encryptedOutput0, encryptedOutput1, proof);

        // Effects — spend inputs and insert outputs before any external transfer.
        spentNullifiers[p.inputNullifiers[0]] = true;
        spentNullifiers[p.inputNullifiers[1]] = true;

        // An exit creates no notes, so there is nothing to insert and the root does not move.
        //
        // Two things fall out of that. It is the valve for a full tree: every ordinary
        // transact inserts, so once the tree cannot accept insertions, deposits, transfers
        // and withdrawals would all revert together and every note in the pool would be
        // permanently unspendable, with no admin to rescue it. An exit still works, so a full
        // pool degrades to withdraw-only instead of locking everyone's funds.
        //
        // And it is much cheaper — the tree walk is 32 Poseidon hashes, about 74% of an
        // ordinary transact — which is why it is available at any time rather than only when
        // the tree is full.
        //
        // It is a real trade, not a free win: an exit is *distinguishable* on chain, so it
        // reveals that this spender kept no change, where every ordinary transact looks
        // alike. The circuit deliberately makes the implication one-way — empty outputs do
        // NOT require this flag — so a caller who wants that uniformity can still insert two
        // zero-amount commitments and pay for it. The SDK takes the exit by default on a
        // full withdrawal and exposes the opt-out, because an opt-IN cheap path would be
        // rare enough that using it would itself be the signal.
        if (p.outputsEmpty) {
            _settlePayment(p, pay);
            emit PoolExit(
                p.publicAmount, p.tokenAddress,
                p.inputNullifiers[0], p.inputNullifiers[1]
            );
            return;
        }

        (uint32 tree, uint32 idx0, uint32 idx1) =
            _insertPair(p.outputCommitments[0], p.outputCommitments[1]);
        _commitPoolRoot(tree);

        // Interactions — value movement last (CEI: safe independent of nonReentrant).
        _settlePayment(p, pay);

        emit Transact(
            p.publicAmount, p.tokenAddress,
            p.inputNullifiers[0], p.inputNullifiers[1],
            p.outputCommitments[0], p.outputCommitments[1],
            tree, idx0, idx1,
            encryptedOutput0, encryptedOutput1
        );
    }

    /// @notice The `paramsHash` public signal a prover must commit to for `p`.
    /// @dev    Exposed so clients derive it from the same code the verifier checks against
    ///         rather than reimplementing the encoding.
    function computeParamsHash(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1
    ) external view returns (uint256) {
        return _computeParamsHash(p, encryptedOutput0, encryptedOutput1);
    }

    // ── Derivation ─────────────────────────────────────────────────────────────

    /// @dev `publicAmount` is signed in the field: positive is a deposit, "negative"
    ///      (p − amount) a withdrawal. The relayer's cut and the recipient's share are
    ///      resolved here too, so nothing downstream re-derives the split.
    ///
    ///      `recipientPayout` clamps rather than underflowing because this runs before
    ///      validation; an over-large fee is rejected by {_checkPayment}, not here.
    function _decodePayment(TransactParams calldata p) internal pure returns (Payment memory pay) {
        pay.isWithdraw = p.publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        pay.absAmount  = pay.isWithdraw ? FIELD_PRIME - p.publicAmount : p.publicAmount;

        pay.relayer    = p.relayerFee.relayer;
        pay.relayerFee = p.relayerFee.amount;

        pay.recipient       = p.recipient;
        pay.recipientPayout = (pay.isWithdraw && pay.absAmount >= pay.relayerFee)
            ? pay.absAmount - pay.relayerFee
            : 0;
    }

    /// @dev The circuit bounds `tokenAddress` to 160 bits, so this truncation is lossless
    ///      for any input a valid proof can carry.
    function _token(uint256 tokenAddress) internal pure returns (address) {
        return address(uint160(tokenAddress));
    }

    // ── Validation ─────────────────────────────────────────────────────────────

    /// @dev Cheap input validation — `msg.value`, destination, token sanity. No state
    ///      mutation and no external calls, so it runs before the proof (fail-fast).
    function _checkPayment(TransactParams calldata p, Payment memory pay) internal view {
        if (pay.relayerFee > 0) {
            // The fee comes out of value leaving the pool, so it needs an outflow to come
            // from. It is paid in whatever asset is being withdrawn — a relayer that does
            // not want a given token simply declines to submit.
            //
            // A relayed *transfer* is still possible: express it as a withdrawal of
            // exactly the fee, with the real transfer in the output commitments, which
            // settles to a zero payout.
            if (!pay.isWithdraw) revert RelayerFeeRequiresWithdrawal();
            // No cap beyond the outflow itself: the fee is committed in paramsHash, so it
            // is the prover's own authorised figure, not something a submitter can inflate.
            if (pay.relayerFee > pay.absAmount) revert RelayerFeeExceedsWithdrawal();
        }

        // msg.value is only ever an ETH deposit. A withdrawal, a transfer, and anything
        // denominated in a token all send nothing, so one comparison covers every shape —
        // and reports both numbers rather than just naming a category.
        uint256 expected = (p.tokenAddress == 0 && !pay.isWithdraw) ? p.publicAmount : 0;
        if (msg.value != expected) revert WrongMsgValue(expected, msg.value);

        if (p.tokenAddress != 0 && _token(p.tokenAddress).code.length == 0) {
            revert InvalidTokenAddress();
        }

        // Both payees, one rule. Checked here rather than at the point of transfer so a
        // malformed call reverts before the proof is verified instead of after it.
        _checkPayee(pay.relayer,   pay.relayerFee);
        _checkPayee(pay.recipient, pay.recipientPayout);
    }

    /// @dev A destination only has to be valid when something actually reaches it. A
    ///      withdrawal fully consumed by the fee pays no recipient, and an unrelayed
    ///      transaction pays no relayer; in both cases the unused address is legitimately
    ///      zero. Paying the pool itself is always wrong — the value would be covered by
    ///      no note, and with no admin and no rescue path nothing could retrieve it.
    function _checkPayee(address to, uint256 amount) internal view {
        if (amount == 0) return;
        if (to == address(0) || to == address(this)) revert BadPayee();
    }

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
            p.relayerFee,
            p.externalData
        ))) % FIELD_PRIME;
    }

    function _verifyTransact(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) internal view {
        // Order follows the circuit's signal declaration order, not the `public [...]` list.
        // A wrong index here has no symptom other than every proof being rejected.
        uint256[14] memory pubSignals;
        pubSignals[0]  = uint256(p.poolRoot[0]);
        pubSignals[1]  = uint256(p.poolRoot[1]);
        pubSignals[2]  = p.treeNumber[0];
        pubSignals[3]  = p.treeNumber[1];
        pubSignals[4]  = uint256(p.registryRoot);
        pubSignals[5]  = p.publicAmount;
        pubSignals[6]  = p.tokenAddress;
        pubSignals[7]  = _computeParamsHash(p, encryptedOutput0, encryptedOutput1);
        pubSignals[8]  = uint256(p.pendingLeaf);
        pubSignals[9]  = p.outputsEmpty ? 1 : 0;
        pubSignals[10] = uint256(p.inputNullifiers[0]);
        pubSignals[11] = uint256(p.inputNullifiers[1]);
        pubSignals[12] = uint256(p.outputCommitments[0]);
        pubSignals[13] = uint256(p.outputCommitments[1]);

        (uint[2] memory pA, uint[2][2] memory pB, uint[2] memory pC) =
            abi.decode(proof, (uint[2], uint[2][2], uint[2]));

        if (!transactVerifier.verifyProof(pA, pB, pC, pubSignals)) revert InvalidProof();
    }

    // ── Settlement ─────────────────────────────────────────────────────────────

    /// @dev Balance effects and external transfers — runs last (CEI), after inputs are
    ///      spent and outputs inserted, so settlement is safe independent of the
    ///      `nonReentrant` guard.
    ///
    ///      Which asset is moving is decided once, inside {_creditPool}, {_debitPool} and
    ///      {_payOut}. Nothing above them branches on ETH versus token, so the two paths
    ///      cannot drift apart in the rules that govern them.
    function _settlePayment(TransactParams calldata p, Payment memory pay) internal {
        address token = _token(p.tokenAddress);

        if (pay.isWithdraw) {
            // Invariant: relayerFee + recipientPayout == absAmount, both resolved in
            // _decodePayment and bounded in _checkPayment. A withdrawal may be entirely
            // consumed by the fee — that is the shape of a claimer's first transaction,
            // and of every relayed transfer.
            _debitPool(token, pay.absAmount);
            _payOut(token, pay.relayer,   pay.relayerFee);
            _payOut(token, pay.recipient, pay.recipientPayout);

            emit Withdrawal(
                pay.recipient, pay.recipientPayout,
                pay.relayer,   pay.relayerFee,
                p.tokenAddress
            );
        } else {
            _creditPool(token, pay.absAmount);
        }
    }

    /// @dev Value entering the pool. ETH already arrived with `msg.value`, validated in
    ///      {_checkPayment}, so only the token path moves anything. A transfer credits
    ///      nothing at all.
    function _creditPool(address token, uint256 amount) private {
        if (token == address(0) || amount == 0) return;

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // Fee-on-transfer tokens would credit notes the pool cannot cover.
        if (IERC20(token).balanceOf(address(this)) < balanceBefore + amount) {
            revert FeeOnTransferToken();
        }
        poolTokenBalance[token] += amount;
    }

    /// @dev Reserves value on its way out, before any of it is paid. Unreachable while the
    ///      circuit is sound — it is the last line of defence for the pool's collateral if
    ///      it ever is not, and it names itself rather than surfacing as an arithmetic
    ///      panic.
    ///
    ///      The two assets are not equally protected, and the difference is deliberate.
    ///      Tokens carry an exact ledger, so this rejects any withdrawal exceeding the
    ///      notes outstanding for that token. ETH has no ledger — only the live balance,
    ///      which is every depositor's funds pooled together and can additionally be
    ///      inflated by a forced send. So the ETH branch only catches a withdrawal larger
    ///      than the entire pool, not one that over-draws against other users' notes.
    ///      Closing that gap means an ETH ledger and an extra SSTORE on every ETH
    ///      transact; the circuit's conservation constraint is the real guarantee either
    ///      way. See docs/contract-split.md.
    function _debitPool(address token, uint256 amount) private {
        if (token == address(0)) {
            if (address(this).balance < amount) revert PoolBalanceExceeded();
        } else {
            if (poolTokenBalance[token] < amount) revert PoolBalanceExceeded();
            poolTokenBalance[token] -= amount;
        }
    }

    /// @dev Single exit for value leaving the pool, so ETH and ERC-20 payouts cannot drift
    ///      apart. Callers must have reserved the amount with {_debitPool} first. A zero
    ///      amount means this payee is unused — see {_checkPayee}.
    function _payOut(address token, address to, uint256 amount) private {
        if (amount == 0) return;

        if (token == address(0)) {
            payable(to).sendValue(amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Pool ETH arrives through {transact}, which is payable. Nothing else should
    ///      push ETH here: untracked ETH is covered by no note, and with no admin and no
    ///      rescue path it would be stranded permanently.
    receive() external payable {
        revert DirectETHNotAllowed();
    }
}
