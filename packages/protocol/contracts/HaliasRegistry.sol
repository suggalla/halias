// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { SMTRegistry } from "./base/SMTRegistry.sol";
// Direct rather than transitive: these arrived implicitly through SMTRegistry's own global
// import, which meant nothing here said where they came from.
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";
import { FIELD_PRIME } from "./base/Constants.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

error NotController();
error ZeroController();
error InvalidAliasHash();
error InvalidSpendingCommitment();
error InvalidNullifierKeyHash();
error InvalidEncryptionPubkey();
error SpendingCommitmentOutOfField();
error NullifierKeyHashOutOfField();
error AliasTaken();
error AliasKeyTaken();
error DataHashOutOfField();
error AliasNotRegistered();

/// @title  HaliasRegistry — who the aliases are
/// @notice The sparse Merkle tree of alias keys, and the roots the pool proves against.
/// @dev    Deliberately narrow. This contract knows what keys an alias has and where it
///         sits in the tree. It does not know who *owns* an alias, what it is called, or
///         what anyone paid for it — that is the controller's business, and keeping it out
///         of here is what lets the tree be reasoned about on its own.
///
///         There is no admin and no upgrade path. Exactly one address may write, fixed at
///         construction: the controller, which is {HaliasController}. Everything else is a
///         view. The role is named for what it does rather than for the contract that
///         fills it, so this contract never has to know what a name or an owner is.
///
///         Validation lives here rather than in the controller even though the controller is
///         the only caller. The tree's invariants — every alias has a slot, no alias has
///         two, every committed key is in-field — must hold because this contract enforces
///         them, not because the current controller happens to. A future controller, or a
///         buggy one, cannot corrupt the tree through this surface.
contract HaliasRegistry is SMTRegistry {
    /// @notice The only address permitted to mutate the tree.
    /// @dev    Immutable, so the registry can never be repointed at a different controller.
    ///         Set by CREATE2 address prediction — the controller needs this contract's
    ///         address too, and one of the two has to be known before it exists.
    address public immutable controller;

    /// @dev The keys an alias commits to. The registry leaf is derived from these on every
    ///      write, so the record and the tree cannot drift out of step.
    struct AliasRecord {
        bytes32 spendingCommitment;
        bytes32 nullifierKeyHash;   // Poseidon(nullifierKey, 1) — the raw key is never on chain
        bytes32 encryptionPubkey;
        bytes32 dataHash;
        // uint256, not a narrower timestamp type. It follows four bytes32 fields, so it
        // starts a fresh slot with nothing to pack against — the narrower type buys no
        // storage and costs a `uint64(block.timestamp)` cast at the only write. Matches
        // {SMTRegistry-registryRootSeenAt}, which is a timestamp for the same reason.
        uint256 registeredAt;
    }

    mapping(bytes32 => AliasRecord) public aliases;

    // ── the prefix index ───────────────────────────────────────────────────────
    //
    // Registrations grouped by the top ALIAS_PREFIX_BITS of the alias hash, so a client can
    // read the group its recipient falls in instead of every registration ever made.
    //
    // This exists because resolving a name locally used to mean scanning the whole registry —
    // measured at 785 bytes of log JSON per alias, so 785 MB at a million aliases, which is
    // where the client dies long before anything else does. The alternative was asking a
    // targeted question, which names the recipient to whoever answers. This is the third
    // option: ask about a group.
    //
    // 12 bits is the finest granularity, not the mandated one. A client wanting a larger
    // anonymity set reads several adjacent prefixes — 16 of them is an 8-bit query — so the
    // trade between k and bandwidth stays a client decision. Storing it coarser would take
    // that choice away; storing it finer costs nothing here but more calls to widen.
    //
    // Cost, measured against the same registrations with the push removed: **+27,442 gas
    // (2.4%)** into a group that already exists, **+44,578 (3.9%)** for the first alias in a
    // group, where both the array length slot and its first element are cold. Against a
    // registration's ~1.13M — which is dominated by the 32 Poseidon rounds of the SMT
    // update — that is the cheapest part of the transaction.
    //
    // See docs/rpc-surface.md.
    uint256 public constant ALIAS_PREFIX_BITS = 12;

    mapping(uint16 => bytes32[]) private _aliasesByPrefix;

    /// One alias, with everything needed to rebuild its registry leaf and prove membership.
    struct AliasEntry {
        bytes32 aliasHash;
        bytes32 spendingCommitment;
        bytes32 nullifierKeyHash;
        bytes32 encryptionPubkey;
        bytes32 dataHash;
        // The tree position, zero-based — what {SMTRegistry-getSmtSiblings} takes, NOT what
        // {aliasSlot} stores or {AliasRegistered} emits. Those are offset by one so that zero
        // reads as "unregistered". Named `pathKey` rather than `slot` because the two
        // conventions have already been confused once, and an off-by-one here silently derives
        // the neighbour's path rather than failing.
        uint32  pathKey;
    }

    /// @notice The alias holding each circuit-visible key, so no two can share one.
    /// @dev    The tree is keyed on `aliasHash % FIELD_PRIME`, not on the full 32 bytes —
    ///         a field element is all a leaf can hold, and widening it would take two
    ///         signals and a new ceremony. The reduction is lossy: `p` is about 0.189 of
    ///         2^256, so most keccak outputs already reduce, and `h` and `h + p` are
    ///         distinct aliases that would otherwise commit the same key.
    ///
    ///         No one can reach this by choosing a name — colliding with an existing alias
    ///         means finding a string whose keccak is congruent to it mod p, around 2^254
    ///         work — and the note commitment binds the spending commitment regardless, so a
    ///         collision would confer no ability to receive or spend. It is enforced anyway
    ///         so that "one alias, one key" is an invariant of this contract rather than an
    ///         assumption anything built on top has to re-derive.
    mapping(uint256 => bytes32) public aliasByKey;

    /// @dev The insertion a claim's proof may perform this transaction.
    ///
    ///      Transient rather than persistent so it cannot outlive the call that set it — see
    ///      {authorizePendingLeaf}. Declared with the `transient` data location rather than
    ///      reached through `tstore`/`tload` in assembly: the compiler assigns and tracks the
    ///      slot, which removes both the hand-picked constant and the three assembly blocks
    ///      that used it. Same semantics, and nothing left for a reader to verify by hand.
    bytes32 private transient _pendingLeaf;

    // ── Events ─────────────────────────────────────────────────────────────────

    /// @dev Carries every field of the record, `nullifierKeyHash` included.
    ///
    ///      That one is here for a reason worth stating: without it a client cannot resolve a
    ///      recipient from logs and has to call {aliases} instead — a targeted read carrying
    ///      the alias hash of the person it is about to pay, handed to whatever node answers,
    ///      moments before a transfer that publishes nothing. Everything else it needs is
    ///      already in this event, so one missing field was forcing the leak.
    ///
    ///      It reveals nothing new. `nullifierKeyHash` is `Poseidon(nullifierKey, 1)` — the
    ///      raw key never appears on chain — and it is already readable from {aliases} and
    ///      already committed inside `leaf` below. This only moves it somewhere a client can
    ///      obtain in bulk, at 32 bytes of log data.
    ///
    ///      See docs/rpc-surface.md.
    event AliasRegistered(
        bytes32 indexed aliasHash,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 leaf,
        bytes32 encryptionPubkey,
        uint32  slot
    );
    event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 dataHash, bytes32 leaf);
    /// @dev Same shape as {AliasRegistered}, and for the same reason — a rotation replaces the
    ///      keys, so a client rebuilding from logs needs the new ones from here.
    event AliasReassigned(
        bytes32 indexed aliasHash,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 leaf,
        bytes32 encryptionPubkey
    );

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    constructor(address _controller) {
        if (_controller == address(0)) revert ZeroController();
        controller = _controller;
        _initSMT();
    }

    // ── Writes ─────────────────────────────────────────────────────────────────

    /// @notice Record a new alias and give it a slot.
    /// @dev    Reverts if the alias already has one. Slots are never reused and never
    ///         reassigned, so a registration is the only thing that can consume one.
    function register(
        bytes32 aliasHash,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey
    ) external onlyController {
        if (aliasHash == bytes32(0)) revert InvalidAliasHash();
        if (aliasSlot[aliasHash] != 0) revert AliasTaken();
        uint256 key = uint256(aliasHash) % FIELD_PRIME;
        if (aliasByKey[key] != bytes32(0)) revert AliasKeyTaken();
        aliasByKey[key] = aliasHash;
        _checkKeys(spendingCommitment, nullifierKeyHash, encryptionPubkey);

        aliases[aliasHash] = AliasRecord({
            spendingCommitment:   spendingCommitment,
            nullifierKeyHash: nullifierKeyHash,
            encryptionPubkey: encryptionPubkey,
            dataHash:         bytes32(0),
            registeredAt:     block.timestamp
        });

        bytes32 leaf = _writeLeaf(aliasHash);
        // Indexed here rather than in {_smtUpdate} because this is the only path that creates
        // an alias — the guard above makes that exact — while `_smtUpdate` also runs for
        // rotations and data changes, which must not append a second copy.
        _aliasesByPrefix[_aliasPrefix(aliasHash)].push(aliasHash);
        emit AliasRegistered(
            aliasHash, spendingCommitment, nullifierKeyHash, leaf, encryptionPubkey, aliasSlot[aliasHash]
        );
    }

    // {reassign} is the only way an alias's keys change, and it replaces all three at once:
    // anything replacing fewer cannot answer a compromised spending key, which is the only
    // compromise that loses funds. It keeps the alias in its slot, so senders holding a proof
    // against that position stay valid.

    /// @notice Announce, for the rest of this transaction, the registry insertion a claim's
    ///         proof is allowed to perform.
    /// @dev    A claim is the one operation whose outputs must prove membership in a tree
    ///         that does not exist when the proof is built: the claimer's own alias has to be
    ///         registered before their change note can prove against it. The circuit now
    ///         performs that insertion itself, against the pre-registration root — but only
    ///         if it is told which leaf, and that value must come from here rather than from
    ///         the prover. A prover who chose it would insert their own unregistered keys and
    ///         pay themselves, which is exactly what the registry proof exists to prevent.
    ///
    ///         Transient storage, so it cannot survive the transaction that set it and there
    ///         is no residue for a later caller to exploit. It also keeps the dependency
    ///         one-way: the pool already reads this registry, and does not have to learn the
    ///         domain's address to police the claim path. On every other path this reads zero,
    ///         so the pool's check is one comparison covering both cases.
    ///
    ///         The leaf is recomputed here from stored state rather than accepted as an
    ///         argument, so the controller cannot arm a value the tree does not agree with.
    function authorizePendingLeaf(bytes32 aliasHash) external onlyController {
        AliasRecord storage rec = _mustExist(aliasHash);
        uint256 key = uint256(aliasHash) % FIELD_PRIME;
        bytes32 leafHash = bytes32(PoseidonT4.hash([key, uint256(_leaf(rec)), 1]));
        _pendingLeaf = leafHash;
    }

    /// @notice Withdraw the authorisation, once the proof it was for has been checked.
    /// @dev    Transient storage already guarantees it cannot outlive the transaction, so
    ///         this narrows the live span from "the rest of the transaction" to "across the
    ///         pool call". Nothing exploitable was reachable in the gap — the only leaf that
    ///         can be armed is one the registry just wrote, so a second proof reusing it
    ///         could at most re-insert already-registered keys — but that is a paragraph of
    ///         reasoning, and an auditor should not have to reconstruct it.
    function clearPendingLeaf() external onlyController {
        _pendingLeaf = 0;
    }

    /// @notice The insertion armed for this transaction, or zero.
    function pendingLeaf() external view returns (bytes32) {
        return _pendingLeaf;
    }

    /// @notice Point the alias at new off-chain data.
    /// @dev    Opaque here. The registry commits to the hash so the circuit can prove what
    ///         an alias claims without this contract needing to understand any of it.
    function setDataHash(bytes32 aliasHash, bytes32 newDataHash) external onlyController {
        AliasRecord storage rec = _mustExist(aliasHash);
        // dataHash is the third input to the Poseidon leaf, and Poseidon reduces silently
        // rather than reverting: `p + 5` and `5` commit the identical leaf. Without this
        // the registry would store one value and commit another, and two distinct records
        // would share a leaf. Registration cannot hit it because it writes a zero dataHash,
        // which is why the check has to be here rather than only in _checkKeys.
        if (uint256(newDataHash) >= FIELD_PRIME) revert DataHashOutOfField();
        rec.dataHash = newDataHash;

        bytes32 leaf = _writeLeaf(aliasHash);
        emit AliasDataUpdated(aliasHash, newDataHash, leaf);
    }

    /// @notice Replace every key on an alias, for a transfer to a new holder.
    /// @dev    `dataHash` is cleared: whatever was accumulated against this name under its
    ///         former holder does not belong to the new one. Ownership itself is the
    ///         controller's record — this only moves the keys the tree commits to.
    function reassign(
        bytes32 aliasHash,
        bytes32 newSpendingCommitment,
        bytes32 newNullifierKeyHash,
        bytes32 newEncryptionPubkey
    ) external onlyController {
        AliasRecord storage rec = _mustExist(aliasHash);
        _checkKeys(newSpendingCommitment, newNullifierKeyHash, newEncryptionPubkey);

        rec.spendingCommitment   = newSpendingCommitment;
        rec.nullifierKeyHash = newNullifierKeyHash;
        rec.encryptionPubkey = newEncryptionPubkey;
        rec.dataHash         = bytes32(0);

        bytes32 leaf = _writeLeaf(aliasHash);
        emit AliasReassigned(aliasHash, newSpendingCommitment, newNullifierKeyHash, leaf, newEncryptionPubkey);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function isRegistered(bytes32 aliasHash) external view returns (bool) {
        return aliasSlot[aliasHash] != 0;
    }

    /// @notice The registry leaf currently committed for an alias.
    /// @dev    Lets a client check its own leaf derivation against the contract's rather
    ///         than reimplementing the Poseidon layout and hoping they agree.
    function leafOf(bytes32 aliasHash) external view returns (bytes32) {
        AliasRecord storage rec = aliases[aliasHash];
        return _leaf(rec);
    }

    /// @notice How many aliases fall in a prefix group. Read this to page {getAliasesByPrefix}.
    function prefixCount(uint16 prefix) external view returns (uint256) {
        return _aliasesByPrefix[prefix].length;
    }

    /// @notice Every alias in a prefix group, with what a client needs to rebuild its leaf and
    ///         locate it in the tree.
    /// @dev    Paged, because a group is unbounded and an `eth_call` returning all of it would
    ///         eventually exceed what a node will serve. Paging discloses nothing further: every
    ///         page names the same group, and which page a caller wants says nothing about which
    ///         entry they came for.
    ///
    ///         Returns whole records rather than hashes so that resolving a name is one call.
    ///         Following up with {aliases} per entry would put the alias hash back on the wire
    ///         individually, which is the leak this replaces.
    ///
    ///         `offset` past the end returns empty rather than reverting — a client paging to
    ///         exhaustion should stop, not fail.
    function getAliasesByPrefix(uint16 prefix, uint256 offset, uint256 limit)
        external view returns (AliasEntry[] memory entries)
    {
        bytes32[] storage group = _aliasesByPrefix[prefix];
        if (offset >= group.length) return new AliasEntry[](0);

        uint256 end = offset + limit;
        if (end > group.length || end < offset) end = group.length;   // `< offset` catches overflow
        entries = new AliasEntry[](end - offset);

        for (uint256 i = offset; i < end; i++) {
            bytes32 h = group[i];
            AliasRecord storage rec = aliases[h];
            entries[i - offset] = AliasEntry({
                aliasHash:          h,
                spendingCommitment: rec.spendingCommitment,
                nullifierKeyHash:   rec.nullifierKeyHash,
                encryptionPubkey:   rec.encryptionPubkey,
                dataHash:           rec.dataHash,
                // Offset back to zero-based here, once, so callers never do it themselves.
                pathKey:            aliasSlot[h] - 1
            });
        }
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    /// @dev Internal, deliberately, exactly as {HaliasController-registrationCommitment} is.
    ///      As an external `pure` helper this would be callable over `eth_call` with a single
    ///      alias hash as its argument — which is a targeted question naming one person, and
    ///      the whole reason the prefix index exists. Clients compute this locally; it is a
    ///      shift. `SdkPreimage.test.ts` asserts the selector is not dispatchable.
    function _aliasPrefix(bytes32 aliasHash) private pure returns (uint16) {
        return uint16(uint256(aliasHash) >> (256 - ALIAS_PREFIX_BITS));
    }

    /// @dev The single place a leaf is built and pushed into the tree. Every write routes
    ///      through here, so the committed leaf is always a function of the stored record —
    ///      there is no path that updates one without the other.
    function _writeLeaf(bytes32 aliasHash) private returns (bytes32 leaf) {
        leaf = _leaf(aliases[aliasHash]);
        _smtUpdate(aliasHash, leaf);
    }

    /// @dev The leaf commits to the keys only. Identity is bound one level up, in
    ///      {SMTRegistry._smtUpdate}, which hashes `Poseidon(aliasKey, leaf, 1)` — so an
    ///      aliasHash argument here would be unused and imply a binding this does not make.
    function _leaf(AliasRecord storage rec) private view returns (bytes32) {
        return bytes32(PoseidonT4.hash([
            uint256(rec.spendingCommitment),
            uint256(rec.nullifierKeyHash),
            uint256(rec.dataHash)
        ]));
    }

    function _mustExist(bytes32 aliasHash) private view returns (AliasRecord storage rec) {
        if (aliasSlot[aliasHash] == 0) revert AliasNotRegistered();
        rec = aliases[aliasHash];
    }

    function _checkKeys(
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey
    ) private pure {
        if (spendingCommitment   == bytes32(0)) revert InvalidSpendingCommitment();
        if (nullifierKeyHash == bytes32(0)) revert InvalidNullifierKeyHash();
        if (encryptionPubkey == bytes32(0)) revert InvalidEncryptionPubkey();
        if (uint256(spendingCommitment)   >= FIELD_PRIME) revert SpendingCommitmentOutOfField();
        if (uint256(nullifierKeyHash) >= FIELD_PRIME) revert NullifierKeyHashOutOfField();
    }
}
