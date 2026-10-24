// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {Kind, Status} from "../libraries/PoolKey.sol";
import {Clearing} from "../libraries/Clearing.sol";

/// @notice Physical lending of a European pool's asset (blueprint 7.9, ARCH 2.6.1, decision A). The only caller of
/// the core's restricted `lend` / `returnLent` / `topUpLent`. The core enforces the hard limits (European only,
/// at most half of the pool's asset lent, margin >= 120% at the last clearing price, before the cutoff
/// `expiry - LEND_CUTOFF`); this contract keeps the per-borrower loans the core only sees in aggregate.
/// After the cutoff nothing needs to happen here: the core lazily books unreturned units as `shortUnits` and their
/// whole margin as `shortMargin` (repayers are paid out of it, the rest goes to the C holders at window end).
/// Holds nothing between calls: margin and fee go straight to the core, released margin to the core's `pending`.
contract Specials {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MARGIN_BPS = 12_000; // mirrors the core's LEND_MARGIN_BPS
    uint256 internal constant YEAR = 365 days;

    struct Loan {
        address borrower;
        bytes32 poolId;
        uint96 units; // units still out
        uint128 margin; // margin posted for them (core-held)
    }

    IConfluere public core;
    address private immutable _binder;
    /// @notice Lending fee floor, annualised on the units' value at the last clearing price (spec 3.5, founder
    /// approval pending). The fee is paid into the pool's quoteBal: it belongs to all C holders.
    uint16 public immutable minFeeBpsPerYear;

    uint256 public nextId = 1;
    mapping(uint256 => Loan) public loans;

    event Opened(
        uint256 indexed loanId,
        bytes32 indexed poolId,
        address indexed borrower,
        uint96 units,
        uint128 margin,
        uint128 fee
    );
    event ToppedUp(uint256 indexed loanId, uint128 amount);
    event Closed(uint256 indexed loanId, uint96 units, uint128 marginOut);

    error AlreadyBound();
    error InvalidParams();
    error NotBorrower();
    error FeeTooLow();

    /// @param binder_ the account allowed to call `bind` once (CREATE2 factory deployments: msg.sender is the
    /// factory). The core stores this contract's address as SPECIALS, so the two cannot both be immutable.
    constructor(address binder_, uint16 minFeeBpsPerYear_) {
        if (binder_ == address(0)) revert InvalidParams();
        _binder = binder_;
        minFeeBpsPerYear = minFeeBpsPerYear_;
    }

    function bind(IConfluere core_) external {
        if (msg.sender != _binder || address(core) != address(0) || core_.SPECIALS() != address(this)) {
            revert AlreadyBound();
        }
        core = core_;
    }

    // ================================================================ views

    /// @notice Minimum margin the core accepts: 120% of the units at the pool's last clearing price, rounded up.
    function minMargin(bytes32 poolId, uint96 units) public view returns (uint128) {
        IConfluere.PoolView memory v = core.pool(poolId);
        return uint128(
            Clearing.quoteUp(units, uint256(v.lastClearingPrice) * MARGIN_BPS, 10 ** uint256(v.assetDecimals) * BPS)
        );
    }

    /// @notice Minimum lending fee: units at the last clearing price × minFeeBpsPerYear × time to expiry.
    function minFee(bytes32 poolId, uint96 units) public view returns (uint128) {
        IConfluere.PoolView memory v = core.pool(poolId);
        if (block.timestamp >= v.key.expiry || minFeeBpsPerYear == 0) return 0;
        uint256 value = Clearing.quoteUp(units, v.lastClearingPrice, 10 ** uint256(v.assetDecimals));
        return uint128(value * minFeeBpsPerYear * (v.key.expiry - block.timestamp) / (YEAR * BPS));
    }

    /// @notice Lending ends at expiry - LEND_CUTOFF (mainnet: Thursday 20:00 UTC of the expiry week).
    function cutoff(bytes32 poolId) public view returns (uint256) {
        return core.pool(poolId).key.expiry - core.LEND_CUTOFF();
    }

    /// @notice A loan with units still out at the cutoff is defaulted: the core has booked it as short and the
    /// whole margin as forfeited. No transaction is needed for that.
    function defaulted(uint256 loanId) external view returns (bool) {
        Loan storage l = loans[loanId];
        return l.units != 0 && block.timestamp >= cutoff(l.poolId);
    }

    /// @notice Lendable units left in a pool: half of its asset minus what is already out.
    function available(bytes32 poolId) external view returns (uint256) {
        IConfluere.PoolView memory v = core.pool(poolId);
        if (v.key.kind != Kind.European || v.status != Status.Open) return 0;
        uint256 cap = v.assetBal * 5000 / BPS;
        return cap > v.lentUnits ? cap - v.lentUnits : 0;
    }

    // ================================================================ actions

    /// @notice Borrow `units` of the pool's asset to `to`, posting `margin` (>= minMargin) and paying `fee`
    /// (>= minFee) to the pool's C holders. Pulls margin + fee from the caller.
    function open(bytes32 poolId, uint96 units, uint128 margin, uint128 fee, address to)
        external
        returns (uint256 loanId)
    {
        if (units == 0 || to == address(0) || margin < minMargin(poolId, units)) revert InvalidParams();
        if (fee < minFee(poolId, units)) revert FeeTooLow();
        IERC20 quote = IERC20(core.pool(poolId).key.quote);
        uint256 amount = uint256(margin) + fee;
        quote.safeTransferFrom(msg.sender, address(this), amount);
        quote.forceApprove(address(core), amount);
        core.lend(poolId, units, to, margin, fee);
        loanId = nextId++;
        loans[loanId] = Loan(msg.sender, poolId, units, margin);
        emit Opened(loanId, poolId, msg.sender, units, margin, fee);
    }

    /// @notice Voluntary margin top-up (anyone may add to a loan; it stays the borrower's margin).
    function topUp(uint256 loanId, uint128 amount) external {
        Loan storage l = loans[loanId];
        if (l.units == 0 || amount == 0) revert InvalidParams();
        IERC20 quote = IERC20(core.pool(l.poolId).key.quote);
        quote.safeTransferFrom(msg.sender, address(this), amount);
        quote.forceApprove(address(core), amount);
        core.topUpLent(l.poolId, amount);
        l.margin += amount;
        emit ToppedUp(loanId, amount);
    }

    /// @notice Return `units` of the asset before the cutoff. The margin share is released to the borrower's
    /// `pending` on the core (withdraw from the core). Returning everything releases the whole margin.
    function close(uint256 loanId, uint96 units) external {
        Loan storage l = loans[loanId];
        if (msg.sender != l.borrower) revert NotBorrower();
        if (units == 0 || units > l.units) revert InvalidParams();
        uint128 marginOut = units == l.units ? l.margin : uint128(uint256(l.margin) * units / l.units);
        l.units -= units;
        l.margin -= marginOut;
        IERC20 asset = IERC20(core.pool(l.poolId).key.asset);
        asset.safeTransferFrom(msg.sender, address(this), units);
        asset.forceApprove(address(core), units);
        core.returnLent(l.poolId, units, marginOut, l.borrower);
        emit Closed(loanId, units, marginOut);
    }
}
