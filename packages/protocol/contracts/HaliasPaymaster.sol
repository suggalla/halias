// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IPaymaster, IEntryPoint, IEntryPointStake} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "./base/Constants.sol";
import "./base/Errors.sol";
import "./interfaces/IHalias.sol";

/**
 * @title HaliasPaymaster
 * @dev Sponsors UserOps via two paths:
 *
 *  PATH_POOL_NOTE (0x00) — ETH pool note: transact() withdrawing ETH to this paymaster.
 *    postOp deposits absAmount to EntryPoint; surplus builds a revolving ETH reserve.
 *
 *  PATH_ERC20_NOTE (0x01) — ERC-20 pool note: transact() withdrawing tokens to this paymaster.
 *    Admin sets tokenRate (tokens per ETH, token-decimal adjusted) + RATE_PADDING_BPS buffer.
 *    postOp does nothing — admin converts accumulated tokens to ETH off-chain to replenish deposit.
 *
 * paymasterAndData layout (ERC-4337 v0.7):
 *   [0:20]  paymaster address              (read by EntryPoint)
 *   [20:36] paymasterVerificationGasLimit  (read by EntryPoint, uint128 big-endian)
 *   [36:52] postOpGasLimit                 (read by EntryPoint, uint128 big-endian)
 *   [52]    path type (0x00 = ETH pool note | 0x01 = ERC-20 pool note)
 */
