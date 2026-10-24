// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKeyLib} from "../libraries/PoolKey.sol";
import {SELL} from "../libraries/OrderSet.sol";

/// @notice Converts quote into the pool's asset through the asset's own mint path (e.g. WETH -> wstETH via Lido
/// staking). Chosen by the position owner; the Looper never calls a DEX itself.
interface ILoopMinter {
    function mint(address quote, address asset, uint256 amountIn, address to) external returns (uint256 assetOut);
}

interface IConfluere6909Transfer {
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @notice One looping position (spec 3.6 option 1, founder approval pending). The core only trades in batches, so
/// "borrow -> mint -> borrow again" cannot happen inside one transaction (and the core's flash loan cannot re-enter
/// the core). The account instead owns its sell orders: after each batch anyone may call `step`, which collects the
/// proceeds, mints more asset through the owner's minter and places the next sell, until the rounds run out. R
/// tokens and every refund stay in the account (its own core `pending`, so positions never mix) until `exit`.
contract LoopAccount {
    using SafeERC20 for IERC20;
    using PoolKeyLib for bytes32;

    IConfluere public immutable core;
    address public immutable owner;
    bytes32 public immutable poolId;
    ILoopMinter public immutable minter;
    IERC20 public immutable asset;
    IERC20 public immutable quote;
    uint96 public immutable limit; // sell limit for every round
    uint16 public immutable ttl;

    uint8 public roundsLeft;
    uint64 public orderId; // live sell order, 0 when none

    event Stepped(uint8 roundsLeft, uint64 orderId, uint256 units);
    event Exited(address indexed to, uint256 asset, uint256 quote, uint256 r);

    error NotOwner();
    error Busy();

    constructor(
        IConfluere core_,
        address owner_,
        bytes32 poolId_,
        ILoopMinter minter_,
        address asset_,
        address quote_,
        uint96 limit_,
        uint16 ttl_,
        uint8 rounds_
    ) {
        core = core_;
        owner = owner_;
        poolId = poolId_;
        minter = minter_;
        asset = IERC20(asset_);
        quote = IERC20(quote_);
        limit = limit_;
        ttl = ttl_;
        roundsLeft = rounds_;
    }

    /// @notice True while the current sell order is still on the book.
    function live() public view returns (bool) {
        if (orderId == 0) return false;
        (address o,,,,,,,) = core.order(poolId, orderId);
        return o == address(this);
    }

    /// @notice Permissionless: once the previous order is off the book, collect, mint and place the next round.
    function step() external {
        if (live()) revert Busy();
        orderId = 0;
        _collect();
        if (roundsLeft == 0) return;
        uint256 q = quote.balanceOf(address(this));
        if (q != 0 && address(minter) != address(0)) {
            quote.forceApprove(address(minter), q);
            minter.mint(address(quote), address(asset), q, address(this));
            quote.forceApprove(address(minter), 0);
        }
        uint256 units = asset.balanceOf(address(this));
        if (units == 0 || units > type(uint96).max) return;
        roundsLeft -= 1;
        asset.forceApprove(address(core), units);
        orderId = core.placeOrder(
            poolId,
            IConfluere.OrderParams({
                side: SELL,
                units: uint96(units),
                limit: limit,
                budget: 0,
                ttl: ttl,
                hint: core.findHint(poolId, SELL, limit),
                owner: address(this)
            })
        );
        emit Stepped(roundsLeft, orderId, units);
    }

    /// @notice Owner only: cancel the live order, stop looping and send every asset, quote and R unit to `to`.
    function exit(address to) external {
        if (msg.sender != owner) revert NotOwner();
        if (live()) core.cancelOrder(poolId, orderId);
        orderId = 0;
        roundsLeft = 0;
        _collect();
        uint256 a = asset.balanceOf(address(this));
        uint256 q = quote.balanceOf(address(this));
        uint256 rId = poolId.rId();
        uint256 r = IConfluere6909Transfer(address(core)).balanceOf(address(this), rId);
        if (a != 0) asset.safeTransfer(to, a);
        if (q != 0) quote.safeTransfer(to, q);
        if (r != 0) IConfluere6909Transfer(address(core)).transfer(to, rId, r);
        emit Exited(to, a, q, r);
    }

    function _collect() internal {
        if (core.pending(address(quote), address(this)) != 0) core.withdraw(address(quote), address(this));
        if (core.pending(address(asset), address(this)) != 0) core.withdraw(address(asset), address(this));
    }
}

/// @notice Opens looping positions: deploys a LoopAccount for the caller, funds it with the first asset tranche and
/// places round one. Holds nothing.
contract Looper {
    using SafeERC20 for IERC20;

    IConfluere public immutable core;

    event Opened(address indexed owner, address indexed account, bytes32 indexed poolId, uint256 units, uint8 rounds);

    error InvalidParams();

    constructor(IConfluere core_) {
        core = core_;
    }

    /// @param units first tranche of asset pulled from the caller
    /// @param limit sell limit for every round (quote per asset unit)
    /// @param rounds number of sell rounds including the first (1..32)
    function open(bytes32 poolId, uint96 units, uint96 limit, uint16 ttl, uint8 rounds, ILoopMinter minter)
        external
        returns (LoopAccount acct)
    {
        if (units == 0 || limit == 0 || ttl == 0 || rounds == 0 || rounds > 32) revert InvalidParams();
        IConfluere.PoolView memory v = core.pool(poolId);
        acct = new LoopAccount(core, msg.sender, poolId, minter, v.key.asset, v.key.quote, limit, ttl, rounds);
        IERC20(v.key.asset).safeTransferFrom(msg.sender, address(acct), units);
        acct.step();
        emit Opened(msg.sender, address(acct), poolId, units, rounds);
    }
}
