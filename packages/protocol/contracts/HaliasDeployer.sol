// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./HaliasRegistry.sol";
import "./HaliasPool.sol";
import "./HaliasController.sol";

error PredictionMismatch(address predicted, address actual);

/// @title  HaliasDeployer — brings the three contracts up in one transaction
/// @notice Deploys {HaliasRegistry}, {HaliasPool} and {HaliasController} already wired to each
///         other, with every reference immutable.
/// @dev    The three have a dependency cycle: the pool reads the registry, the domain writes
///         to the registry and spends from the pool, and the registry has to name its
///         controller — the domain — before that contract exists.
///
///         CREATE2 cannot break it. A CREATE2 address is
///         `keccak(0xff ++ factory ++ salt ++ keccak(initCode))` and `initCode` carries the
///         ABI-encoded constructor arguments, so predicting the domain's address needs the
///         pool and registry addresses, which need the domain's. The prediction is circular.
///
///         Plain CREATE is `keccak(rlp([sender, nonce]))` — no constructor arguments in it.
///         A contract's nonce starts at 1 and increments per deployment, so this constructor
///         can compute its own third CREATE address before making the first, close the loop,
///         and assert it was right.
///
///         Doing it on-chain rather than from a script is what makes it atomic. A script
///         predicting off-chain from the deployer's nonce is correct only if nothing else
///         sends a transaction from that account in between; if something does, the registry
///         is deployed authorising an address that will never hold code, nothing reverts, and
///         the failure surfaces later as a registration that cannot work.
contract HaliasDeployer {
    HaliasRegistry public immutable registry;
    HaliasPool     public immutable pool;
    HaliasController   public immutable domain;

    constructor(address transactVerifier, address admin) {
        // Third CREATE from this contract. Computed before any of them so the registry can
        // be constructed already knowing its controller.
        address predictedDomain = _selfCreateAddress(3);

        registry = new HaliasRegistry(predictedDomain);                        // nonce 1
        pool     = new HaliasPool(transactVerifier, address(registry));        // nonce 2
        domain   = new HaliasController(address(pool), address(registry), admin);  // nonce 3

        // Cannot fail as written. It is here because if it ever does, the registry has
        // named a controller that will never exist and the whole deployment is inert —
        // which is worth reverting for rather than discovering after the fact.
        if (address(domain) != predictedDomain) {
            revert PredictionMismatch(predictedDomain, address(domain));
        }
    }

    /// @dev The address this contract's `nonce`-th CREATE will produce.
    ///
    ///      RLP of `[address(this), nonce]` for `1 <= nonce <= 0x7f`: the payload is a
    ///      20-byte string (0x94 prefix) plus a single-byte integer that encodes as itself,
    ///      giving 22 bytes, so the list prefix is 0xc0 + 22 = 0xd6. Nonces above 0x7f would
    ///      need a longer encoding; three deployments never reach it.
    function _selfCreateAddress(uint8 nonce) private view returns (address) {
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(nonce))
        ))));
    }
}
