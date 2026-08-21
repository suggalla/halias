// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";
import { TreeZeros } from "../base/TreeZeros.sol";

/// @dev Measurement only. Each function is non-view so the cost shows up as gasUsed, and
///      each returns a value derived from the result so nothing can be optimised away.
contract GasProbe {
    uint256 public sink;

    // A copy of SMTRegistry._smtUpdate's loop, storage and all, so the cost of one level of
    // registry depth can be measured rather than estimated. Poseidon alone is the smaller
    // half: each level also reads a sibling and writes a node.
    mapping(uint256 => bytes32)[32] private nodes;
    uint32 private slot;

    // The same walk if the tree were append-only, in the shape MerkleTreeWithHistory uses:
    // a fixed `filledSubtrees` array instead of a node per position, written only on the even
    // branch and permanently warm. This is what making the registry immutable would buy — the
    // question is whether it buys levels or only cheaper levels.
    bytes32[32] private filled;
    uint32 private appendIndex;

    function walkAppend(uint256 levels) external {
        uint256 idx = appendIndex++;
        bytes32 current = bytes32(PoseidonT4.hash([uint256(1), uint256(2), 1]));
        for (uint256 i = 0; i < levels; i++) {
            if (idx % 2 == 0) {
                filled[i] = current;
                current = bytes32(PoseidonT3.hash([uint256(current), uint256(TreeZeros.zeros(i))]));
            } else {
                current = bytes32(PoseidonT3.hash([uint256(filled[i]), uint256(current)]));
            }
            idx /= 2;
        }
        sink = uint256(current);
    }

    function walk(uint256 levels) external {
        uint256 pathKey = slot++;
        bytes32 current = bytes32(PoseidonT4.hash([uint256(1), uint256(2), 1]));
        for (uint256 i = 0; i < levels; i++) {
            uint256 nodePath    = pathKey >> i;
            bytes32 sibling     = nodes[i][nodePath ^ 1];
            if (sibling == bytes32(0)) sibling = TreeZeros.zeros(i);
            nodes[i][nodePath] = current;
            current = (nodePath & 1) == 1
                ? bytes32(PoseidonT3.hash([uint256(sibling), uint256(current)]))
                : bytes32(PoseidonT3.hash([uint256(current), uint256(sibling)]));
        }
        sink = uint256(current);
    }

    /// n hashes in a chain, so the marginal cost comes out as a slope and every fixed cost —
    /// the 21k base, the calldata, the SSTORE — cancels between two runs. Subtracting one
    /// call shape from another does not cancel: they carry different calldata.
    function chainT3(uint256 n) external {
        uint256 h = 1;
        for (uint256 i = 0; i < n; i++) h = PoseidonT3.hash([h, i]);
        sink = h;
    }

    function chainT4(uint256 n) external {
        uint256 h = 1;
        for (uint256 i = 0; i < n; i++) h = PoseidonT4.hash([h, i, 1]);
        sink = h;
    }

    /// A 20-value fold, the shape full public-input packing would need on chain: 20 -> 7 -> 3
    /// -> 1 through 3-input Poseidon.
    function probeFold20(uint256[20] calldata v) external {
        uint256[7] memory a;
        for (uint256 i = 0; i < 6; i++) a[i] = PoseidonT4.hash([v[i*3], v[i*3+1], v[i*3+2]]);
        a[6] = PoseidonT3.hash([v[18], v[19]]);
        uint256[3] memory b;
        for (uint256 i = 0; i < 2; i++) b[i] = PoseidonT4.hash([a[i*3], a[i*3+1], a[i*3+2]]);
        b[2] = a[6];
        sink = PoseidonT4.hash([b[0], b[1], b[2]]);
    }

    /// The same 20 values through keccak, which is what the EVM is actually good at.
    function probeKeccak20(uint256[20] calldata v) external {
        sink = uint256(keccak256(abi.encodePacked(v)));
    }

    function noop(uint256[20] calldata v) external {
        sink = v[0];
    }
}
