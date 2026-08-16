// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma solidity 0.8.28;

import { MerkleTreeWithHistory } from "./MerkleTreeWithHistory.sol";
import { FIELD_PRIME, MAX_ABS_AMOUNT } from "./base/Constants.sol";
import { TransactParams } from "./interfaces/IHaliasPool.sol";
import { IHaliasRegistry } from "./interfaces/IHaliasRegistry.sol";
import { ITransactVerifier } from "./interfaces/ITransactVerifier.sol";
// SafeERC20 brings IERC20 with it; importing both only duplicates the symbol.
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

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

    /// @notice How many notes one transaction may spend. Must equal the circuit's `nIns`.
    /// @dev    Four rather than two. A wallet's balance arrives as one note per payment, and
    ///         at two inputs spending N notes took N-1 chained merges — nine transactions for
    ///         a ten-note balance, which users met as "consolidate first". Four takes that to
    ///         three, and costs 11% FEWER constraints than the circuit it replaces, because
    ///         the claim machinery moved out at the same time.
    ///
    ///         One width, not several. Dummy inputs are padded to this count and their
    ///         nullifiers are published and spent exactly like real ones, so an observer
    ///         cannot tell whether a transaction spent one note or four. Offering a second,
    ///         narrower circuit would give that away — the nullifier count is public, so the
    ///         choice of circuit is too.
    uint256 internal constant INPUTS = 4;

    /// @notice Groth16 verifier for an ordinary transaction: deposit, transfer, withdraw.
    ITransactVerifier public immutable transactVerifier;

    /// @notice Groth16 verifier for a claim — a transaction that registers an alias and
    ///         spends in the same proof.
    /// @dev    Two circuits rather than one, because R1CS enforces every constraint on every
    ///         proof: with them merged, an ordinary transfer paid for two registry Merkle
    ///         proofs and a mux it never used — 33,322 constraints, 35% of the circuit.
    ///
    ///         Both take identical public signals, so there is one params struct, one
    ///         pubSignals array and one event. The only difference is which of these two
    ///         addresses is called, and that is decided by `pendingLeaf` — which the registry
    ///         arms and {transact} already requires to match. The ordinary circuit constrains
    ///         it to zero, so an ordinary proof cannot express a registry insertion at all.
    ITransactVerifier public immutable claimVerifier;

    /// @notice Registry whose published roots outputs are proven against.
    /// @dev    Immutable and admin-less by construction, so it is trusted for the root
    ///         read in {transact}. `nonReentrant` covers it regardless.
    IHaliasRegistry public immutable registry;

    /// @notice Nullifiers already spent. A note is spendable exactly once.
    mapping(bytes32 => bool) public spentNullifiers;

    /// @notice The pool's exact ERC-20 liability: the sum of outstanding notes per token.
    /// @dev    Nothing authorises against it — with no admin there is no rescue path to
    ///         guard. It is kept because it is the pool's own count of what it issued
    ///         notes for, which `balanceOf` is not: a direct transfer inflates the latter
    ///         and never the former. {_debitPool} pays out against this, so surplus sent
    ///         straight to this address is unspendable rather than free to withdraw.
    ///
    ///         Not a per-user bound. It says nothing about whose notes make up the total,
    ///         so it cannot stop one holder over-drawing against another — see
    ///         {_debitPool} for what this does and does not guarantee.
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

    /// @dev Nullifiers are data, not topics. Indexing them would let anyone filter the log
    ///      stream for one specific nullifier — a targeted question about one note, and the
    ///      same class of leak the registry's prefix index exists to remove. Clients scan
    ///      these events in bulk and decode locally, so nothing needed the topics.
    event Transact(
        uint256 publicAmount,
        address indexed tokenAddress,
        bytes32[4] inputNullifiers,
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
        address indexed tokenAddress,
        bytes32[4] inputNullifiers
    );

    /// @notice Value left the pool. Covers both destinations, because they always move
    ///         together: a relayed withdrawal pays the submitter and the recipient in one
    ///         settlement, and either half may legitimately be zero.
    /// @dev    Both parties are indexed so each can filter its own history. Public addresses
    ///         either way — a withdrawal names its destination on chain — so unlike the
    ///         nullifiers above there is nothing here that topics would give away.
    event Withdrawal(
        address indexed recipient,
        uint256 amount,
        address indexed relayer,
        uint256 fee,
        address indexed tokenAddress
    );

    // ── Construction ───────────────────────────────────────────────────────────

    /// @dev Both dependencies are immutable and neither can be rotated. The registry is
    ///      deployed first so its address is known here; nothing in the registry points
    ///      back at a pool, which keeps the deployment order linear and the reference
    ///      strictly one-way.
    constructor(address _transactVerifier, address _claimVerifier, address _registry) {
        if (_transactVerifier == address(0) || _claimVerifier == address(0)
            || _registry == address(0)) revert ZeroAddress();

        transactVerifier = ITransactVerifier(_transactVerifier);
        claimVerifier    = ITransactVerifier(_claimVerifier);
        registry         = IHaliasRegistry(_registry);
    }

    // ── Transact ───────────────────────────────────────────────────────────────

    /// @notice Spend up to four notes and create two new ones, optionally moving value in
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
        //
        // Every pair is compared, not just adjacent ones. With two inputs "no duplicates" was
        // one comparison; with four it is six, and checking fewer would let a caller spend the
        // same note twice inside one transaction — the nullifier is written once either way,
        // so the second copy would be spent for free. The loop is written so adding an input
        // cannot leave a pair unchecked.
        for (uint256 i = 0; i < INPUTS; i++) {
            if (spentNullifiers[p.inputNullifiers[i]])
                revert NullifierAlreadySpent(p.inputNullifiers[i]);
            for (uint256 j = i + 1; j < INPUTS; j++) {
                if (p.inputNullifiers[i] == p.inputNullifiers[j]) revert DuplicateNullifier();
            }
        }
        // Each input names its own tree, and the tree must be the one its root belongs to.
        // Without this check the nullifier's tree component is unconstrained, and the holder
        // of a note could re-spend it under a different tree number — a fresh, unspent
        // nullifier every time, for the same note. Unlimited theft, not a liveness bug.
        for (uint256 i = 0; i < INPUTS; i++) {
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
        for (uint256 i = 0; i < INPUTS; i++) spentNullifiers[p.inputNullifiers[i]] = true;

        // An exit creates no notes, so there is nothing to insert and the root does not move.
        //
        // It exists for the gas. Measured with scripts/gasbench.ts: 107,799 against 522,103
        // for the same withdrawal that inserts, so about 414,000 gas — the tree walk is
        // LEVELS + 1 Poseidon hashes, plus a root commit and the larger event. Real Groth16
        // verification adds the same amount to both, so the saving holds while the ratio
        // falls to roughly half.
        //
        // It is also the valve for a full pool, but that is now a footnote rather than the
        // reason. Rolling trees mean insertion only fails at TreeSpaceExhausted — 2^32 leaves,
        // a bound the circuit enforces on treeNumber, and some two billion transactions away.
        // An exit would still work there, so the pool would degrade to withdraw-only rather
        // than freezing every note with no admin to rescue them. Worth having; not worth
        // designing a per-transaction cost around.
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
                p.inputNullifiers
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
            p.inputNullifiers,
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
        uint256 expected =
            (p.tokenAddress == address(0) && !pay.isWithdraw) ? p.publicAmount : 0;
        if (msg.value != expected) revert WrongMsgValue(expected, msg.value);

        // Both this test and the one above read the same `address`, so "is it ETH" cannot
        // answer differently here than it does at settlement. That equivalence is why
        // `tokenAddress` is not a uint256 — see the field's declaration in IHaliasPool.
        if (p.tokenAddress != address(0) && p.tokenAddress.code.length == 0) {
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
        uint256[20] memory pubSignals;
        for (uint256 i = 0; i < INPUTS; i++) {
            pubSignals[i]          = uint256(p.poolRoot[i]);
            pubSignals[INPUTS + i] = p.treeNumber[i];
        }
        pubSignals[8]  = uint256(p.registryRoot);
        pubSignals[9]  = p.publicAmount;
        // The one place the address is widened back into a field element, because that is
        // what the verifier's public-signal array is. Widening is total; narrowing was not.
        pubSignals[10] = uint256(uint160(p.tokenAddress));
        pubSignals[11] = _computeParamsHash(p, encryptedOutput0, encryptedOutput1);
        pubSignals[12] = uint256(p.pendingLeaf);
        pubSignals[13] = p.outputsEmpty ? 1 : 0;
        for (uint256 i = 0; i < INPUTS; i++) {
            pubSignals[14 + i] = uint256(p.inputNullifiers[i]);
        }
        pubSignals[18] = uint256(p.outputCommitments[0]);
        pubSignals[19] = uint256(p.outputCommitments[1]);

        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        // Which verifier, decided by the value the registry armed rather than by anything the
        // prover supplies: {transact} has already required `pendingLeaf` to equal it. A caller
        // presenting an ordinary proof while a claim is armed fails that check; one presenting
        // a claim proof with nothing armed is verified by the claim circuit with its insertion
        // disabled, which is exactly an ordinary transaction.
        ITransactVerifier verifier =
            p.pendingLeaf == bytes32(0) ? transactVerifier : claimVerifier;
        if (!verifier.verifyProof(pA, pB, pC, pubSignals)) revert InvalidProof();
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
        address token = p.tokenAddress;

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
    ///      circuit is sound, and it names itself rather than surfacing as an arithmetic
    ///      panic.
    ///
    ///      Be precise about what this bounds, because it is weaker than it looks. Both
    ///      branches cap a withdrawal at the pool's *aggregate* holding of that asset —
    ///      neither one knows whose notes are whose, so neither can stop a forged proof
    ///      from over-drawing against other users. Only the circuit's conservation
    ///      constraint does that. If soundness breaks, this does not contain it.
    ///
    ///      What the token ledger adds over `balanceOf` is exactly one thing: it excludes
    ///      value that arrived outside {_creditPool}. Tokens transferred straight to this
    ///      address are surplus the pool never issued notes against, and this refuses to
    ///      pay them out. ETH has no equivalent because a forced send (`selfdestruct`, a
    ///      coinbase payout) can inflate `address(this).balance` with no call to reject —
    ///      so the ETH branch only catches a withdrawal larger than everything here.
    ///
    ///      That asymmetry is left alone deliberately. Surplus ETH is a donation: claiming
    ///      it still needs a valid proof, so it sits as over-collateral rather than as a
    ///      liability, and an ETH ledger would buy a storage write per deposit and
    ///      withdrawal to forbid spending a donation nobody can reach anyway. Detecting a
    ///      soundness break is an off-chain job regardless — {Transact}, {PoolExit} and
    ///      {Withdrawal} carry enough to reconstruct the pool's liability from logs and
    ///      compare it against the live balance, and that reconstruction is worth more
    ///      than an on-chain counter, because it is not written by the code path that
    ///      would be exploited. See SECURITY.md.
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
