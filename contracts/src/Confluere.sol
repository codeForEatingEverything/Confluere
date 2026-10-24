// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC6909, IERC6909TokenSupply} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";

import {IConfluere} from "./interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "./libraries/PoolKey.sol";
import {GridConfig, Grid} from "./libraries/Grid.sol";
import {Order, Book, OrderSet} from "./libraries/OrderSet.sol";
import {Clearing} from "./libraries/Clearing.sol";
import {CoreState, PoolState, Params, CoreLib} from "./libraries/State.sol";
import {OrderLogic} from "./libraries/logic/OrderLogic.sol";
import {ClearingLogic} from "./libraries/logic/ClearingLogic.sol";
import {WindowLogic} from "./libraries/logic/WindowLogic.sol";

/// @title Confluere
/// @notice Outright-repo lending: borrowers sell an asset into a fixed-expiry pool through uniform-price batch
/// auctions and may buy it back at K. Settlement compares only token amounts and block numbers. There is no oracle,
/// no liquidation, no owner, no upgrade path and no DEX call.
/// @dev Singleton. All storage and funds live here. Heavy logic sits in stateless linked libraries (OrderLogic,
/// ClearingLogic, WindowLogic) whose addresses are fixed at deployment, to stay under the EIP-170 size limit.
contract Confluere is IConfluere, IERC6909TokenSupply, IERC3156FlashLender, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolKeyLib for PoolKey;
    using PoolKeyLib for bytes32;
    using CoreLib for CoreState;
    using CoreLib for PoolState;
    using OrderSet for Book;

    uint256 public constant FLASH_FEE_BPS = 5; // 0.05%
    uint8 public constant GRADUATION_CYCLES = 4;
    bytes32 internal constant FLASH_CALLBACK = keccak256("ERC3156FlashBorrower.onFlashLoan");

    uint64 internal immutable GRID_ANCHOR;
    uint64 internal immutable GRID_PERIOD;
    uint64 internal immutable GRID_BATCH;
    uint32 internal immutable GRID_MAX_EXPIRIES;
    uint8 internal immutable GRID_SIG_DIGITS;

    uint64 public immutable WINDOW_BLOCKS;
    uint64 public immutable MAX_PAUSE_BLOCKS;
    uint32 public immutable MAX_ORDERS_PER_SIDE;
    uint32 public immutable MAX_BIDS;
    address public immutable treasury;
    address public immutable guardian;

    CoreState internal s;

    /// @notice Parameters that differ per chain. The constructor picks the row for `block.chainid`, so the init code
    /// (and therefore the CREATE2 address) is identical on every chain listed.
    struct ChainParams {
        uint256 chainId;
        uint64 windowBlocks; // about 2 hours of blocks on that chain
        uint64 maxPauseBlocks; // about 7 days of blocks on that chain
        address treasury;
        address guardian;
        address[] graduationQuotes;
        uint256[] graduationFees;
        address[] minNotionalQuotes; // anti-dust: smallest order per quote token, valued at K
        uint256[] minNotionals;
    }

    struct Config {
        GridConfig grid;
        uint32 maxOrdersPerSide;
        uint32 maxBids;
        ChainParams[] chains;
    }

    error UnsupportedChain();

    constructor(Config memory c) {
        Grid.validate(c.grid);
        if (c.maxOrdersPerSide == 0 || c.maxBids == 0) revert InvalidParams();
        uint256 k = type(uint256).max;
        for (uint256 i; i < c.chains.length; ++i) {
            if (c.chains[i].chainId == block.chainid) k = i;
        }
        if (k == type(uint256).max) revert UnsupportedChain();
        ChainParams memory cp = c.chains[k];
        if (
            cp.windowBlocks == 0 || cp.treasury == address(0) || cp.graduationQuotes.length != cp.graduationFees.length
                || cp.minNotionalQuotes.length != cp.minNotionals.length
        ) revert InvalidParams();
        GRID_ANCHOR = c.grid.anchor;
        GRID_PERIOD = c.grid.period;
        GRID_BATCH = c.grid.batchInterval;
        GRID_MAX_EXPIRIES = c.grid.maxExpiries;
        GRID_SIG_DIGITS = c.grid.strikeSigDigits;
        WINDOW_BLOCKS = cp.windowBlocks;
        MAX_PAUSE_BLOCKS = cp.maxPauseBlocks;
        MAX_ORDERS_PER_SIDE = c.maxOrdersPerSide;
        MAX_BIDS = c.maxBids;
        treasury = cp.treasury;
        guardian = cp.guardian;
        for (uint256 i; i < cp.graduationQuotes.length; ++i) {
            s.graduationFee[cp.graduationQuotes[i]] = cp.graduationFees[i];
        }
        for (uint256 i; i < cp.minNotionalQuotes.length; ++i) {
            s.minNotional[cp.minNotionalQuotes[i]] = cp.minNotionals[i];
        }
    }

    // ================================================================ pools

    /// @inheritdoc IConfluere
    function createPool(PoolKey calldata key, PoolOptions calldata opts) external nonReentrant returns (bytes32) {
        return OrderLogic.createPool(s, grid(), key, opts);
    }

    // ================================================================ orders

    /// @inheritdoc IConfluere
    function placeOrder(bytes32 poolId, OrderParams calldata p) external nonReentrant returns (uint64) {
        return OrderLogic.placeOrder(s, _params(), poolId, p, false);
    }

    /// @inheritdoc IConfluere
    /// @dev A commitment order: the owner cannot cancel it while it can still trade. Used for seat obligations.
    function placeLockedOrder(bytes32 poolId, OrderParams calldata p) external nonReentrant returns (uint64) {
        return OrderLogic.placeOrder(s, _params(), poolId, p, true);
    }

    /// @inheritdoc IConfluere
    function rollover(
        bytes32 oldPoolId,
        bytes32 newPoolId,
        uint96 units,
        uint96 minPrice,
        uint128 maxTopUp,
        uint16 ttl,
        uint64 hint
    ) external nonReentrant returns (uint64) {
        return OrderLogic.rollover(
            s, _params(), OrderLogic.RolloverArgs(oldPoolId, newPoolId, units, minPrice, maxTopUp, ttl, hint)
        );
    }

    /// @inheritdoc IConfluere
    function cancelOrder(bytes32 poolId, uint64 orderId) external nonReentrant {
        OrderLogic.cancelOrder(s, _params(), poolId, orderId);
    }

    /// @inheritdoc IConfluere
    function purge(bytes32 poolId, uint64[] calldata orderIds) external nonReentrant {
        OrderLogic.purge(s, poolId, orderIds);
    }

    /// @inheritdoc IConfluere
    function settleBatch(bytes32 poolId) external nonReentrant {
        ClearingLogic.settleBatch(s, _params(), poolId);
    }

    // ================================================================ maturity and settlement

    /// @inheritdoc IConfluere
    function mature(bytes32 poolId) external nonReentrant {
        WindowLogic.mature(s, _params(), poolId);
    }

    /// @inheritdoc IConfluere
    function repay(bytes32 poolId, uint96 units) external nonReentrant {
        WindowLogic.repay(s, poolId, units);
    }

    /// @inheritdoc IConfluere
    function bid(bytes32 poolId, uint96 units, uint96 surplusPerUnit, uint64 hint)
        external
        nonReentrant
        returns (uint64)
    {
        return OrderLogic.bid(s, _params(), poolId, units, surplusPerUnit, hint);
    }

    /// @inheritdoc IConfluere
    function closeWindow(bytes32 poolId, uint256 maxBids) external nonReentrant returns (bool) {
        return WindowLogic.closeWindow(s, _params(), poolId, maxBids);
    }

    /// @inheritdoc IConfluere
    function claim(bytes32 poolId) external nonReentrant returns (uint256, uint256) {
        return WindowLogic.claim(s, poolId);
    }

    /// @inheritdoc IConfluere
    function withdraw(address token, address to) external nonReentrant returns (uint256 amount) {
        amount = s.pending[token][msg.sender];
        if (amount == 0) return 0;
        s.pending[token][msg.sender] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, msg.sender, to, amount);
    }

    // ================================================================ guardian and graduation

    /// @inheritdoc IConfluere
    /// @dev Only for pools of markets that have not graduated. Blocks new orders and clearing, never cancel,
    /// repay, bids or claims. Marks the expiry as bad for graduation.
    function pause(bytes32 poolId, uint64 blocks) external {
        if (msg.sender != guardian) revert NotOwner();
        WindowLogic.pause(s, _params(), poolId, blocks);
    }

    /// @inheritdoc IConfluere
    function graduate(address asset, address quote, Kind kind, uint64 lastExpiry) external {
        WindowLogic.graduate(s, _params(), asset, quote, kind, lastExpiry);
    }

    // ================================================================ flash loans (ERC-3156)

    function maxFlashLoan(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function flashFee(address, uint256 amount) public pure returns (uint256) {
        return amount * FLASH_FEE_BPS / Clearing.BPS;
    }

    /// @dev Lends any balance the contract holds; the loan is atomic so escrows and pools are never at risk.
    /// The post-callback balance check is the point of ERC-3156; every state-changing entry is nonReentrant.
    // slither-disable-next-line reentrancy-balance
    function flashLoan(IERC3156FlashBorrower receiver, address token, uint256 amount, bytes calldata data)
        external
        nonReentrant
        returns (bool)
    {
        uint256 fee = flashFee(token, amount);
        uint256 before = IERC20(token).balanceOf(address(this));
        if (amount == 0 || amount > before) revert InvalidParams();
        IERC20(token).safeTransfer(address(receiver), amount);
        if (receiver.onFlashLoan(msg.sender, token, amount, fee, data) != FLASH_CALLBACK) revert FlashFailed();
        // ERC-3156: the receiver consented by returning FLASH_CALLBACK and approving amount + fee
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);
        if (IERC20(token).balanceOf(address(this)) < before + fee) revert FlashFailed();
        s.pending[token][treasury] += fee;
        s.flashFees[token] += fee;
        emit FlashLoan(address(receiver), token, amount, fee);
        return true;
    }

    // ================================================================ ERC-6909

    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return s.balanceOf[owner][id];
    }

    function totalSupply(uint256 id) external view returns (uint256) {
        return s.totalSupply[id];
    }

    function allowance(address owner, address spender, uint256 id) external view returns (uint256) {
        return s.allowance[owner][spender][id];
    }

    function isOperator(address owner, address spender) external view returns (bool) {
        return s.isOperator[owner][spender];
    }

    function approve(address spender, uint256 id, uint256 amount) external returns (bool) {
        s.allowance[msg.sender][spender][id] = amount;
        emit IERC6909.Approval(msg.sender, spender, id, amount);
        return true;
    }

    function setOperator(address spender, bool approved) external returns (bool) {
        s.isOperator[msg.sender][spender] = approved;
        emit IERC6909.OperatorSet(msg.sender, spender, approved);
        return true;
    }

    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool) {
        _transfer(msg.sender, receiver, id, amount);
        return true;
    }

    function transferFrom(address sender, address receiver, uint256 id, uint256 amount) external returns (bool) {
        if (sender != msg.sender && !s.isOperator[sender][msg.sender]) {
            uint256 allowed = s.allowance[sender][msg.sender][id];
            if (allowed != type(uint256).max) s.allowance[sender][msg.sender][id] = allowed - amount;
        }
        _transfer(sender, receiver, id, amount);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC6909).interfaceId
            || interfaceId == type(IERC6909TokenSupply).interfaceId
            || interfaceId == type(IERC3156FlashLender).interfaceId;
    }

    // ================================================================ views

    function grid() public view returns (GridConfig memory) {
        return GridConfig(GRID_ANCHOR, GRID_PERIOD, GRID_BATCH, GRID_MAX_EXPIRIES, GRID_SIG_DIGITS);
    }

    function pool(bytes32 poolId) external view returns (PoolView memory v) {
        PoolState storage ps = s.pools[poolId];
        v.key = ps.key;
        v.status = ps.status;
        v.assetDecimals = ps.assetDecimals;
        v.bandFailures = ps.bandFailures;
        v.settleCount = ps.settleCount;
        v.lastSettledBatch = ps.lastSettledBatch;
        v.windowEnd = ps.windowEnd;
        v.pausedUntil = ps.pausedUntil;
        v.pausedBlocks = ps.pausedBlocks;
        v.lastClearingPrice = ps.lastClearingPrice;
        v.bandBase = ps.bandBase;
        v.quoteBal = ps.quoteBal;
        v.assetBal = ps.assetBal;
        v.surplusBal = ps.surplusBal;
        v.feeEscrow = ps.feeEscrow;
        v.filledUnits = ps.filledUnits;
        v.repaidUnits = ps.repaidUnits;
        v.closeRemaining = ps.closeRemaining;
        v.options = PoolOptions(ps.minFill, ps.firstLo, ps.firstHi, ps.autoSell);
        v.batchInterval = uint64(ps.interval(GRID_BATCH));
    }

    function order(bytes32 poolId, uint64 orderId)
        external
        view
        returns (address owner, uint8 side, uint96 units, uint96 limit, uint128 escrow, uint32 deadline, uint64 next)
    {
        Order storage o = s.orders[poolId][orderId];
        return (o.owner, o.side, o.units, o.limit, o.escrow, o.deadline, o.next);
    }

    function rolloverSource(bytes32 poolId, uint64 orderId) external view returns (bytes32) {
        return s.rolloverOld[poolId][orderId];
    }

    function bookHead(bytes32 poolId, uint8 side) external view returns (uint64, uint32) {
        Book storage b = s.books[poolId][side];
        return (b.head, b.count);
    }

    function findHint(bytes32 poolId, uint8 side, uint96 limit) external view returns (uint64) {
        if (!OrderSet.sorted(side)) return 0;
        return s.books[poolId][side].findHint(s.orders[poolId], side, limit);
    }

    function nextBatchAt(bytes32 poolId) external view returns (uint256) {
        PoolState storage ps = s.pools[poolId];
        return uint256(GRID_ANCHOR) + uint256(ps.lastSettledBatch + 1) * ps.interval(GRID_BATCH);
    }

    function expiryWindowEnd(uint64 expiry) external view returns (uint64) {
        return s.windowEnd[expiry];
    }

    function graduated(bytes32 marketId) external view returns (bool) {
        return s.graduated[marketId];
    }

    function graduationFee(address quote) external view returns (uint256) {
        return s.graduationFee[quote];
    }

    /// @notice Cumulative spread share collected in a market (in its quote token). Lets the treasury split fees
    /// per market, e.g. with the market's seat holder (blueprint §9).
    function marketFees(bytes32 marketId) external view returns (uint256) {
        return s.marketFees[marketId];
    }

    /// @notice Cumulative flash-loan fees per token. With marketFees, every amount credited to the treasury is
    /// attributable to its source.
    function flashFees(address token) external view returns (uint256) {
        return s.flashFees[token];
    }

    function minNotional(address quote) external view returns (uint256) {
        return s.minNotional[quote];
    }

    function marketStats(bytes32 marketId, uint64 expiry) external view returns (MarketStats memory) {
        return s.stats[marketId][expiry];
    }

    function pending(address token, address account) external view returns (uint256) {
        return s.pending[token][account];
    }

    function lockedR(address account, bytes32 poolId) external view returns (uint256) {
        return s.lockedR[account][poolId];
    }

    // ================================================================ internals

    function _params() internal view returns (Params memory) {
        return Params(
            treasury,
            MAX_ORDERS_PER_SIDE,
            MAX_BIDS,
            WINDOW_BLOCKS,
            GRID_ANCHOR,
            GRID_BATCH,
            GRID_PERIOD,
            MAX_PAUSE_BLOCKS
        );
    }

    /// @dev R units locked in a pending rollover cannot move.
    function _transfer(address from, address to, uint256 id, uint256 amount) internal {
        if (to == address(0)) revert InvalidParams();
        uint256 bal = s.balanceOf[from][id];
        if (id & 1 == 1 && bal < s.lockedR[from][bytes32(id & ~uint256(1))] + amount) revert Locked();
        s.balanceOf[from][id] = bal - amount;
        s.balanceOf[to][id] += amount;
        emit IERC6909.Transfer(msg.sender, from, to, id, amount);
    }
}
