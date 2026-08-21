// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";

/// @dev Measurement only. Each function is non-view so the cost shows up as gasUsed, and
///      each returns a value derived from the result so nothing can be optimised away.
contract GasProbe {
    uint256 public sink;

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
