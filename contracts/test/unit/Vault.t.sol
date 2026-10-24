// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {NC_SELL, NC_BUY} from "../../src/libraries/OrderSet.sol";
import {Vault} from "../../src/periphery/Vault.sol";

/// @dev Graduated WETH/USDC American market, target pool `p5` (cadence from `_cadence`), one vault.
abstract contract VaultBase is Base {
    Vault internal vault;
    bytes32 internal p5;
    uint64 internal constant E4 = ANCHOR + 4 * WEEK;
    uint64 internal constant E5 = ANCHOR + 5 * WEEK;
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");

    function _config() internal view override returns (Confluere.Config memory c) {
        c = super._config();
        c.chains[0].graduationQuotes = new address[](1);
        c.chains[0].graduationFees = new uint256[](1);
        c.chains[0].graduationQuotes[0] = address(usdc);
        c.chains[0].graduationFees[0] = 0.8e6; // trade fees of one 1-ETH fill at 2900: 2 x 0.435 USDC
    }

    function setUp() public override {
        super.setUp();
        // four clean weeks graduate the WETH/USDC American market
        for (uint64 i = 1; i <= 4; ++i) {
            uint64 e = ANCHOR + i * WEEK;
            vm.warp(e - 3 days);
            bytes32 pid = _create(K, Kind.American, e);
            _sell(alice, pid, ONE, 2900e6);
            _buy(bob, pid, ONE, 2900e6);
            _settle(pid);
        }
        vm.warp(E4 + 1);
        core.graduate(address(weth), address(usdc), Kind.American, E4);
        p5 = _cadence() == 0
            ? _create(K, Kind.American, E5)
            : _createKey(core, _keyT(K, Kind.American, E5, 800, _cadence()), _noOpts());

        address[] memory as_ = new address[](1);
        as_[0] = address(weth);
        vault = new Vault(
            core,
            Vault.Strategy({
                quote: address(usdc),
                assets: as_,
                kind: Kind.American,
                strikeRule: Vault.StrikeRule.LowestTraded,
                perBatchCapBps: 2500,
                maxPriceBps: 9900
            }),
            "Confluere rvUSDC-ETH-Low",
            "rvUSDC-ETH-Low"
        );
        address[2] memory lps = [lp1, lp2];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(lps[i], 100_000e6);
            vm.prank(lps[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _cadence() internal pure virtual returns (uint8) {
        return 0;
    }

    function _closeP5() internal {
        vm.warp(E5);
        core.mature(p5);
        vm.roll(block.number + WINDOW);
        core.closeWindow(p5, 10);
    }

    function _depositAndRoll(address lp, uint256 amount) internal returns (uint256 shares) {
        vm.prank(lp);
        vault.requestDeposit(amount, lp, lp);
        assertEq(vault.pendingDepositRequest(0, lp), amount);
        vault.roll();
        assertEq(vault.claimableDepositRequest(0, lp), amount);
        vm.prank(lp);
        shares = vault.deposit(amount, lp, lp);
    }

    /// @dev Seeds a price in p5, then runs a batch where competitive volume leaves room for the vault's nc buy.
    function _investOnce() internal {
        _sell(alice, p5, ONE, 2900e6);
        _buy(bob, p5, ONE, 2900e6);
        _settle(p5); // sets the band base
        vm.warp(core.nextBatchAt(p5) - 1);
        vault.poke();
        _sell(alice, p5, 2 * ONE, 2900e6);
        _buy(bob, p5, 2 * ONE, 2900e6);
        _order(dave, p5, NC_SELL, ONE, 0, 0, 1);
        _settle(p5);
    }
}

contract VaultTest is VaultBase {
    function test_targetsLowestTradedStrikeInGraduatedMarket() public view {
        assertEq(vault.targetExpiry(), E5);
        assertEq(vault.targetPool(address(weth)), p5);
    }

    function test_firstDepositRollsImmediately() public {
        uint256 shares = _depositAndRoll(lp1, 10_000e6);
        assertEq(shares, 10_000e6 * 1e6, "1:1 for the first epoch, with the 6-decimal virtual-share offset");
        assertEq(vault.balanceOf(lp1), shares);
        assertEq(vault.epoch(), 2);
    }

    function test_pokeInvests25pct_onlyNonCompetitive() public {
        _depositAndRoll(lp1, 10_000e6);
        _investOnce();
        // budget is 25% of idle; nc fills are capped by the budget and by half the competitive volume
        uint256 c = core.balanceOf(address(vault), _c(p5));
        assertGt(c, 0, "vault holds C");
        assertLe(c, ONE);
        assertEq(core.balanceOf(address(vault), _r(p5)), 0, "never R");
        vault.poke();
        vm.expectRevert(Vault.NotReady.selector);
        vault.poke(); // once per batch
    }

    function test_fullCycle_repaid_navUp_redeem() public {
        _depositAndRoll(lp1, 10_000e6);
        _investOnce();
        uint256 c = core.balanceOf(address(vault), _c(p5));

        // a second LP queues mid-epoch: no shares until the epoch closes
        vm.prank(lp2);
        vault.requestDeposit(10_000e6, lp2, lp2);
        vm.expectRevert(Vault.NotReady.selector);
        vault.roll();

        // borrowers repay everything, pool closes
        vm.warp(E5);
        core.mature(p5);
        uint256 rd = core.balanceOf(dave, _r(p5));
        uint256 ra = core.balanceOf(alice, _r(p5));
        vm.prank(dave);
        core.repay(p5, uint96(rd));
        vm.prank(alice);
        core.repay(p5, uint96(ra));
        vm.roll(block.number + WINDOW);
        core.closeWindow(p5, 10);

        vault.roll();
        (uint256 nav, uint256 supply,) = vault.epochs(2);
        assertEq(supply, 10_000e6 * 1e6);
        // interest: c units bought at 2900 (plus the 0.015% buyer trade fee) return all of K = 3000
        uint256 expected = 10_000e6 + c * 100e6 / ONE - (c * 2900e6 / ONE) * 150 / 1e6;
        assertApproxEqAbs(nav, expected, 10);

        // lp2 enters at the new price, so gets fewer shares than assets
        vm.prank(lp2);
        uint256 s2 = vault.deposit(10_000e6, lp2, lp2);
        assertLt(s2, 10_000e6 * 1e6);

        // lp1 redeems all: queued, then claimable after the next roll
        uint256 s1 = vault.balanceOf(lp1);
        vm.prank(lp1);
        vault.requestRedeem(s1, lp1, lp1);
        assertEq(vault.pendingRedeemRequest(0, lp1), s1);
        vault.roll(); // nothing invested this epoch yet
        uint256 before = usdc.balanceOf(lp1);
        vm.prank(lp1);
        uint256 out = vault.redeem(s1, lp1, lp1);
        assertEq(usdc.balanceOf(lp1) - before, out);
        assertApproxEqAbs(out, expected, 11);
    }

    function test_default_distributesAssets() public {
        _depositAndRoll(lp1, 6000e6);
        _depositAndRoll(lp2, 4000e6);
        _investOnce();
        uint256 c = core.balanceOf(address(vault), _c(p5));
        vm.warp(E5);
        core.mature(p5);
        vm.roll(block.number + WINDOW);
        core.closeWindow(p5, 10);
        vault.roll();

        // everyone defaulted: the vault's C became pro-rata WETH
        uint256 got = weth.balanceOf(address(vault));
        assertGt(got, 0);
        assertApproxEqAbs(got, c, 1);
        vault.claimAssets(lp1);
        vault.claimAssets(lp2);
        assertApproxEqAbs(weth.balanceOf(lp1), got * 6 / 10, 2);
        assertApproxEqAbs(weth.balanceOf(lp2), got * 4 / 10, 2);
    }

    function test_redeemerKeepsEpochDefaultShare() public {
        _depositAndRoll(lp1, 5000e6);
        _depositAndRoll(lp2, 5000e6);
        _investOnce();
        // lp1 asks to leave mid-epoch; still exposed to this epoch
        uint256 s1 = vault.balanceOf(lp1);
        vm.prank(lp1);
        vault.requestRedeem(s1, lp1, lp1);
        vm.warp(E5);
        core.mature(p5);
        vm.roll(block.number + WINDOW);
        core.closeWindow(p5, 10);
        vault.roll();
        uint256 got = weth.balanceOf(address(vault));
        vm.prank(lp1);
        vault.redeem(s1, lp1, lp1); // syncs the redeem request, credits its asset share
        vault.claimAssets(lp1);
        vault.claimAssets(lp2);
        assertApproxEqAbs(weth.balanceOf(lp1), got / 2, 2);
        assertApproxEqAbs(weth.balanceOf(lp2), got / 2, 2);
    }

    function test_idleRollNeedsWork() public {
        vm.expectRevert(Vault.NotReady.selector);
        vault.roll(); // nothing queued, nothing invested, target expiry ahead
        vm.prank(lp1);
        vault.requestDeposit(1e6, lp1, lp1);
        vault.roll(); // queued deposit: settles now
        assertEq(vault.epoch(), 2);
        vm.expectRevert(Vault.NotReady.selector);
        vault.roll();
        vm.warp(E5); // target passed while idle: roll moves the target forward
        vault.roll();
        assertEq(vault.targetExpiry(), E5 + WEEK);
    }

    /// V-1 (audit 2026-10-11): first-depositor donation. Without the virtual-share offset the victim's deposit
    /// rounded to zero shares and the attacker took it.
    function test_V1_donationAttackFails() public {
        usdc.mint(lp2, 2_000_000e6);
        vm.prank(lp2);
        vault.requestDeposit(1, lp2, lp2); // attacker: 1 wei
        vault.roll();
        vm.prank(lp2);
        vault.deposit(1, lp2, lp2);
        vm.prank(lp2);
        usdc.transfer(address(vault), 1_000_000e6); // donation inflates the share price

        vm.prank(lp1);
        vault.requestDeposit(1000e6, lp1, lp1); // victim
        vault.roll();
        vm.prank(lp1);
        uint256 shares = vault.deposit(1000e6, lp1, lp1);
        assertGt(shares, 0, "victim got shares");

        vm.prank(lp1);
        vault.requestRedeem(shares, lp1, lp1);
        vault.roll();
        vm.prank(lp1);
        uint256 out = vault.redeem(shares, lp1, lp1);
        assertGe(out, 999e6, "victim keeps >= 99.9% of the deposit");
    }

    /// Share accounting is fair for any deposit sizes: with nothing invested, everyone gets their deposit back
    /// within a few wei, regardless of who came first or how lopsided the amounts are.
    function testFuzz_roundTripNoLoss(uint64 a1, uint64 a2, uint64 a3) public {
        uint256 d1 = bound(a1, 1, 50_000e6);
        uint256 d2 = bound(a2, 1, 50_000e6);
        uint256 d3 = bound(a3, 1, 50_000e6);
        address lp3 = makeAddr("lp3");
        usdc.mint(lp3, 100_000e6);
        vm.prank(lp3);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(lp1);
        vault.requestDeposit(d1, lp1, lp1);
        vault.roll();
        vm.prank(lp2);
        vault.requestDeposit(d2, lp2, lp2);
        vm.prank(lp3);
        vault.requestDeposit(d3, lp3, lp3);
        vault.roll();

        address[3] memory lps = [lp1, lp2, lp3];
        uint256[3] memory ds = [d1, d2, d3];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(lps[i]);
            uint256 sh = vault.deposit(ds[i], lps[i], lps[i]);
            vault.requestRedeem(sh, lps[i], lps[i]);
            vm.stopPrank();
        }
        vault.roll();
        for (uint256 i; i < 3; ++i) {
            uint256 max = vault.maxRedeem(lps[i]);
            vm.prank(lps[i]);
            uint256 out = vault.redeem(max, lps[i], lps[i]);
            assertApproxEqAbs(out, ds[i], 3, "deposit returned");
            assertLe(out, ds[i], "never more than deposited");
        }
        assertGe(usdc.balanceOf(address(vault)), vault.reservedAssets(), "vault stays solvent");
    }

    function test_operatorsAndAuth() public {
        vm.prank(lp1);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.requestDeposit(1e6, lp1, lp2);
        vm.prank(lp2);
        vault.setOperator(lp1, true);
        vm.prank(lp1);
        vault.requestDeposit(1e6, lp2, lp2);
        vm.expectRevert(Vault.AsyncOnly.selector);
        vault.previewDeposit(1);
    }

    /// Audit #11: an unfilled vault order behind another account's live non-competitive buy is not cleaned up by the
    /// clearing; roll must purge it (not only the last order) so its escrow counts in this epoch's NAV.
    function test_rollPurgesEveryOrderOfTheEpoch() public {
        _depositAndRoll(lp1, 10_000e6);
        _order(bob, p5, NC_BUY, 0, 0, 1000e6, 1000); // long-lived, at the head of the queue
        for (uint256 i; i < 3; ++i) {
            vm.warp(core.nextBatchAt(p5) - 1);
            vault.poke();
            _settle(p5); // no competitive volume: nothing fills, the vault's ttl-1 order expires in place
        }
        _closeP5();
        vault.roll();
        (uint256 nav,,) = vault.epochs(2);
        assertEq(nav, 10_000e6, "every escrow refunded into this epoch");
        assertEq(core.pending(address(usdc), address(vault)), 0);
        assertEq(usdc.balanceOf(address(vault)), 10_000e6);
    }
}

/// Audit #11: the target pool is a long-tail pool (one clearing every 12 core batches).
contract VaultLongTailTest is VaultBase {
    function _cadence() internal pure override returns (uint8) {
        return 1;
    }

    function test_onePokePerClearingOfTheTargetPool() public {
        _depositAndRoll(lp1, 10_000e6);
        uint256 next = core.nextBatchAt(p5);
        assertEq(core.pool(p5).batchInterval, 12 * BATCH);
        // the keeper pokes every core batch until the 6 h boundary
        for (uint256 t = next - 11 * BATCH; t < next; t += BATCH) {
            vm.warp(t);
            vault.poke();
        }
        assertEq(10_000e6 - usdc.balanceOf(address(vault)), 2500e6, "25% of idle committed to one clearing");
        assertEq(vault.positions()[0].poolId, p5);
        // once the pool settles, its next clearing gets 25% of what is idle then (the first order expired unfilled
        // and still sits in the book until purged)
        vm.warp(next);
        core.settleBatch(p5);
        vm.warp(next + BATCH - 1);
        vault.poke();
        assertEq(10_000e6 - usdc.balanceOf(address(vault)), 2500e6 + 1875e6);
        vm.warp(next + 2 * BATCH - 1);
        vault.poke(); // a later core batch of the same 6 h batch adds nothing
        assertEq(10_000e6 - usdc.balanceOf(address(vault)), 2500e6 + 1875e6);
    }
}
