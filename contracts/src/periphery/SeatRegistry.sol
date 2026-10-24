// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKeyLib, Kind, Status} from "../libraries/PoolKey.sol";
import {GridConfig} from "../libraries/Grid.sol";
import {SELL, BUY} from "../libraries/OrderSet.sol";
import {Settlement} from "../libraries/Settlement.sol";
import {Clearing} from "../libraries/Clearing.sol";

/// @title SeatRegistry
/// @notice Harberger-tax market-maker seats (blueprint §9), one per market (asset, quote, kind), and the protocol
/// treasury that splits fees with them.
///
/// - Price: the holder self-assesses a price; anyone can buy the seat at that price at any time.
/// - Tax: `taxBps` per year of the price, accrued per second from the holder's deposit to the protocol. An empty
///   deposit forecloses the seat.
/// - Cooldown: for 7 days after a purchase the holder cannot lower the price.
/// - Bond: 10% of the market's per-batch obligation, posted on purchase.
/// - Obligation: every batch the holder must post at least `obligation` (quote notional at K) of competitive
///   orders in the market, through `postOrder`, priced near the market (within the pool's band of its last
///   clearing price). Anyone can `slash` a missed batch: 20% of the bond goes to the protocol and the seat is
///   vacated.
/// - Right: `seatShareBps` of the market's spread share (blueprint: 30-40%).
///
/// This contract is the core's `treasury`. Every amount the core credits to it is attributable: spread share per
/// market (`core.marketFees`) and flash-loan fees per token (`core.flashFees`). Nothing is inferred from balances.
///
/// The obligation size per quote token is a deployment parameter because blueprint §13 Q2 is still open.
contract SeatRegistry is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint64 public constant COOLDOWN = 7 days;
    uint256 public constant BOND_BPS = 1000; // bond = 10% of the per-batch obligation
    uint256 public constant SLASH_BPS = 2000; // a missed batch costs 20% of the bond

    struct Seat {
        address holder;
        uint128 price;
        uint128 deposit;
        uint128 bond;
        uint64 lastTax;
        uint64 priceLockedUntil;
        uint64 lastQuotedBatch;
    }

    IConfluere public core;
    address internal immutable _deployer;
    address public immutable protocol;
    uint16 public immutable seatShareBps;
    uint16 public immutable taxBps;

    mapping(address => uint256) public obligation; // per quote token, 0 = no seats for that quote
    mapping(bytes32 => Seat) public seats;
    mapping(bytes32 => uint256) public feesSplit; // core.marketFees already distributed
    mapping(address => uint256) public flashSplit; // core.flashFees already distributed
    mapping(address => mapping(address => uint256)) public claimable;

    error InvalidParams();
    error NotHolder();
    error NoSeat();
    error Cooldown();
    error NotMissed();
    error AlreadyBound();

    event SeatBought(bytes32 indexed market, address indexed holder, address previous, uint256 price, uint256 deposit);
    event PriceSet(bytes32 indexed market, uint256 price);
    event TaxPaid(bytes32 indexed market, uint256 amount);
    event Vacated(bytes32 indexed market, address indexed holder, uint8 reason); // 0 foreclosed, 1 slashed, 2 released
    event DepositToppedUp(bytes32 indexed market, uint256 amount);
    event Quoted(bytes32 indexed market, bytes32 indexed poolId, uint64 orderId, uint64 batch);
    event FeesSplit(bytes32 indexed market, uint256 toSeat, uint256 toProtocol);

    /// @param binder_ the account allowed to call `bind` once (deployments go through a CREATE2 factory, so
    /// msg.sender here is the factory, not the deployer).
    constructor(
        address binder_,
        address protocol_,
        uint16 seatShareBps_,
        uint16 taxBps_,
        address[] memory quotes,
        uint256[] memory obligations
    ) {
        if (
            binder_ == address(0) || protocol_ == address(0) || seatShareBps_ > BPS || taxBps_ == 0 || taxBps_ > BPS
                || quotes.length != obligations.length
        ) revert InvalidParams();
        _deployer = binder_;
        protocol = protocol_;
        seatShareBps = seatShareBps_;
        taxBps = taxBps_;
        for (uint256 i; i < quotes.length; ++i) {
            obligation[quotes[i]] = obligations[i];
        }
    }

    /// @notice The core stores this registry as its treasury, so the two cannot both be immutable. Bound once.
    function bind(IConfluere core_) external {
        if (msg.sender != _deployer || address(core) != address(0)) revert AlreadyBound();
        core = core_;
    }

    // ================================================================ seats

    /// @notice Buy the seat of a market at its current price (free while vacant). Pays the price to the holder,
    /// returns the holder's deposit and bond, and posts the buyer's deposit and bond.
    /// @param maxPay the most the buyer accepts to pay the current holder (a holder can raise the price at any time,
    /// so without it a buyer could be front-run into paying more than they saw).
    function buy(address asset, address quote, Kind kind, uint128 newPrice, uint128 deposit, uint256 maxPay)
        external
        nonReentrant
    {
        uint256 ob = obligation[quote];
        if (ob == 0 || newPrice == 0 || deposit == 0) revert InvalidParams();
        bytes32 m = PoolKeyLib.marketId(asset, quote, kind);
        _split(m, quote);
        Seat storage st = seats[m];
        _accrue(m, st, quote);
        address previous = st.holder;
        uint256 pay = previous == address(0) ? 0 : st.price;
        if (previous == msg.sender || pay > maxPay) revert InvalidParams();
        if (previous != address(0)) claimable[quote][previous] += pay + st.deposit + st.bond;

        uint128 bond = uint128(ob * BOND_BPS / BPS);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), pay + deposit + bond);
        st.holder = msg.sender;
        st.price = newPrice;
        st.deposit = deposit;
        st.bond = bond;
        st.lastTax = uint64(block.timestamp);
        st.priceLockedUntil = uint64(block.timestamp) + COOLDOWN;
        st.lastQuotedBatch = _batch(); // the obligation starts with the next batch
        emit SeatBought(m, msg.sender, previous, newPrice, deposit);
    }

    function setPrice(address asset, address quote, Kind kind, uint128 newPrice) external nonReentrant {
        bytes32 m = PoolKeyLib.marketId(asset, quote, kind);
        Seat storage st = _held(m);
        _split(m, quote); // pay the holder's share before a possible foreclosure
        _accrue(m, st, quote);
        if (st.holder == address(0)) return; // foreclosed by the accrual
        if (newPrice == 0) revert InvalidParams();
        if (newPrice < st.price && block.timestamp < st.priceLockedUntil) revert Cooldown();
        st.price = newPrice;
        emit PriceSet(m, newPrice);
    }

    function topUp(address asset, address quote, Kind kind, uint128 amount) external nonReentrant {
        bytes32 m = PoolKeyLib.marketId(asset, quote, kind);
        Seat storage st = _held(m);
        _split(m, quote);
        _accrue(m, st, quote);
        if (st.holder == address(0)) return;
        IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        st.deposit += amount;
        emit DepositToppedUp(m, amount);
    }

    /// @notice Leave the seat voluntarily: deposit and bond are returned, the seat becomes vacant.
    function release(address asset, address quote, Kind kind) external nonReentrant {
        bytes32 m = PoolKeyLib.marketId(asset, quote, kind);
        _split(m, quote);
        Seat storage st = _held(m);
        _accrue(m, st, quote);
        if (st.holder == address(0)) return;
        claimable[quote][st.holder] += st.deposit + st.bond;
        emit Vacated(m, st.holder, 2);
        delete seats[m];
    }

    /// @notice Post the holder's competitive order for this batch. Funds come from the holder; the order is the
    /// holder's own in the core (refunds and fills go to the holder) but locked: it cannot be cancelled while it
    /// can still trade, so posting and immediately cancelling does not meet the obligation. Counts if its quote
    /// notional at K is at least the obligation and its price can back non-competitive orders: once the pool has a
    /// clearing price, a buy must bid at least, and a sell ask at most, that price moved by the pool's band. Before
    /// the first trade a buy's size is valued at min(limit, K), so a token bid cannot stand in for real depth.
    function postOrder(bytes32 poolId, IConfluere.OrderParams calldata p) external nonReentrant returns (uint64 id) {
        IConfluere.PoolView memory v = core.pool(poolId);
        bytes32 m = PoolKeyLib.marketId(v.key.asset, v.key.quote, v.key.kind);
        Seat storage st = _held(m);
        if (p.side != SELL && p.side != BUY) revert InvalidParams();
        uint256 scale = 10 ** uint256(v.assetDecimals);
        uint256 last = v.lastClearingPrice;
        uint256 valuedAt = v.key.strike;
        if (last != 0) {
            if (p.side == BUY
                    ? p.limit < last * (BPS - v.key.bandBps) / BPS
                    : p.limit > last * (BPS + v.key.bandBps) / BPS) {
                revert InvalidParams();
            }
        } else if (p.side == BUY && p.limit < valuedAt) {
            valuedAt = p.limit;
        }
        if (Clearing.quoteDown(p.units, valuedAt, scale) < obligation[v.key.quote]) revert InvalidParams();

        (address token, uint256 amount) = p.side == SELL
            ? (v.key.asset, uint256(p.units))
            : (v.key.quote, Settlement.buyEscrow(p.units, p.limit, scale, p.ttl));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(core), amount);
        IConfluere.OrderParams memory o = p;
        o.owner = msg.sender;
        id = core.placeLockedOrder(poolId, o); // cannot be cancelled until it has had its batch
        uint64 b = _batch();
        st.lastQuotedBatch = b;
        emit Quoted(m, poolId, id, b);
    }

    /// @notice Anyone can slash a seat whose holder skipped a whole batch while `poolId` (a pool of the same market)
    /// was trading. 20% of the bond goes to the protocol, the rest of the bond and the deposit to the holder.
    function slash(bytes32 poolId) external nonReentrant {
        IConfluere.PoolView memory v = core.pool(poolId);
        address quote_ = v.key.quote;
        bytes32 m = PoolKeyLib.marketId(v.key.asset, quote_, v.key.kind);
        Seat storage st = seats[m];
        if (st.holder == address(0)) revert NoSeat();
        // The missed batch is the evidence pool's first full batch after the holder's last quote. Long-tail pools
        // batch every 12 or 48 base intervals, so their batch length is used, not the base interval.
        GridConfig memory g = core.grid();
        uint256 quotedEnd = g.anchor + uint256(st.lastQuotedBatch + 1) * g.batchInterval;
        uint256 iv = v.batchInterval;
        // round up to the evidence pool's batch grid: dividing first is the point
        // slither-disable-next-line divide-before-multiply
        uint256 missedStart = g.anchor + ((quotedEnd - g.anchor + iv - 1) / iv) * iv;
        uint256 missedEnd = missedStart + iv;
        // the missed batch must be over, and the evidence pool must have been trading through it
        if (block.timestamp < missedEnd || v.key.expiry < missedEnd || v.status == Status.None) revert NotMissed();
        _split(m, quote_);
        _accrue(m, st, quote_);
        if (st.holder == address(0)) return;
        uint256 penalty = uint256(st.bond) * SLASH_BPS / BPS;
        claimable[quote_][protocol] += penalty;
        claimable[quote_][st.holder] += st.bond - penalty + st.deposit;
        emit Vacated(m, st.holder, 1);
        delete seats[m];
    }

    // ================================================================ fees

    /// @notice Split the market's new spread share between its seat holder and the protocol. Permissionless.
    function split(address asset, address quote_, Kind kind) external nonReentrant {
        _split(PoolKeyLib.marketId(asset, quote_, kind), quote_);
    }

    /// @notice Credit new flash-loan fees of `token` to the protocol. Permissionless.
    function splitFlash(address token) external nonReentrant {
        uint256 total = core.flashFees(token);
        uint256 fresh = total - flashSplit[token];
        flashSplit[token] = total;
        claimable[token][protocol] += fresh;
    }

    /// @notice Pull the caller's balance of `token` (fee share, buy-out proceeds, returned deposit and bond).
    function withdraw(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable[token][msg.sender];
        if (amount == 0) return 0;
        claimable[token][msg.sender] = 0;
        if (IERC20(token).balanceOf(address(this)) < amount) core.withdraw(token, address(this));
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /// @notice Seat state with tax accrued up to now (deposit shown after tax).
    function seatOf(address asset, address quote_, Kind kind) external view returns (Seat memory st, uint256 taxOwed) {
        st = seats[PoolKeyLib.marketId(asset, quote_, kind)];
        if (st.holder != address(0)) {
            taxOwed = Math.min(_tax(st), st.deposit);
            st.deposit -= uint128(taxOwed);
        }
    }

    // ================================================================ internals

    function _held(bytes32 m) internal view returns (Seat storage st) {
        st = seats[m];
        if (st.holder != msg.sender) revert NotHolder();
    }

    function _batch() internal view returns (uint64) {
        GridConfig memory g = core.grid();
        return uint64((block.timestamp - g.anchor) / g.batchInterval);
    }

    function _tax(Seat memory st) internal view returns (uint256) {
        return uint256(st.price) * taxBps * (block.timestamp - st.lastTax) / (YEAR * BPS);
    }

    /// @dev Pays tax from the deposit; forecloses when the deposit cannot cover it (bond returned to the holder).
    function _accrue(bytes32 m, Seat storage st, address quote_) internal {
        if (st.holder == address(0)) return;
        uint256 owed = _tax(st);
        st.lastTax = uint64(block.timestamp);
        if (owed >= st.deposit) {
            claimable[quote_][protocol] += st.deposit;
            claimable[quote_][st.holder] += st.bond;
            emit TaxPaid(m, st.deposit);
            emit Vacated(m, st.holder, 0);
            delete seats[m];
            return;
        }
        st.deposit -= uint128(owed);
        claimable[quote_][protocol] += owed;
        emit TaxPaid(m, owed);
    }

    /// @dev New spread share since the last split: `seatShareBps` to the holder at this moment, the rest to the
    /// protocol. Run before any change of holder so each holder is paid for its own tenure.
    function _split(bytes32 m, address quote_) internal {
        uint256 total = core.marketFees(m);
        uint256 fresh = total - feesSplit[m];
        if (fresh == 0) return;
        feesSplit[m] = total;
        address holder = seats[m].holder;
        uint256 toSeat = holder == address(0) ? 0 : fresh * seatShareBps / BPS;
        if (toSeat != 0) claimable[quote_][holder] += toSeat;
        claimable[quote_][protocol] += fresh - toSeat;
        emit FeesSplit(m, toSeat, fresh - toSeat);
    }
}
