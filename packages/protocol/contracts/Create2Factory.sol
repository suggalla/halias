// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Create2Factory {
    event Deployed(address addr, bytes32 salt);

    function deploy(bytes memory bytecode, bytes32 salt) external payable returns (address addr) {
        assembly {
            addr := create2(callvalue(), add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(addr != address(0), "CREATE2: deploy failed");
        emit Deployed(addr, salt);
    }

    function computeAddress(bytes memory bytecode, bytes32 salt) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode))
        );
        return address(uint160(uint256(hash)));
    }
}
