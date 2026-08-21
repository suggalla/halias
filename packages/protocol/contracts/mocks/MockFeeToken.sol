// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ERC-20 that silently takes a 10% fee on every non-mint/burn transfer.
// Used to verify Halias rejects fee-on-transfer tokens.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, to, value - fee);
            super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}
