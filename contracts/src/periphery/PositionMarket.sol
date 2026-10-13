// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKeyLib, Status} from "../libraries/PoolKey.sol";

interface IConfluere6909Market {
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
    function transferFrom(address sender, address receiver, uint256 id, uint256 amount) external returns (bool);
}

/// @notice Secondary market for the core's ERC-6909 positions (C = poolId, R = poolId | 1), priced in the pool's
/// quote token. A plain on-chain limit-order book: asks escrow units, bids escrow quote, takers fill or hit
/// directly. No owner, no fee, no oracle, no DEX call; the core is never modified or called with privileges.
/// @dev Prices use the same unit as the strike K: quote base units per 1 whole asset (10 ** assetDecimals units).
/// Rounding always goes against the taker: a buyer filling an ask pays rounded up, a seller hitting a bid
/// receives rounded down. Trading stops for C once the pool is Closed (claim instead) and for R once the
/// repayment window has ended (the right is worthless). Cancels always work so escrow can never get stuck.
contract PositionMarket is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolKeyLib for bytes32;

    struct Offer {
        address maker;
        uint96 units; // remaining asset units of the position
        bytes32 poolId;
        uint128 price; // quote base units per whole asset
        uint64 expiresAt; // timestamp; 0 = good until the position stops trading
        bool isR; // R-Token (buy-back right) or C-Token (lender share)
        bool isBid; // false: ask (units escrowed), true: bid (quote escrowed)
        uint256 escrow; // bids only: quote still held for this bid
    }

    IConfluere public immutable core;

    uint256 public nextId = 1;
    mapping(uint256 offerId => Offer) internal _offers;
    mapping(uint256 tokenId => uint256[]) internal _asks;
    mapping(uint256 tokenId => uint256[]) internal _bids;
    mapping(uint256 offerId => uint256) internal _slot; // index in its book + 1

    event Listed(
        uint256 indexed offerId,
        address indexed maker,
        bytes32 indexed poolId,
        bool isR,
        uint96 units,
        uint128 price,
        uint64 expiresAt
    );
    event BidPlaced(
        uint256 indexed offerId,
        address indexed maker,
        bytes32 indexed poolId,
        bool isR,
        uint96 units,
        uint128 price,
        uint64 expiresAt,
        uint256 escrow
    );
    /// @notice A buyer took `units` from an ask and paid `paid` quote to the maker.
    event Filled(uint256 indexed offerId, address indexed taker, uint96 units, uint256 paid);
    /// @notice A holder sold `units` into a bid and received `received` quote from its escrow.
    event Hit(uint256 indexed offerId, address indexed taker, uint96 units, uint256 received);
    /// @notice An offer left the book: cancelled by its maker, or a bid fully hit (refund = rounding dust).
    event OfferClosed(uint256 indexed offerId, uint96 unitsReturned, uint256 quoteReturned);

    error InvalidPool();
    error InvalidParams();
    error NotTradable();
    error NotMaker();
    error NoOffer();
    error Expired();
    error Slippage();
    error BadToken();

    constructor(IConfluere core_) {
        core = core_;
    }

    // ------------------------------------------------------------ makers

    /// @notice Escrow `units` of C or R (needs this contract as operator, or an allowance, on the core) and ask
    /// `pricePerUnit` quote per whole asset.
    function list(bytes32 poolId, bool isR, uint96 units, uint256 pricePerUnit, uint64 expiresAt)
        external
        nonReentrant
        returns (uint256 id)
    {
        _checkNew(poolId, isR, units, pricePerUnit, expiresAt);
        uint256 tokenId = _tokenId(poolId, isR);
        id = nextId++;
        _offers[id] = Offer(msg.sender, units, poolId, uint128(pricePerUnit), expiresAt, isR, false, 0);
        _push(_asks[tokenId], id);
        emit Listed(id, msg.sender, poolId, isR, units, uint128(pricePerUnit), expiresAt);
        IConfluere6909Market(address(core)).transferFrom(msg.sender, address(this), tokenId, units);
    }

    /// @notice Escrow quote for `units` at `pricePerUnit` (rounded up) so a holder can sell instantly.
    function bid(bytes32 poolId, bool isR, uint96 units, uint256 pricePerUnit, uint64 expiresAt)
        external
        nonReentrant
        returns (uint256 id)
    {
        IConfluere.PoolView memory v = _checkNew(poolId, isR, units, pricePerUnit, expiresAt);
        uint256 escrow = Math.mulDiv(units, pricePerUnit, 10 ** uint256(v.assetDecimals), Math.Rounding.Ceil);
        id = nextId++;
        _offers[id] = Offer(msg.sender, units, poolId, uint128(pricePerUnit), expiresAt, isR, true, escrow);
        _push(_bids[_tokenId(poolId, isR)], id);
        emit BidPlaced(id, msg.sender, poolId, isR, units, uint128(pricePerUnit), expiresAt, escrow);
        IERC20 quote = IERC20(v.key.quote);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), escrow);
        if (quote.balanceOf(address(this)) - before != escrow) revert BadToken();
    }

    /// @notice Return an ask's unfilled units to its maker. Works in any pool state.
    function cancel(uint256 listingId) external nonReentrant {
        Offer memory o = _offers[listingId];
        if (o.maker == address(0) || o.isBid) revert NoOffer();
        if (o.maker != msg.sender) revert NotMaker();
        uint256 tokenId = _tokenId(o.poolId, o.isR);
        _remove(_asks[tokenId], listingId);
        emit OfferClosed(listingId, o.units, 0);
        IConfluere6909Market(address(core)).transfer(o.maker, tokenId, o.units);
    }

    /// @notice Return a bid's remaining quote escrow to its maker. Works in any pool state.
    function cancelBid(uint256 bidId) external nonReentrant {
        Offer memory o = _offers[bidId];
        if (o.maker == address(0) || !o.isBid) revert NoOffer();
        if (o.maker != msg.sender) revert NotMaker();
        _remove(_bids[_tokenId(o.poolId, o.isR)], bidId);
        emit OfferClosed(bidId, 0, o.escrow);
        if (o.escrow != 0) IERC20(core.pool(o.poolId).key.quote).safeTransfer(o.maker, o.escrow);
    }

    // ------------------------------------------------------------ takers

    /// @notice Buy `units` from an ask, paying at most `maxPay` quote (rounded up) straight to the maker.
    function fill(uint256 listingId, uint96 units, uint256 maxPay) external nonReentrant returns (uint256 pay) {
        Offer storage o = _offers[listingId];
        if (o.maker == address(0) || o.isBid) revert NoOffer();
        if (units == 0 || units > o.units) revert InvalidParams();
        if (o.expiresAt != 0 && block.timestamp >= o.expiresAt) revert Expired();
        IConfluere.PoolView memory v = _tradable(o.poolId, o.isR);
        pay = Math.mulDiv(units, o.price, 10 ** uint256(v.assetDecimals), Math.Rounding.Ceil);
        if (pay > maxPay) revert Slippage();
        address maker = o.maker;
        uint256 tokenId = _tokenId(o.poolId, o.isR);
        uint96 left = o.units - units;
        if (left == 0) _remove(_asks[tokenId], listingId);
        else o.units = left;
        emit Filled(listingId, msg.sender, units, pay);
        IERC20(v.key.quote).safeTransferFrom(msg.sender, maker, pay);
        IConfluere6909Market(address(core)).transfer(msg.sender, tokenId, units);
    }

    /// @notice Sell `units` you hold into a bid (needs this contract as operator, or an allowance, on the core)
    /// and receive at least `minReceive` quote (rounded down) from the bid's escrow.
    function hit(uint256 bidId, uint96 units, uint256 minReceive) external nonReentrant returns (uint256 received) {
        Offer storage o = _offers[bidId];
        if (o.maker == address(0) || !o.isBid) revert NoOffer();
        if (units == 0 || units > o.units) revert InvalidParams();
        if (o.expiresAt != 0 && block.timestamp >= o.expiresAt) revert Expired();
        IConfluere.PoolView memory v = _tradable(o.poolId, o.isR);
        received = Math.mulDiv(units, o.price, 10 ** uint256(v.assetDecimals));
        if (received < minReceive) revert Slippage();
        address maker = o.maker;
        uint256 tokenId = _tokenId(o.poolId, o.isR);
        // escrow >= ceil(remaining * price / scale) holds after every hit, so this never underflows
        uint256 escrowLeft = o.escrow - received;
        uint96 left = o.units - units;
        uint256 dust;
        if (left == 0) {
            dust = escrowLeft;
            _remove(_bids[tokenId], bidId);
        } else {
            o.units = left;
            o.escrow = escrowLeft;
        }
        emit Hit(bidId, msg.sender, units, received);
        if (left == 0) emit OfferClosed(bidId, 0, dust);
        IConfluere6909Market(address(core)).transferFrom(msg.sender, maker, tokenId, units);
        IERC20 quote = IERC20(v.key.quote);
        if (received != 0) quote.safeTransfer(msg.sender, received);
        if (dust != 0) quote.safeTransfer(maker, dust);
    }

    // ------------------------------------------------------------ views

    function offer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    /// @notice True when C (or R) of this pool can still change hands here.
    function tradable(bytes32 poolId, bool isR) public view returns (bool) {
        IConfluere.PoolView memory v = core.pool(poolId);
        return v.status != Status.None && _live(v, isR);
    }

    /// @notice Quote a buyer pays to take `units` from an ask (rounded up).
    function quoteFill(uint256 listingId, uint96 units) external view returns (uint256) {
        Offer storage o = _offers[listingId];
        return Math.mulDiv(units, o.price, 10 ** uint256(core.pool(o.poolId).assetDecimals), Math.Rounding.Ceil);
    }

    /// @notice Quote a seller receives for hitting a bid with `units` (rounded down).
    function quoteHit(uint256 bidId, uint96 units) external view returns (uint256) {
        Offer storage o = _offers[bidId];
        return Math.mulDiv(units, o.price, 10 ** uint256(core.pool(o.poolId).assetDecimals));
    }

    function askCount(uint256 tokenId) external view returns (uint256) {
        return _asks[tokenId].length;
    }

    function bidCount(uint256 tokenId) external view returns (uint256) {
        return _bids[tokenId].length;
    }

    /// @notice Page through the open asks (`bids_ == false`) or bids of one position id, in book order (unsorted;
    /// includes expired offers, which only their maker can remove).
    function page(uint256 tokenId, bool bids_, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Offer[] memory offers)
    {
        uint256[] storage book = bids_ ? _bids[tokenId] : _asks[tokenId];
        uint256 n = book.length;
        uint256 end = offset >= n ? offset : offset + Math.min(n - offset, limit);
        ids = new uint256[](end - offset);
        offers = new Offer[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            ids[i - offset] = book[i];
            offers[i - offset] = _offers[book[i]];
        }
    }

    /// @notice The `n` best live (unexpired) offers of one side, best first: lowest ask or highest bid.
    /// @dev Scans the whole book; meant for eth_call. Use `page` when a book is too large for one call.
    function best(uint256 tokenId, bool bids_, uint256 n)
        external
        view
        returns (uint256[] memory ids, Offer[] memory offers)
    {
        uint256[] storage book = bids_ ? _bids[tokenId] : _asks[tokenId];
        uint256 len = book.length;
        uint256[] memory live = new uint256[](len);
        uint256 m;
        for (uint256 i; i < len; ++i) {
            Offer storage o = _offers[book[i]];
            if (o.expiresAt == 0 || block.timestamp < o.expiresAt) live[m++] = book[i];
        }
        uint256 k = Math.min(n, m);
        ids = new uint256[](k);
        offers = new Offer[](k);
        for (uint256 j; j < k; ++j) {
            uint256 bi = j;
            for (uint256 i = j + 1; i < m; ++i) {
                uint128 pi = _offers[live[i]].price;
                uint128 pb = _offers[live[bi]].price;
                if (bids_ ? pi > pb : pi < pb) bi = i;
            }
            (live[j], live[bi]) = (live[bi], live[j]);
            ids[j] = live[j];
            offers[j] = _offers[live[j]];
        }
    }

    // ------------------------------------------------------------ internals

    function _checkNew(bytes32 poolId, bool isR, uint96 units, uint256 price, uint64 expiresAt)
        internal
        view
        returns (IConfluere.PoolView memory v)
    {
        if (units == 0 || price == 0 || price > type(uint128).max) revert InvalidParams();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidParams();
        v = _tradable(poolId, isR);
    }

    function _tradable(bytes32 poolId, bool isR) internal view returns (IConfluere.PoolView memory v) {
        if (uint256(poolId) & 1 == 1) revert InvalidPool();
        v = core.pool(poolId);
        if (v.status == Status.None) revert InvalidPool();
        if (!_live(v, isR)) revert NotTradable();
    }

    /// @dev C trades until the pool is Closed. R trades while it can still be exercised: before expiry, or
    /// until the shared repayment window of its expiry ends (mirrors the core's windowOpen).
    function _live(IConfluere.PoolView memory v, bool isR) internal view returns (bool) {
        if (!isR) return v.status != Status.Closed;
        if (v.status == Status.Window) return block.number < v.windowEnd;
        if (v.status != Status.Open) return false;
        if (block.timestamp < v.key.expiry) return true;
        uint64 e = core.expiryWindowEnd(v.key.expiry);
        return e == 0 || block.number < e;
    }

    function _tokenId(bytes32 poolId, bool isR) internal pure returns (uint256) {
        return isR ? poolId.rId() : poolId.cId();
    }

    function _push(uint256[] storage book, uint256 id) internal {
        book.push(id);
        _slot[id] = book.length;
    }

    /// @dev Swap-and-pop removal from the book, then forget the offer.
    function _remove(uint256[] storage book, uint256 id) internal {
        uint256 i = _slot[id] - 1;
        uint256 last = book[book.length - 1];
        book[i] = last;
        _slot[last] = i + 1;
        book.pop();
        delete _slot[id];
        delete _offers[id];
    }
}