contract HaliasPaymaster is IPaymaster, Ownable {
    using SafeERC20 for IERC20;

    IEntryPoint public immutable entryPoint;
    address public halias;

    uint8 private constant PATH_POOL_NOTE  = 0;
    uint8 private constant PATH_ERC20_NOTE = 1;
    uint8 private constant PATH_REGISTER   = 2;

    // Token units per 1 ETH, scaled to token decimals.
    // e.g. USDC (6 dec) at $3000/ETH: tokenRate[USDC] = 3000 * 1e6
    mapping(address => uint256) public tokenRate;

    // Fixed overcollateral buffer applied on top of admin-set rate.
    // Protects against rate staleness between admin updates.
    uint256 public constant RATE_PADDING_BPS = 2000; // 20%

    bytes4 private constant EXECUTE_SELECTOR =
        bytes4(keccak256("execute(address,uint256,bytes)"));
    bytes4 private constant TRANSACT_SELECTOR = IHalias.transact.selector;
    bytes4 private constant REGISTER_SELECTOR = IHalias.registerWithPoolNote.selector;

    error CalldataTooShort();
    error InvalidExecuteTarget();
    error InvalidInnerSelector();
    error PaymasterDataTooShort();
    error UnknownPathType();
    error GasTransactRecipientNotPaymaster();
    error RegisterRecipientNotHalias();
    error ERC20CannotPayGas();
    error MustWithdrawToPayGas();
    error GasBudgetTooSmall();
    error RegisterNoteTooSmall();
    error TokenRateNotSet();
    error TokenGasBudgetTooSmall();

    event TokenRateSet(address indexed token, uint256 rate);

    constructor(address _entryPoint, address _halias) Ownable(msg.sender) {
        entryPoint = IEntryPoint(_entryPoint);
        halias     = _halias;
    }

    function setHalias(address _halias) external onlyOwner {
        if (_halias == address(0)) revert ZeroAddress();
        halias = _halias;
    }

    // ── validatePaymasterUserOp ───────────────────────────────────────────────

    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external view override returns (bytes memory context, uint256) {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (userOp.paymasterAndData.length < 53) revert PaymasterDataTooShort();

        uint8 pathType = uint8(userOp.paymasterAndData[52]);

        if (pathType == PATH_POOL_NOTE)  return _validatePoolNote(userOp, maxCost);
        if (pathType == PATH_ERC20_NOTE) return _validateERC20Note(userOp, maxCost);
        if (pathType == PATH_REGISTER)   return _validateRegisterNote(userOp, maxCost);
        revert UnknownPathType();
    }

    function _validatePoolNote(
        PackedUserOperation calldata userOp,
        uint256 maxCost
    ) internal view returns (bytes memory, uint256) {
        if (userOp.callData.length < 456) revert CalldataTooShort();
        _requireExecuteCall(userOp.callData, TRANSACT_SELECTOR);

        TransactParams memory p = _decodeParams(userOp.callData);

        if (p.recipient != address(this)) revert GasTransactRecipientNotPaymaster();
        if (p.tokenAddress != 0)          revert ERC20CannotPayGas();

        bool isWithdraw = p.publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        if (!isWithdraw) revert MustWithdrawToPayGas();

        uint256 absAmount = FIELD_PRIME - p.publicAmount;
        if (absAmount < maxCost) revert GasBudgetTooSmall();

        return (abi.encode(uint8(PATH_POOL_NOTE), bytes32(absAmount)), 0);
    }

    function _validateERC20Note(
        PackedUserOperation calldata userOp,
        uint256 maxCost
    ) internal view returns (bytes memory, uint256) {
        if (userOp.callData.length < 456) revert CalldataTooShort();
        _requireExecuteCall(userOp.callData, TRANSACT_SELECTOR);

        TransactParams memory p = _decodeParams(userOp.callData);

        if (p.recipient != address(this)) revert GasTransactRecipientNotPaymaster();

        address token = address(uint160(p.tokenAddress));
        uint256 rate  = tokenRate[token];
        if (rate == 0) revert TokenRateNotSet();

        bool isWithdraw = p.publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        if (!isWithdraw) revert MustWithdrawToPayGas();

        uint256 absAmount = FIELD_PRIME - p.publicAmount;
        // requiredTokens = maxCost (wei) × rate (tokens/ETH) × padding / 1e18
        uint256 required = maxCost * rate * (10000 + RATE_PADDING_BPS) / (1e18 * 10000);
        if (absAmount < required) revert TokenGasBudgetTooSmall();

        return (abi.encode(uint8(PATH_ERC20_NOTE), bytes32(0)), 0);
    }

    function _validateRegisterNote(
        PackedUserOperation calldata userOp,
        uint256 maxCost
    ) internal view returns (bytes memory, uint256) {
        // Same min-length as transact(): execute wrapper (132) + selector (4) + TransactParams (320).
        if (userOp.callData.length < 456) revert CalldataTooShort();
        _requireExecuteCall(userOp.callData, REGISTER_SELECTOR);

        TransactParams memory p = _decodeParams(userOp.callData);

        if (p.recipient != halias) revert RegisterRecipientNotHalias();

        bool isWithdraw = p.publicAmount >= (FIELD_PRIME - MAX_ABS_AMOUNT);
        if (!isWithdraw) revert MustWithdrawToPayGas();

        uint256 absAmount = FIELD_PRIME - p.publicAmount;
        // Reads halias.registrationFee() dynamically — always current.
        // Allowed under ERC-7562 because halias is staked — a staked contract's storage may be read.
        uint256 fee = IHalias(halias).registrationFee();
        if (absAmount < fee + maxCost) revert RegisterNoteTooSmall();

        return (abi.encode(uint8(PATH_REGISTER), bytes32(0)), 0);
    }

    // ── postOp ────────────────────────────────────────────────────────────────

    function postOp(
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256,
        uint256
    ) external override {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();

        (uint8 pathType, bytes32 data) = abi.decode(context, (uint8, bytes32));

        if (pathType == PATH_POOL_NOTE && mode == IPaymaster.PostOpMode.opSucceeded) {
            uint256 absAmount = uint256(data);
            if (absAmount > 0) entryPoint.depositTo{value: absAmount}(address(this));
            // opReverted: pool note not spent — do nothing.
        }
        // PATH_ERC20_NOTE: paymaster holds tokens after transact() withdrawal.
        // Admin converts accumulated tokens → ETH off-chain to replenish EP deposit.
        //
        // PATH_REGISTER: registerWithPoolNote() already credited absAmount to
        // Halias.accumulatedFees. Gas cost is absorbed by this paymaster's EP deposit.
        // No action needed here.
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Verifies the UserOp invokes execute(halias, …) wrapping the expected inner Halias
    // call. The inner selector check is essential: postOp trusts that a pool-note path
    // actually ran transact() and delivered ETH, so without pinning the inner selector a
    // different inner call that passes _decodeParams checks could drain the paymaster.
    function _requireExecuteCall(bytes calldata cd, bytes4 innerSelector) private view {
        bytes4 outerSel;
        address callTarget;
        bytes4 actualInnerSel;
        assembly {
            outerSel       := calldataload(cd.offset)
            callTarget     := calldataload(add(cd.offset, 4))
            actualInnerSel := calldataload(add(cd.offset, 132))
        }
        if (outerSel != EXECUTE_SELECTOR || callTarget != halias) revert InvalidExecuteTarget();
        if (actualInnerSel != innerSelector) revert InvalidInnerSelector();
    }

    // TransactParams is all-static, so it encodes inline at the start of both
    // transact() and registerWithPoolNote() ABI heads — skip the execute wrapper
    // (132 bytes) and the inner selector (4 bytes), then decode.
    function _decodeParams(bytes calldata cd) internal pure returns (TransactParams memory) {
        return abi.decode(cd[136:], (TransactParams));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    // Set token → ETH rate for ERC-20 gas payment.
    // rate = token units per 1 ETH, scaled to token decimals.
    // e.g. USDC (6 dec) at 3000 USDC/ETH: rate = 3000 * 1e6
    // Set rate = 0 to disable a token.
    function setTokenRate(address token, uint256 rate) external onlyOwner {
        tokenRate[token] = rate;
        emit TokenRateSet(token, rate);
    }

    // Sweep accumulated ERC-20 tokens to owner for off-chain ETH conversion.
    function sweepToken(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
    }

    // IEntryPointStake wrappers — restricted to owner so only deployer can manage stake.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        IEntryPointStake(address(entryPoint)).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        IEntryPointStake(address(entryPoint)).unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        IEntryPointStake(address(entryPoint)).withdrawStake(to);
    }

    function withdrawEntryPointDeposit(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function withdrawBalance(address payable to) external onlyOwner {
        Address.sendValue(to, address(this).balance);
    }

    receive() external payable {}
}
