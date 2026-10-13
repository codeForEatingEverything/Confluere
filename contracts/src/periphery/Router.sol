// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKeyLib} from "../libraries/PoolKey.sol";
import {SELL, BUY, NC_SELL, NC_BUY} from "../libraries/OrderSet.sol";
import {Clearing} from "../libraries/Clearing.sol";

interface IConfluere6909 {
    function transferFrom(address sender, address receiver, uint256 id, uint256 amount) external returns (bool);
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @notice Bundles multi-step actions. Holds nothing between calls. Orders placed through it belong to the caller.
/// Position actions (repay, claim) need the caller to set this router as an ERC-6909 operator on the core.
contract Router {
    using SafeERC20 for IERC20;
    using PoolKeyLib for bytes32;

    IConfluere public immutable core;

    constructor(IConfluere core_) {
        core = core_;
    }

    /// @notice Pull exactly what the order escrows from the caller and place it with the caller as owner.
    function placeOrders(bytes32[] calldata poolIds, IConfluere.OrderParams[] calldata ps)
        external
        returns (uint64[] memory ids)
    {
        ids = new uint64[](ps.length);
        for (uint256 i; i < ps.length; ++i) {
            IConfluere.PoolView memory v = core.pool(poolIds[i]);
            IConfluere.OrderParams memory p = ps[i];
            p.owner = msg.sender;
            (address token, uint256 amount) = _escrowOf(v, p);
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            IERC20(token).forceApprove(address(core), amount);
            ids[i] = core.placeOrder(poolIds[i], p);
        }
    }

    /// @notice Repay on behalf of the caller: moves the caller's R here, pays K from the caller, returns the asset.
    function repay(bytes32 poolId, uint96 units) external {
        IConfluere.PoolView memory v = core.pool(poolId);
        uint256 pay = Clearing.quoteUp(units, v.key.strike, 10 ** uint256(v.assetDecimals));
        IConfluere6909(address(core)).transferFrom(msg.sender, address(this), poolId.rId(), units);
        IERC20(v.key.quote).safeTransferFrom(msg.sender, address(this), pay);
        IERC20(v.key.quote).forceApprove(address(core), pay);
        core.repay(poolId, units);
        IERC20(v.key.asset).safeTransfer(msg.sender, units);
    }

    /// @notice Claim several closed pools at once and forward everything to the caller.
    function claimMany(bytes32[] calldata poolIds) external {
        for (uint256 i; i < poolIds.length; ++i) {
            bytes32 pid = poolIds[i];
            IConfluere.PoolView memory v = core.pool(pid);
            uint256 c = IConfluere6909(address(core)).balanceOf(msg.sender, pid.cId());
            uint256 r = IConfluere6909(address(core)).balanceOf(msg.sender, pid.rId()) - core.lockedR(msg.sender, pid);
            if (c != 0) IConfluere6909(address(core)).transferFrom(msg.sender, address(this), pid.cId(), c);
            if (r != 0) IConfluere6909(address(core)).transferFrom(msg.sender, address(this), pid.rId(), r);
            (uint256 q, uint256 a) = core.claim(pid);
            if (q != 0) IERC20(v.key.quote).safeTransfer(msg.sender, q);
            if (a != 0) IERC20(v.key.asset).safeTransfer(msg.sender, a);
        }
    }

    function _escrowOf(IConfluere.PoolView memory v, IConfluere.OrderParams memory p)
        internal
        pure
        returns (address, uint256)
    {
        if (p.side == SELL || p.side == NC_SELL) return (v.key.asset, p.units);
        if (p.side == NC_BUY) return (v.key.quote, p.budget);
        return (v.key.quote, Clearing.quoteUp(p.units, p.limit, 10 ** uint256(v.assetDecimals)) + p.ttl);
    }
}
