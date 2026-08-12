// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./base/SMTRegistry.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

error NotController();
error ZeroController();
error InvalidAliasHash();
error InvalidSpendingPubkey();
error InvalidNullifierKeyHash();
error InvalidEncryptionPubkey();
error PubkeyOutOfField();
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
///         construction: the controller, which is {HaliasDomain}. Everything else is a
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
        bytes32 spendingPubkey;
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

    /// @notice The alias holding each circuit-visible key, so no two can share one.
    /// @dev    The tree is keyed on `aliasHash % FIELD_PRIME`, not on the full 32 bytes —
    ///         a field element is all a leaf can hold, and widening it would take two
    ///         signals and a new ceremony. The reduction is lossy: `p` is about 0.189 of
    ///         2^256, so most keccak outputs already reduce, and `h` and `h + p` are
    ///         distinct aliases that would otherwise commit the same key.
    ///
    ///         No one can reach this by choosing a name — colliding with an existing alias
    ///         means finding a string whose keccak is congruent to it mod p, around 2^254
    ///         work — and the note commitment binds the spending pubkey regardless, so a
    ///         collision would confer no ability to receive or spend. It is enforced anyway
    ///         so that "one alias, one key" is an invariant of this contract rather than an
    ///         assumption anything built on top has to re-derive.
    mapping(uint256 => bytes32) public aliasByKey;

    /// @dev Transient slot holding the insertion a claim's proof may perform this
    ///      transaction. Transient rather than persistent so it cannot outlive the call that
    ///      set it — see {armPendingLeaf}. An arbitrary constant, not a compiler-assigned
    ///      slot: transient and persistent storage have separate address spaces, so this
    ///      cannot collide with anything above.
    uint256 private constant PENDING_LEAF_TSLOT = 0x48414c5f50454e44; // "HAL_PEND"

    // ── Events ─────────────────────────────────────────────────────────────────

    event AliasRegistered(
        bytes32 indexed aliasHash,
        bytes32 spendingPubkey,
        bytes32 leaf,
        bytes32 encryptionPubkey,
        uint32  slot
    );
    event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 dataHash, bytes32 leaf);
    event AliasReassigned(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 leaf, bytes32 encryptionPubkey);

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
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey
    ) external onlyController {
        if (aliasHash == bytes32(0)) revert InvalidAliasHash();
        if (aliasSlot[aliasHash] != 0) revert AliasTaken();
        uint256 key = uint256(aliasHash) % FIELD_PRIME;
        if (aliasByKey[key] != bytes32(0)) revert AliasKeyTaken();
        aliasByKey[key] = aliasHash;
        _checkKeys(spendingPubkey, nullifierKeyHash, encryptionPubkey);

        aliases[aliasHash] = AliasRecord({
            spendingPubkey:   spendingPubkey,
            nullifierKeyHash: nullifierKeyHash,
            encryptionPubkey: encryptionPubkey,
            dataHash:         bytes32(0),
            registeredAt:     block.timestamp
        });

        bytes32 leaf = _writeLeaf(aliasHash);
        emit AliasRegistered(aliasHash, spendingPubkey, leaf, encryptionPubkey, aliasSlot[aliasHash]);
    }

    // There is no `rotateKeys`. It replaced the nullifier and encryption keys but never the
    // spending pubkey, so it could not answer the only compromise that loses funds; and
    // {reassign} already does all three in place, keeping the alias in its slot so senders
    // holding a proof against its position stay valid. One writer fewer is also one fewer way
    // to invalidate a claim proving against a predicted root.

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
    function armPendingLeaf(bytes32 aliasHash) external onlyController {
        AliasRecord storage rec = _mustExist(aliasHash);
        uint256 key = uint256(aliasHash) % FIELD_PRIME;
        bytes32 leafHash = bytes32(PoseidonT4.hash([key, uint256(_leaf(rec)), 1]));
        assembly ("memory-safe") { tstore(PENDING_LEAF_TSLOT, leafHash) }
    }

    /// @notice Stand the arming down, once the proof it was for has been checked.
    /// @dev    Transient storage already guarantees it cannot outlive the transaction, so
    ///         this narrows the live span from "the rest of the transaction" to "across the
    ///         pool call". Nothing exploitable was reachable in the gap — the only leaf that
    ///         can be armed is one the registry just wrote, so a second proof reusing it
    ///         could at most re-insert already-registered keys — but that is a paragraph of
    ///         reasoning, and an auditor should not have to reconstruct it.
    function clearPendingLeaf() external onlyController {
        assembly ("memory-safe") { tstore(PENDING_LEAF_TSLOT, 0) }
    }

    /// @notice The insertion armed for this transaction, or zero.
    function pendingLeaf() external view returns (bytes32 v) {
        assembly ("memory-safe") { v := tload(PENDING_LEAF_TSLOT) }
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
    /// @dev    `dataHash` is cleared: whatever the previous holder had accumulated against
    ///         this name does not belong to the new one. Ownership itself is the
    ///         controller's record — this only moves the keys the tree commits to.
    function reassign(
        bytes32 aliasHash,
        bytes32 newSpendingPubkey,
        bytes32 newNullifierKeyHash,
        bytes32 newEncryptionPubkey
    ) external onlyController {
        AliasRecord storage rec = _mustExist(aliasHash);
        _checkKeys(newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey);

        rec.spendingPubkey   = newSpendingPubkey;
        rec.nullifierKeyHash = newNullifierKeyHash;
        rec.encryptionPubkey = newEncryptionPubkey;
        rec.dataHash         = bytes32(0);

        bytes32 leaf = _writeLeaf(aliasHash);
        emit AliasReassigned(aliasHash, newSpendingPubkey, leaf, newEncryptionPubkey);
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

    // ── Internals ──────────────────────────────────────────────────────────────

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
            uint256(rec.spendingPubkey),
            uint256(rec.nullifierKeyHash),
            uint256(rec.dataHash)
        ]));
    }

    function _mustExist(bytes32 aliasHash) private view returns (AliasRecord storage rec) {
        if (aliasSlot[aliasHash] == 0) revert AliasNotRegistered();
        rec = aliases[aliasHash];
    }

    function _checkKeys(
        bytes32 spendingPubkey,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey
    ) private pure {
        if (spendingPubkey   == bytes32(0)) revert InvalidSpendingPubkey();
        if (nullifierKeyHash == bytes32(0)) revert InvalidNullifierKeyHash();
        if (encryptionPubkey == bytes32(0)) revert InvalidEncryptionPubkey();
        if (uint256(spendingPubkey)   >= FIELD_PRIME) revert PubkeyOutOfField();
        if (uint256(nullifierKeyHash) >= FIELD_PRIME) revert NullifierKeyHashOutOfField();
    }
}
