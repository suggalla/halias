// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleTreeWithHistory, ZeroCommitment} from "../contracts/MerkleTreeWithHistory.sol";
import {MockTreeSequential} from "../contracts/mocks/MockTreeSequential.sol";

// Exposes the internal insert so a fuzzer can drive it directly, without needing a proof.
contract TreeHarness is MerkleTreeWithHistory {
    function insertPair(bytes32 a, bytes32 b) external returns (uint32, uint32, uint32) {
        (uint32 t, uint32 l, uint32 r) = _insertPair(a, b);
        _commitPoolRoot(t);
        return (t, l, r);
    }
}

// Differential and invariant testing for the pairwise pool insertion.
//
// The Hardhat suite proves equivalence on hand-picked sequences. That answers "does it
// work on the cases I thought of", which is the weaker question — the pairwise change
// rewrites how every note's inclusion proof is rooted, so the property has to hold for
// *arbitrary* leaves and lengths, not chosen ones. MockTreeSequential is the pre-change
// implementation kept verbatim as the oracle.
contract PoolTreeDifferentialTest is Test {
    TreeHarness       internal tree;
    MockTreeSequential internal oracle;

    function setUp() public {
        tree      = new TreeHarness();
        oracle = new MockTreeSequential();
    }

    // ── Differential fuzzing against the previous implementation ──────────────

    function testFuzz_pairMatchesSequential(bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0));

        tree.insertPair(a, b);
        oracle.insertPairSequentially(a, b);

        assertEq(tree.getLastRoot(), oracle.lastRoot(), "root diverged after one pair");
        assertEq(tree.leafIndex(), oracle.nextIndex(), "index diverged after one pair");
    }

    // Arbitrary-length sequences are what actually exercise the even/odd branch at
    // successively deeper levels — the place an off-by-one in the starting level or
    // index would hide, and the place a single hand-written sequence cannot reach.
    function testFuzz_sequenceMatchesSequential(bytes32[16] memory leaves, uint8 pairCount) public {
        uint256 n = bound(pairCount, 1, 8);

        for (uint256 i = 0; i < n; i++) {
            bytes32 a = leaves[2 * i];
            bytes32 b = leaves[2 * i + 1];
            // Zero is rejected by both; substitute so the fuzzer spends its budget on
            // tree shape rather than on the one input we already reject explicitly.
            if (a == bytes32(0)) a = keccak256(abi.encode("a", i));
            if (b == bytes32(0)) b = keccak256(abi.encode("b", i));

            tree.insertPair(a, b);
            oracle.insertPairSequentially(a, b);

            assertEq(tree.getLastRoot(), oracle.lastRoot(), "root diverged mid-sequence");
            assertEq(tree.leafIndex(), oracle.nextIndex(), "index diverged mid-sequence");
        }
    }

    // Identical leaves are legal — two notes can share a commitment and still be spent
    // separately, because the nullifier binds the leaf index rather than the commitment.
    function testFuzz_duplicateLeavesAreAccepted(bytes32 a) public {
        vm.assume(a != bytes32(0));
        tree.insertPair(a, a);
        oracle.insertPairSequentially(a, a);
        assertEq(tree.getLastRoot(), oracle.lastRoot());
    }

    function testFuzz_zeroCommitmentAlwaysRejected(bytes32 other, bool zeroIsLeft) public {
        vm.assume(other != bytes32(0));
        vm.expectRevert(ZeroCommitment.selector);
        if (zeroIsLeft) tree.insertPair(bytes32(0), other);
        else            tree.insertPair(other, bytes32(0));
    }

    // ── Properties that hold regardless of the oracle ──────────────────────

    function testFuzz_indicesAreConsecutiveAndAligned(bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0));
        uint32 before_ = tree.leafIndex();
        (, uint32 l, uint32 r) = tree.insertPair(a, b);

        // These feed the nullifier. Shifting them by one would invalidate every proof.
        assertEq(l, before_, "left index moved");
        assertEq(r, before_ + 1, "right index not consecutive");
        assertEq(l % 2, 0, "pair not aligned to an even slot");
        assertEq(tree.leafIndex(), before_ + 2, "index did not advance by exactly two");
    }

    function testFuzz_everyCommittedRootIsKnown(bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0));
        tree.insertPair(a, b);
        assertTrue(tree.isKnownPoolRoot(tree.getLastRoot()), "current root not accepted");
    }

    function testFuzz_distinctLeavesMoveTheRoot(bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0));
        bytes32 before_ = tree.getLastRoot();
        tree.insertPair(a, b);
        assertTrue(tree.getLastRoot() != before_, "root did not change on insert");
        // And the old root stays valid — pool roots are deliberately never evicted.
        assertTrue(tree.isKnownPoolRoot(before_), "previous root was evicted");
    }
}

// Stateful invariants: the fuzzer drives long random call sequences and the properties
// below must hold after every one of them.
contract PoolTreeInvariantTest is Test {
    TreeHarness internal tree;
    TreeHandler internal handler;

    function setUp() public {
        tree    = new TreeHarness();
        handler = new TreeHandler(tree);
        targetContract(address(handler));
    }

    // The assumption the whole optimisation rests on. If nextIndex were ever odd,
    // nextIndex >> 1 would map two different pairs onto the same level-1 slot and
    // silently corrupt every proof rooted afterwards.
    function invariant_nextIndexIsAlwaysEven() public view {
        assertEq(tree.leafIndex() % 2, 0, "nextIndex went odd");
    }

    // Insertion happens in pairs, so the leaf count must track the call count exactly —
    // catching any path that inserts one leaf, or three.
    function invariant_indexTracksInsertionCount() public view {
        // Position is (tree, leaf) now, so the count is the global one — a rollover resets
        // leafIndex without losing any leaves.
        uint256 total = uint256(tree.treeNumber()) * (1 << 16) + uint256(tree.leafIndex());
        assertEq(total, handler.insertions() * 2, "leaf count drifted");
    }

    // A proof is built against a root the client saw; if a committed root were not
    // retained, every proof in flight against it would fail.
    function invariant_currentRootIsAlwaysAccepted() public view {
        assertTrue(tree.isKnownPoolRoot(tree.getLastRoot()), "current root not accepted");
    }

    function invariant_zeroIsNeverAValidRoot() public view {
        assertFalse(tree.isKnownPoolRoot(bytes32(0)), "zero root accepted");
    }
}

// Bounded actor for the invariant runs: only ever performs legal insertions, so the
// invariants describe reachable states rather than reverted ones.
contract TreeHandler is Test {
    TreeHarness public tree;
    uint256 public insertions;

    constructor(TreeHarness _tree) { tree = _tree; }

    function insertPair(bytes32 a, bytes32 b) external {
        if (a == bytes32(0)) a = keccak256(abi.encode(insertions, "a"));
        if (b == bytes32(0)) b = keccak256(abi.encode(insertions, "b"));
        tree.insertPair(a, b);
        insertions++;
    }
}
