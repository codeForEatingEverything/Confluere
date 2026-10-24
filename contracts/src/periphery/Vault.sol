// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IERC7540,
    IERC7540Operator,
    IERC7540Deposit,
    IERC7540Redeem
} from "@openzeppelin/community-contracts/interfaces/IERC7540.sol";
import {IERC7575} from "@openzeppelin/community-contracts/interfaces/IERC7575.sol";

import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../libraries/PoolKey.sol";
import {GridConfig, Grid} from "../libraries/Grid.sol";
import {NC_BUY} from "../libraries/OrderSet.sol";

/// @title Vault
/// @notice Retail lender vault (ERC-7540). It only places non-competitive buy orders, at the clearing price, into
/// graduated markets chosen by a rule fixed at deployment. It never prices, never buys R, has no manager.
///
/// Epochs follow expiries. During an epoch the vault invests up to `perBatchCapBps` of its idle quote per batch into
/// the target expiry. After that expiry closes, `roll` harvests, fixes the epoch's share price, pays queued
/// redemptions and mints queued deposits at that price. Both deposits and redemptions are asynchronous, so nobody can
/// enter after the outcome of an epoch is visible and capture its interest.
///
/// Defaulted collateral is not priced: it is distributed pro rata per share at roll and claimed with `claimAssets`.
/// v1 redemptions therefore pay quote plus a share of defaulted assets, as the blueprint states.
contract Vault is ERC20, IERC7540, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolKeyLib for PoolKey;
    using PoolKeyLib for bytes32;

    /// MainTier: last expiry's tier (strike, band, cadence) with the most volume. HighTier: the highest strike within
    /// `HIGH_SCAN` grid steps above the main tier whose volume is at least 20% of the main tier's.
    enum StrikeRule {
        MainTier,
        HighTier
    }

    struct Strategy {
        address quote;
        address[] assets;
        Kind kind;
        StrikeRule strikeRule;
        uint16 perBatchCapBps;
        /// Protective ceiling for the vault's non-competitive buys, as bps of K (e.g. 9950: never lend above
        /// 99.5% of K). Fixed rule, not a price the vault sets; P* still comes from competitive orders only.
        uint16 maxPriceBps;
    }

    struct Epoch {
        uint256 assets; // quote NAV at roll (before queued flows)
        uint256 supply; // share supply at roll (before queued flows)
        bool rolled;
    }

    struct Request {
        uint64 epoch;
        uint256 pending;
        uint256 claimable; // shares (deposit side) or quote (redeem side)
        uint256 claimableBase; // the matching assets (deposit side) or shares (redeem side)
    }

    struct Position {
        bytes32 poolId;
        uint64 lastOrder;
    }

    error NotReady();
    error InvalidParams();
    error Unauthorized();
    error AsyncOnly();

    event Poked(uint64 indexed epoch, bytes32 indexed poolId, uint64 orderId, uint256 budget);
    event Rolled(uint64 indexed epoch, uint256 navAssets, uint256 supply, uint64 nextExpiry);
    event AssetsClaimed(address indexed account, address indexed asset, uint256 amount);

    uint256 internal constant ACC = 1e27;
    uint256 internal constant HIGH_SCAN = 40; // grid steps scanned above the main tier (~ +49%)
    uint256 internal constant HIGH_SHARE_BPS = 2000; // a high tier needs >= 20% of the main tier's volume
    uint256 internal constant BPS = 10_000;

    IConfluere public immutable core;
    address internal immutable _quote;
    Kind public immutable kind;
    StrikeRule public immutable strikeRule;
    uint16 public immutable perBatchCapBps;
    uint16 public immutable maxPriceBps;
    /// @dev Virtual shares (ERC-4626 decimals offset): first-depositor donation attacks must outspend victims 1e6x,
    /// and a zero-NAV epoch prices new deposits fairly instead of letting old shares dilute them.
    uint256 internal constant OFFSET = 1e6;
    address[] internal _assets;

    uint64 public epoch = 1;
    uint64 public targetExpiry;
    uint64 public lastPokeBatch;
    Position[] internal _positions;
    /// Per target pool: the pool's settle count (plus one) the vault last placed an order for. A pool settles once per
    /// its own batch (12 or 48 base intervals for long-tail pools), so this keeps one vault order per clearing.
    mapping(bytes32 => uint32) public pokedSettle;
    mapping(bytes32 => uint64[]) internal _epochOrders; // every order placed this epoch, purged at roll

    uint256 public pendingDepositAssets; // queued this epoch, not investable
    uint256 public pendingRedeemShares; // queued this epoch, held in custody
    uint256 public reservedAssets; // quote owed to claimable redemptions
    uint256 public costBasis; // quote spent on C this epoch (view only)

    mapping(uint64 => Epoch) public epochs;
    mapping(address => Request) internal _deposits;
    mapping(address => Request) internal _redeems;
    mapping(address => mapping(address => bool)) public isOperator;

    // defaulted-asset distribution
    mapping(address => uint256) public accPerShare;
    mapping(uint64 => mapping(address => uint256)) public accAtRoll;
    mapping(address => uint256) public assetReserved;
    mapping(address => mapping(address => uint256)) internal _debt;
    mapping(address => mapping(address => uint256)) public assetCredit;
    mapping(address => mapping(address => uint256)) internal _claimableSnap;

    constructor(IConfluere core_, Strategy memory s, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (
            s.assets.length == 0 || s.perBatchCapBps == 0 || s.perBatchCapBps > BPS || s.maxPriceBps == 0
                || s.maxPriceBps >= BPS
        ) revert InvalidParams();
        core = core_;
        _quote = s.quote;
        kind = s.kind;
        strikeRule = s.strikeRule;
        perBatchCapBps = s.perBatchCapBps;
        maxPriceBps = s.maxPriceBps;
        _assets = s.assets;
        targetExpiry = _nextExpiry();
        IERC20(s.quote).forceApprove(address(core_), type(uint256).max);
    }

    // ================================================================ strategy

    /// @notice Place this batch's non-competitive buy orders. Permissionless, once per core batch, and at most one
    /// order per clearing of each target pool (long-tail pools clear every 12 or 48 core batches; without this the
    /// orders of every core batch would stack into one clearing and invest far more than `perBatchCapBps`).
    /// External calls go only to the immutable core; the function is nonReentrant.
    // slither-disable-next-line reentrancy-no-eth
    function poke() external nonReentrant {
        GridConfig memory g = core.grid();
        uint64 batch = uint64((block.timestamp - g.anchor) / g.batchInterval);
        if (batch <= lastPokeBatch || block.timestamp >= targetExpiry) revert NotReady();
        lastPokeBatch = batch;
        core.withdraw(_quote, address(this));

        uint256 budget = Math.mulDiv(investable(), perBatchCapBps, BPS);
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            (bytes32 pid, uint96 limit, uint32 settleCount) = _target(_assets[i]);
            if (pid == bytes32(0) || budget / n == 0 || pokedSettle[pid] > settleCount) continue;
            pokedSettle[pid] = settleCount + 1; // a ttl-1 order takes part in the pool's next settlement only
            IConfluere.OrderParams memory p;
            p.side = NC_BUY;
            // all-in: the core takes the buyer's trade fee out of the budget, so costBasis += budget stays exact
            p.budget = uint128(budget / n);
            p.limit = limit;
            p.ttl = 1;
            p.hint = core.findHint(pid, NC_BUY, limit);
            uint64 id = core.placeOrder(pid, p);
            costBasis += budget / n;
            _track(pid, id);
            emit Poked(epoch, pid, id, budget / n);
        }
    }

    /// @notice The pool the strategy targets for `asset` this epoch, or 0 if none qualifies.
    /// The tier comes from last expiry's per-tier volume in a graduated market (main tier, or the highest tier with at
    /// least 20% of its volume), must have traded at two consecutive expiries, and the pool must use autoSell.
    function targetPool(address token) public view returns (bytes32 pid) {
        (pid,,) = _target(token);
    }

    /// @notice The price cap of this epoch's buys in `targetPool(token)` (0 if no target).
    function targetLimit(address token) external view returns (uint96 limit) {
        (, limit,) = _target(token);
    }

    /// @dev Vault guard against wash-steering: the reference is the volume-weighted clearing price of last expiry's main
    /// tier (the market's deepest tier, which a wash trade must outtrade to move). A tier qualifies only if its last
    /// clearing price at that expiry lies within the main tier's band of the reference, and the vault's limit is
    /// min(K x maxPriceBps, K - 1, reference x (1 + band)). No reference -> no investment.
    function _target(address token) internal view returns (bytes32, uint96, uint32) {
        bytes32 m = PoolKeyLib.marketId(token, _quote, kind);
        if (!core.graduated(m)) return (bytes32(0), 0, 0);
        uint64 period = core.grid().period;
        uint64 prev = targetExpiry - period;
        IConfluere.MarketStats memory st = core.marketStats(m, prev);
        if (st.mainVolume == 0) return (bytes32(0), 0, 0);
        PoolKey memory pk = PoolKey(token, _quote, prev, st.mainStrike, kind, st.mainBand, st.mainCadence);
        uint256 ref;
        {
            IConfluere.PoolView memory mv = core.pool(pk.toId());
            if (mv.filledUnits == 0) return (bytes32(0), 0, 0);
            ref = Math.mulDiv(st.mainVolume, 10 ** mv.assetDecimals, mv.filledUnits);
        }
        if (ref == 0) return (bytes32(0), 0, 0);
        uint256 cap = Math.mulDiv(ref, BPS + st.mainBand, BPS);
        uint256 floor_ = Math.mulDiv(ref, BPS - st.mainBand, BPS);
        uint128 strike = st.mainStrike;
        if (strikeRule == StrikeRule.HighTier) {
            uint128 hi = _highTier(m, pk, st.mainIndex, uint256(st.mainVolume) * HIGH_SHARE_BPS, floor_, cap);
            if (hi != 0) strike = hi;
        }
        // two traded expiries in this tier
        if (core.tierVolume(m, prev - period, PoolKeyLib.tierKey(strike, st.mainBand, st.mainCadence)) == 0) {
            return (bytes32(0), 0, 0);
        }
        pk.expiry = targetExpiry;
        pk.strike = strike;
        bytes32 pid = pk.toId();
        IConfluere.PoolView memory v = core.pool(pid);
        if (v.status != Status.Open || !v.options.autoSell) return (bytes32(0), 0, 0);
        uint256 limit = Math.min(Math.min(uint256(strike) * maxPriceBps / BPS, uint256(strike) - 1), cap);
        if (limit == 0 || limit > type(uint96).max) return (bytes32(0), 0, 0);
        return (pid, uint96(limit), v.settleCount);
    }

    /// @dev Highest strike within HIGH_SCAN grid steps above the main tier (same band and cadence) with >= 20% of the
    /// main tier's volume whose last clearing price at `pk.expiry` is inside [floor_, cap]; 0 if none.
    /// `pk` is the main tier's key at the previous expiry (its strike is overwritten).
    function _highTier(bytes32 m, PoolKey memory pk, int256 mainIndex, uint256 minVol, uint256 floor_, uint256 cap)
        internal
        view
        returns (uint128)
    {
        for (uint256 j = HIGH_SCAN; j != 0; --j) {
            if (mainIndex + int256(j) > Grid.MAX_STRIKE_INDEX) continue;
            uint256 k = Grid.strikeAt(mainIndex + int256(j), IERC20Metadata(_quote).decimals());
            if (k == 0 || k > type(uint96).max) continue;
            pk.strike = uint128(k);
            if (_tierVolume(m, pk) * BPS < minVol) continue;
            uint256 lcp = core.pool(pk.toId()).lastClearingPrice;
            if (lcp >= floor_ && lcp <= cap) return uint128(k);
        }
        return 0;
    }

    function _tierVolume(bytes32 m, PoolKey memory pk) internal view returns (uint256) {
        return core.tierVolume(m, pk.expiry, PoolKeyLib.tierKey(pk.strike, pk.bandBps, pk.cadence));
    }

    /// @notice Quote the vault may still invest this epoch: idle minus queued deposits, reserved redemptions and an
    /// estimate of what queued redemptions will take at the last share price.
    function investable() public view returns (uint256) {
        uint256 bal = IERC20(_quote).balanceOf(address(this));
        uint256 owed = reservedAssets + pendingDepositAssets + _redeemEstimate();
        return bal > owed ? bal - owed : 0;
    }

    /// @notice Harvest the finished epoch and settle every queued request at one price. Permissionless.
    /// Allowed once the target expiry has passed and every position is closed, or while nothing is invested if
    /// requests are queued (so the first deposits do not wait a full epoch) or the target expiry has passed.
    /// External calls go only to the immutable core and ERC-20 reads; the function is nonReentrant.
    // slither-disable-next-line reentrancy-no-eth
    function roll() external nonReentrant {
        uint256 n = _positions.length;
        if (n != 0 && block.timestamp < targetExpiry) revert NotReady();
        // With nothing invested, only roll when there is something to settle or the target expiry has passed
        // (otherwise anyone could spin epochs and keepers would pay gas for no-ops).
        if (n == 0 && pendingDepositAssets == 0 && pendingRedeemShares == 0 && block.timestamp < targetExpiry) {
            revert NotReady();
        }
        for (uint256 i; i < n; ++i) {
            Position memory pos = _positions[i];
            if (core.pool(pos.poolId).status != Status.Closed) revert NotReady();
            // every order of the epoch: an unfilled one can sit behind another account's live order, out of reach of
            // the clearing's own cleanup, and its escrow belongs in this epoch's NAV (purge skips removed ids)
            core.purge(pos.poolId, _epochOrders[pos.poolId]);
            // one position per strategy asset; clearing the list refunds its storage
            // slither-disable-next-line costly-loop
            delete _epochOrders[pos.poolId];
            core.claim(pos.poolId);
        }
        delete _positions;
        core.withdraw(_quote, address(this));
        uint64 e = epoch;
        uint256 supply = totalSupply();
        _distributeAssets(e, supply);

        uint256 bal = IERC20(_quote).balanceOf(address(this));
        uint256 nav = bal - reservedAssets - pendingDepositAssets;
        epochs[e] = Epoch(nav, supply, true);

        uint256 rs = pendingRedeemShares;
        if (rs != 0) {
            reservedAssets += _toAssets(rs, nav, supply);
            _burn(address(this), rs);
        }
        uint256 da = pendingDepositAssets;
        if (da != 0) {
            _mint(address(this), _toShares(da, nav, supply));
        }
        pendingRedeemShares = 0;
        pendingDepositAssets = 0;
        costBasis = 0;
        epoch = e + 1;
        targetExpiry = _nextExpiry();
        emit Rolled(e, nav, supply, targetExpiry);
    }

    // ================================================================ ERC-7540 requests

    function requestDeposit(uint256 assets, address controller, address owner) external nonReentrant returns (uint256) {
        if (assets == 0) revert InvalidParams();
        if (owner != msg.sender && !isOperator[owner][msg.sender]) revert Unauthorized();
        Request storage r = _syncDeposit(controller);
        r.epoch = epoch;
        r.pending += assets;
        pendingDepositAssets += assets;
        // owner is msg.sender or has made msg.sender its ERC-7540 operator (checked above)
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(_quote).safeTransferFrom(owner, address(this), assets);
        emit DepositRequest(controller, owner, 0, msg.sender, assets);
        return 0;
    }

    function requestRedeem(uint256 shares, address controller, address owner) external nonReentrant returns (uint256) {
        if (shares == 0) revert InvalidParams();
        if (owner != msg.sender && !isOperator[owner][msg.sender]) _spendAllowance(owner, msg.sender, shares);
        Request storage r = _syncRedeem(controller);
        r.epoch = epoch;
        r.pending += shares;
        pendingRedeemShares += shares;
        _transfer(owner, address(this), shares);
        emit RedeemRequest(controller, owner, 0, msg.sender, shares);
        return 0;
    }

    function pendingDepositRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _deposits[controller];
        return epochs[r.epoch].rolled ? 0 : r.pending;
    }

    function claimableDepositRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _deposits[controller];
        Epoch memory ep = epochs[r.epoch];
        return r.claimableBase + (ep.rolled ? r.pending : 0);
    }

    function pendingRedeemRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _redeems[controller];
        return epochs[r.epoch].rolled ? 0 : r.pending;
    }

    function claimableRedeemRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _redeems[controller];
        return r.claimableBase + (epochs[r.epoch].rolled ? r.pending : 0);
    }

    // ================================================================ ERC-7540 claims (ERC-4626 entry points)

    function deposit(uint256 assets, address receiver, address controller)
        public
        nonReentrant
        returns (uint256 shares)
    {
        _checkController(controller);
        Request storage r = _syncDeposit(controller);
        if (assets == 0 || assets > r.claimableBase) revert InvalidParams();
        shares = Math.mulDiv(r.claimable, assets, r.claimableBase);
        _consume(r, shares, assets);
        _transfer(address(this), receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver, address controller) public nonReentrant returns (uint256 assets) {
        _checkController(controller);
        Request storage r = _syncDeposit(controller);
        if (shares == 0 || shares > r.claimable) revert InvalidParams();
        assets = Math.mulDiv(r.claimableBase, shares, r.claimable, Math.Rounding.Ceil);
        _consume(r, shares, assets);
        _transfer(address(this), receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address controller) public nonReentrant returns (uint256 assets) {
        _checkController(controller);
        Request storage r = _syncRedeem(controller);
        if (shares == 0 || shares > r.claimableBase) revert InvalidParams();
        assets = Math.mulDiv(r.claimable, shares, r.claimableBase);
        _consume(r, assets, shares);
        reservedAssets -= assets;
        IERC20(_quote).safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address controller)
        public
        nonReentrant
        returns (uint256 shares)
    {
        _checkController(controller);
        Request storage r = _syncRedeem(controller);
        if (assets == 0 || assets > r.claimable) revert InvalidParams();
        shares = Math.mulDiv(r.claimableBase, assets, r.claimable, Math.Rounding.Ceil);
        _consume(r, assets, shares);
        reservedAssets -= assets;
        IERC20(_quote).safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return deposit(assets, receiver, msg.sender);
    }

    function mint(uint256 shares, address receiver) external returns (uint256) {
        return mint(shares, receiver, msg.sender);
    }

    /// @notice Claim this account's share of defaulted collateral.
    function claimAssets(address account) external nonReentrant {
        _accrue(account);
        for (uint256 i; i < _assets.length; ++i) {
            address a = _assets[i];
            uint256 amt = assetCredit[account][a];
            if (amt == 0) continue;
            assetCredit[account][a] = 0;
            assetReserved[a] -= amt;
            IERC20(a).safeTransfer(account, amt);
            emit AssetsClaimed(account, a, amt);
        }
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    // ================================================================ ERC-4626 / ERC-7575 views

    function asset() external view returns (address) {
        return _quote;
    }

    function share() external view returns (address) {
        return address(this);
    }

    /// @dev Shares carry 6 more decimals than the quote token (the virtual-share offset).
    function decimals() public view override(ERC20, IERC20Metadata) returns (uint8) {
        return IERC20Metadata(_quote).decimals() + 6;
    }

    /// @notice NAV estimate: idle quote plus this epoch's investments at cost. Interest shows up at roll.
    function totalAssets() public view returns (uint256) {
        uint256 bal = IERC20(_quote).balanceOf(address(this)) + core.pending(_quote, address(this));
        return bal + costBasis - reservedAssets - pendingDepositAssets;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        (uint256 a, uint256 s) = _lastPrice();
        return _toShares(assets, a, s);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        (uint256 a, uint256 s) = _lastPrice();
        return _toAssets(shares, a, s);
    }

    function maxDeposit(address controller) external view returns (uint256) {
        Request memory r = _deposits[controller];
        return r.claimableBase + (epochs[r.epoch].rolled ? r.pending : 0);
    }

    function maxMint(address controller) external view returns (uint256) {
        Request memory r = _deposits[controller];
        Epoch memory ep = epochs[r.epoch];
        return r.claimable + (ep.rolled && r.pending != 0 ? _toShares(r.pending, ep.assets, ep.supply) : 0);
    }

    function maxWithdraw(address controller) external view returns (uint256) {
        Request memory r = _redeems[controller];
        Epoch memory ep = epochs[r.epoch];
        return r.claimable + (ep.rolled && r.pending != 0 ? _toAssets(r.pending, ep.assets, ep.supply) : 0);
    }

    function maxRedeem(address controller) external view returns (uint256) {
        Request memory r = _redeems[controller];
        return r.claimableBase + (epochs[r.epoch].rolled ? r.pending : 0);
    }

    function previewDeposit(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewMint(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewWithdraw(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC7540Operator).interfaceId
            || id == type(IERC7540Deposit).interfaceId || id == type(IERC7540Redeem).interfaceId
            || id == (type(IERC4626).interfaceId ^ type(IERC7575).interfaceId);
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function positions() external view returns (Position[] memory) {
        return _positions;
    }

    function pendingAssetCredit(address account, address a) external view returns (uint256) {
        if (account == address(this)) return 0;
        return assetCredit[account][a] + Math.mulDiv(balanceOf(account), accPerShare[a], ACC) - _debt[account][a];
    }

    // ================================================================ internals

    function _nextExpiry() internal view returns (uint64) {
        GridConfig memory g = core.grid();
        uint256 n = (block.timestamp - g.anchor) / g.period + 1;
        return uint64(g.anchor + n * g.period);
    }

    function _lastPrice() internal view returns (uint256 a, uint256 s) {
        Epoch memory ep = epochs[epoch - 1];
        return (ep.assets, ep.supply);
    }

    function _toShares(uint256 a, uint256 nav, uint256 supply) internal pure returns (uint256) {
        return Math.mulDiv(a, supply + OFFSET, nav + 1);
    }

    function _toAssets(uint256 sh, uint256 nav, uint256 supply) internal pure returns (uint256) {
        return Math.mulDiv(sh, nav + 1, supply + OFFSET);
    }

    function _redeemEstimate() internal view returns (uint256) {
        uint256 rs = pendingRedeemShares;
        if (rs == 0) return 0;
        (uint256 a, uint256 s) = _lastPrice();
        return _toAssets(rs, a, s);
    }

    function _track(bytes32 pid, uint64 id) internal {
        _epochOrders[pid].push(id);
        uint256 n = _positions.length;
        for (uint256 i; i < n; ++i) {
            if (_positions[i].poolId == pid) {
                _positions[i].lastOrder = id;
                return;
            }
        }
        _positions.push(Position(pid, id));
    }

    /// @dev Only called from roll (nonReentrant); external calls go to the immutable core and plain ERC-20 reads.
    // slither-disable-next-line reentrancy-no-eth
    function _distributeAssets(uint64 e, uint256 supply) internal {
        for (uint256 i; i < _assets.length; ++i) {
            address a = _assets[i];
            core.withdraw(a, address(this));
            uint256 fresh = IERC20(a).balanceOf(address(this)) - assetReserved[a];
            if (fresh != 0 && supply != 0) {
                accPerShare[a] += Math.mulDiv(fresh, ACC, supply);
                assetReserved[a] += fresh;
            }
            accAtRoll[e][a] = accPerShare[a];
        }
    }

    /// @dev Converts a request whose epoch has rolled into claimable amounts. Custody shares accrue defaulted assets
    /// from the roll they were minted at (deposits) or up to the roll that redeemed them (redemptions).
    function _syncDeposit(address controller) internal returns (Request storage r) {
        r = _deposits[controller];
        Epoch memory ep = epochs[r.epoch];
        bool convert = r.pending != 0 && ep.rolled;
        uint256 shares = convert ? _toShares(r.pending, ep.assets, ep.supply) : 0;
        for (uint256 i; i < _assets.length; ++i) {
            address a = _assets[i];
            uint256 acc = accPerShare[a];
            // unclaimed custody shares keep accruing until they are transferred out
            uint256 credit = Math.mulDiv(r.claimable, acc - _claimableSnap[controller][a], ACC);
            if (convert) credit += Math.mulDiv(shares, acc - accAtRoll[r.epoch][a], ACC);
            assetCredit[controller][a] += credit;
            _claimableSnap[controller][a] = acc;
        }
        if (convert) {
            r.claimable += shares;
            r.claimableBase += r.pending;
            r.pending = 0;
        }
    }

    function _syncRedeem(address controller) internal returns (Request storage r) {
        r = _redeems[controller];
        Epoch memory ep = epochs[r.epoch];
        if (r.pending != 0 && ep.rolled) {
            uint64 prev = r.epoch - 1;
            for (uint256 i; i < _assets.length; ++i) {
                address a = _assets[i];
                assetCredit[controller][a] += Math.mulDiv(r.pending, accAtRoll[r.epoch][a] - accAtRoll[prev][a], ACC);
            }
            r.claimable += _toAssets(r.pending, ep.assets, ep.supply);
            r.claimableBase += r.pending;
            r.pending = 0;
        }
    }

    function _consume(Request storage r, uint256 claimable, uint256 base) internal {
        r.claimable -= claimable;
        r.claimableBase -= base;
    }

    function _checkController(address controller) internal view {
        if (controller != msg.sender && !isOperator[controller][msg.sender]) revert Unauthorized();
    }

    function _accrue(address account) internal {
        if (account == address(this) || account == address(0)) return;
        uint256 bal = balanceOf(account);
        for (uint256 i; i < _assets.length; ++i) {
            address a = _assets[i];
            uint256 owed = Math.mulDiv(bal, accPerShare[a], ACC);
            assetCredit[account][a] += owed - _debt[account][a];
            _debt[account][a] = owed;
        }
    }

    function _resetDebt(address account) internal {
        if (account == address(this) || account == address(0)) return;
        uint256 bal = balanceOf(account);
        for (uint256 i; i < _assets.length; ++i) {
            _debt[account][_assets[i]] = Math.mulDiv(bal, accPerShare[_assets[i]], ACC);
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        _accrue(from);
        _accrue(to);
        super._update(from, to, value);
        _resetDebt(from);
        _resetDebt(to);
    }
}
