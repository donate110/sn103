// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Collateral} from "../src/Collateral.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

contract CollateralTest is Test {
    Collateral public col;
    MockUSDC public usdc;

    address public owner = address(this);
    address public genius = address(0xA1);
    address public authorizedCaller = address(0xA2);
    address public unauthorizedCaller = address(0xA3);
    address public recipient = address(0xA4);

    uint256 constant DEPOSIT_AMOUNT = 10_000e6; // 10,000 USDC

    function setUp() public {
        usdc = new MockUSDC();
        col = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        col.setAuthorized(authorizedCaller, true);

        // Fund genius with USDC and approve collateral contract
        usdc.mint(genius, DEPOSIT_AMOUNT);
        vm.prank(genius);
        usdc.approve(address(col), type(uint256).max);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _depositAs(address depositor, uint256 amount) internal {
        vm.prank(depositor);
        col.deposit(amount);
    }

    // ─── Tests: Deposit and check balance
    // ────────────────────────────────

    function test_deposit_success() public {
        _depositAs(genius, 5000e6);

        assertEq(col.getDeposit(genius), 5000e6);
        assertEq(col.getAvailable(genius), 5000e6);
        assertEq(col.getLocked(genius), 0);
        assertEq(usdc.balanceOf(address(col)), 5000e6);
    }

    function test_deposit_multipleDeposits() public {
        _depositAs(genius, 3000e6);
        _depositAs(genius, 2000e6);

        assertEq(col.getDeposit(genius), 5000e6);
    }

    function test_deposit_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit Collateral.Deposited(genius, 5000e6);

        _depositAs(genius, 5000e6);
    }

    function test_deposit_revertOnZeroAmount() public {
        vm.expectRevert(Collateral.ZeroAmount.selector);
        _depositAs(genius, 0);
    }

    // ─── Tests: Withdraw free collateral
    // ─────────────────────────────────

    function test_withdraw_freeCollateral() public {
        _depositAs(genius, 5000e6);

        vm.prank(genius);
        col.withdraw(3000e6);

        assertEq(col.getDeposit(genius), 2000e6);
        assertEq(usdc.balanceOf(genius), 8000e6); // 10k - 5k deposit + 3k withdraw = 8k
    }

    function test_withdraw_entireFreeBalance() public {
        _depositAs(genius, 5000e6);

        vm.prank(genius);
        col.withdraw(5000e6);

        assertEq(col.getDeposit(genius), 0);
        assertEq(usdc.balanceOf(genius), DEPOSIT_AMOUNT);
    }

    function test_withdraw_emitsEvent() public {
        _depositAs(genius, 5000e6);

        vm.expectEmit(true, false, false, true);
        emit Collateral.Withdrawn(genius, 2000e6);

        vm.prank(genius);
        col.withdraw(2000e6);
    }

    function test_withdraw_revertOnZeroAmount() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.ZeroAmount.selector);
        vm.prank(genius);
        col.withdraw(0);
    }

    // ─── Tests: Revert withdraw locked collateral
    // ────────────────────────

    function test_withdraw_revertWhenLockedExceedsAvailable() public {
        _depositAs(genius, 5000e6);

        // Lock 4k of the 5k deposit
        vm.prank(authorizedCaller);
        col.lock(1, genius, 4000e6);

        // Available = 5k - 4k = 1k. Trying to withdraw 2k should fail.
        vm.expectRevert(abi.encodeWithSelector(Collateral.WithdrawalExceedsAvailable.selector, 1000e6, 2000e6));
        vm.prank(genius);
        col.withdraw(2000e6);
    }

    function test_withdraw_succeedsForFreePortionWhenPartiallyLocked() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 3000e6);

        // Available = 5k - 3k = 2k, withdraw exactly 2k
        vm.prank(genius);
        col.withdraw(2000e6);

        assertEq(col.getDeposit(genius), 3000e6);
        assertEq(col.getLocked(genius), 3000e6);
        assertEq(col.getAvailable(genius), 0);
    }

    // ─── Tests: Lock by authorized caller
    // ────────────────────────────────

    function test_lock_byAuthorizedCaller() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);

        assertEq(col.getLocked(genius), 2000e6);
        assertEq(col.getAvailable(genius), 3000e6);
        assertEq(col.getSignalLock(genius, 1), 2000e6);
    }

    function test_lock_emitsEvent() public {
        _depositAs(genius, 5000e6);

        vm.expectEmit(true, true, false, true);
        emit Collateral.Locked(1, genius, 2000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);
    }

    function test_lock_multipleSignals() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 1000e6);
        vm.prank(authorizedCaller);
        col.lock(2, genius, 1500e6);

        assertEq(col.getLocked(genius), 2500e6);
        assertEq(col.getAvailable(genius), 2500e6);
        assertEq(col.getSignalLock(genius, 1), 1000e6);
        assertEq(col.getSignalLock(genius, 2), 1500e6);
    }

    // ─── Tests: Revert lock by unauthorized caller
    // ───────────────────────

    function test_lock_revertByUnauthorizedCaller() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.Unauthorized.selector);
        vm.prank(unauthorizedCaller);
        col.lock(1, genius, 1000e6);
    }

    // ─── Tests: Revert lock exceeding available
    // ──────────────────────────

    function test_lock_revertExceedingAvailable() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(abi.encodeWithSelector(Collateral.InsufficientFreeCollateral.selector, 5000e6, 6000e6));
        vm.prank(authorizedCaller);
        col.lock(1, genius, 6000e6);
    }

    function test_lock_revertOnZeroAmount() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.ZeroAmount.selector);
        vm.prank(authorizedCaller);
        col.lock(1, genius, 0);
    }

    // ─── Tests: Release by authorized caller
    // ─────────────────────────────

    function test_release_byAuthorizedCaller() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 3000e6);

        vm.prank(authorizedCaller);
        col.release(1, genius, 2000e6);

        assertEq(col.getLocked(genius), 1000e6);
        assertEq(col.getAvailable(genius), 4000e6);
        assertEq(col.getSignalLock(genius, 1), 1000e6);
    }

    function test_release_fullAmount() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 3000e6);

        vm.prank(authorizedCaller);
        col.release(1, genius, 3000e6);

        assertEq(col.getLocked(genius), 0);
        assertEq(col.getAvailable(genius), 5000e6);
        assertEq(col.getSignalLock(genius, 1), 0);
    }

    function test_release_emitsEvent() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 3000e6);

        vm.expectEmit(true, true, false, true);
        emit Collateral.Released(1, genius, 1000e6);

        vm.prank(authorizedCaller);
        col.release(1, genius, 1000e6);
    }

    function test_release_revertExceedingSignalLock() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);

        vm.expectRevert(abi.encodeWithSelector(Collateral.InsufficientSignalLock.selector, 2000e6, 3000e6));
        vm.prank(authorizedCaller);
        col.release(1, genius, 3000e6);
    }

    function test_release_revertByUnauthorized() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);

        vm.expectRevert(Collateral.Unauthorized.selector);
        vm.prank(unauthorizedCaller);
        col.release(1, genius, 1000e6);
    }

    function test_release_revertOnZeroAmount() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);

        vm.expectRevert(Collateral.ZeroAmount.selector);
        vm.prank(authorizedCaller);
        col.release(1, genius, 0);
    }

    // ─── Tests: Slash by authorized caller
    // ───────────────────────────────

    function test_slash_partialSlash() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.slash(genius, 2000e6, recipient);

        assertEq(col.getDeposit(genius), 3000e6);
        assertEq(usdc.balanceOf(recipient), 2000e6);
    }

    function test_slash_fullSlash() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.slash(genius, 5000e6, recipient);

        assertEq(col.getDeposit(genius), 0);
        assertEq(usdc.balanceOf(recipient), 5000e6);
    }

    function test_slash_exceedingDeposit_capsToAvailable() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.slash(genius, 8000e6, recipient);

        // Should cap at 5k (all deposits)
        assertEq(col.getDeposit(genius), 0);
        assertEq(usdc.balanceOf(recipient), 5000e6);
    }

    function test_slash_clampsLockedToDeposits() public {
        _depositAs(genius, 5000e6);

        // Lock 4k
        vm.prank(authorizedCaller);
        col.lock(1, genius, 4000e6);

        // Slash 3k -> deposits become 2k, locked clamped from 4k to 2k (CF-03)
        vm.prank(authorizedCaller);
        col.slash(genius, 3000e6, recipient);

        assertEq(col.getDeposit(genius), 2000e6);
        assertEq(col.getLocked(genius), 2000e6); // clamped to deposits
        assertEq(col.getAvailable(genius), 0);
        assertEq(usdc.balanceOf(recipient), 3000e6);
    }

    function test_slash_emitsEvent() public {
        _depositAs(genius, 5000e6);

        vm.expectEmit(true, false, true, true);
        emit Collateral.Slashed(genius, 2000e6, recipient);

        vm.prank(authorizedCaller);
        col.slash(genius, 2000e6, recipient);
    }

    function test_slash_revertByUnauthorized() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.Unauthorized.selector);
        vm.prank(unauthorizedCaller);
        col.slash(genius, 1000e6, recipient);
    }

    function test_slash_revertOnZeroAmount() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.ZeroAmount.selector);
        vm.prank(authorizedCaller);
        col.slash(genius, 0, recipient);
    }

    // ─── Tests: getAvailable returns correct value
    // ───────────────────────

    function test_getAvailable_noLocks() public {
        _depositAs(genius, 5000e6);
        assertEq(col.getAvailable(genius), 5000e6);
    }

    function test_getAvailable_withLocks() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);

        assertEq(col.getAvailable(genius), 3000e6);
    }

    function test_getAvailable_fullyLocked() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        col.lock(1, genius, 5000e6);

        assertEq(col.getAvailable(genius), 0);
    }

    function test_getAvailable_zeroDeposit() public {
        assertEq(col.getAvailable(genius), 0);
    }

    // ─── Tests: setAuthorized
    // ────────────────────────────────────────────

    function test_setAuthorized_onlyOwner() public {
        address newAuth = address(0xBEEF);
        col.setAuthorized(newAuth, true);
        assertTrue(col.authorized(newAuth));

        col.setAuthorized(newAuth, false);
        assertFalse(col.authorized(newAuth));
    }

    function test_setAuthorized_revertNonOwner() public {
        vm.prank(genius);
        vm.expectRevert();
        col.setAuthorized(address(0xDEAD), true);
    }

    // ─── Tests: slash when deposit is zero
    // ───────────────────────────────

    function test_slash_zeroDeposit_capsToZero() public {
        // Genius has no deposits — slash should transfer 0 USDC
        vm.prank(authorizedCaller);
        col.slash(genius, 1000e6, recipient);

        assertEq(col.getDeposit(genius), 0);
        assertEq(usdc.balanceOf(recipient), 0);
    }

    function test_slash_emitsEventWithCappedAmount() public {
        _depositAs(genius, 1000e6);

        // Try to slash 5k from 1k deposit — should emit with capped amount
        vm.expectEmit(true, false, true, true);
        emit Collateral.Slashed(genius, 1000e6, recipient);

        vm.prank(authorizedCaller);
        col.slash(genius, 5000e6, recipient);
    }

    // ─── Fuzz: deposit >= locked invariant
    // ───────────────────────────────

    /// @notice Fuzz: slash transfers exactly min(amount, deposit) USDC to recipient
    function testFuzz_slashAmountTransferred(uint256 depositSeed, uint256 slashSeed) public {
        uint256 depositAmount = bound(depositSeed, 1e6, DEPOSIT_AMOUNT);
        uint256 slashAmount = bound(slashSeed, 1, depositAmount * 2);

        _depositAs(genius, depositAmount);

        uint256 recipientBefore = usdc.balanceOf(recipient);
        uint256 geniusDepositBefore = col.getDeposit(genius);

        vm.prank(authorizedCaller);
        col.slash(genius, slashAmount, recipient);

        uint256 expectedSlash = slashAmount > depositAmount ? depositAmount : slashAmount;
        assertEq(usdc.balanceOf(recipient) - recipientBefore, expectedSlash, "Fuzz: recipient must receive min(slash, deposit)");
        assertEq(geniusDepositBefore - col.getDeposit(genius), expectedSlash, "Fuzz: deposit reduced by exact slash amount");
    }

    /// @notice Fuzz: slash with locked collateral -- getAvailable handles locked > deposit gracefully
    function testFuzz_slashWithLocked_invariants(uint256 depositSeed, uint256 lockSeed, uint256 slashSeed) public {
        uint256 depositAmount = bound(depositSeed, 2e6, DEPOSIT_AMOUNT);
        uint256 lockAmount = bound(lockSeed, 1e6, depositAmount);
        uint256 slashAmount = bound(slashSeed, 1, depositAmount * 2);

        _depositAs(genius, depositAmount);

        vm.prank(authorizedCaller);
        col.lock(1, genius, lockAmount);

        vm.prank(authorizedCaller);
        col.slash(genius, slashAmount, recipient);

        // Invariant: getAvailable returns 0 when locked > deposit (no underflow)
        uint256 avail = col.getAvailable(genius);
        uint256 dep = col.getDeposit(genius);
        uint256 lck = col.getLocked(genius);
        if (dep >= lck) {
            assertEq(avail, dep - lck, "Fuzz: available = deposit - locked when deposit >= locked");
        } else {
            assertEq(avail, 0, "Fuzz: available must be 0 when locked > deposit");
        }
    }

    function testFuzz_availableValid_afterSlash(uint256 depositSeed, uint256 lockSeed, uint256 slashSeed) public {
        uint256 depositAmount = bound(depositSeed, 1e6, DEPOSIT_AMOUNT);
        uint256 lockAmount = bound(lockSeed, 1e6, depositAmount);
        uint256 slashAmount = bound(slashSeed, 1e6, depositAmount * 2);

        _depositAs(genius, depositAmount);

        vm.prank(authorizedCaller);
        col.lock(1, genius, lockAmount);

        vm.prank(authorizedCaller);
        col.slash(genius, slashAmount, recipient);

        // Invariant: getAvailable never underflows
        uint256 avail = col.getAvailable(genius);
        uint256 dep = col.getDeposit(genius);
        uint256 lck = col.getLocked(genius);
        if (dep >= lck) {
            assertEq(avail, dep - lck, "Fuzz: available = deposit - locked");
        } else {
            assertEq(avail, 0, "Fuzz: available = 0 when locked > deposit");
        }
    }

    function testFuzz_depositGeLocked_afterSlashAndRelease(uint256 depositSeed, uint256 lockSeed, uint256 slashSeed)
        public
    {
        uint256 depositAmount = bound(depositSeed, 2e6, DEPOSIT_AMOUNT);
        uint256 lockAmount = bound(lockSeed, 1e6, depositAmount);
        uint256 slashAmount = bound(slashSeed, 1e6, depositAmount * 2);

        _depositAs(genius, depositAmount);

        vm.prank(authorizedCaller);
        col.lock(1, genius, lockAmount);

        vm.prank(authorizedCaller);
        col.slash(genius, slashAmount, recipient);

        // CF-04: release() now reverts on underflow instead of clamping.
        // After slash clamps locked to deposits, signalLock may exceed locked.
        // Only release if locked >= signalLock (mirrors production ordering where
        // releases happen before slash).
        uint256 signalLock = col.getSignalLock(genius, 1);
        uint256 currentLocked = col.getLocked(genius);
        if (signalLock > 0 && currentLocked >= signalLock) {
            vm.prank(authorizedCaller);
            col.release(1, genius, signalLock);
        }

        // Invariant: deposit >= locked
        assertGe(col.getDeposit(genius), col.getLocked(genius), "Fuzz: deposit must be >= locked after slash+release");
    }

    // ─── Invariant Tests: slash + release accounting
    // ──────────────────────

    function test_slash_then_release_accounting() public {
        _depositAs(genius, 5000e6);

        // Lock 3k across two signals
        vm.prank(authorizedCaller);
        col.lock(1, genius, 1500e6);
        vm.prank(authorizedCaller);
        col.lock(2, genius, 1500e6);

        // Slash 2k → deposits=3k, locked caps to 3k (from 3k), still consistent
        vm.prank(authorizedCaller);
        col.slash(genius, 2000e6, recipient);

        assertEq(col.getDeposit(genius), 3000e6);
        assertEq(col.getLocked(genius), 3000e6);

        // Release signal 1 (1.5k) → locked should go from 3k to 1.5k
        vm.prank(authorizedCaller);
        col.release(1, genius, 1500e6);

        assertEq(col.getLocked(genius), 1500e6);
        assertEq(col.getSignalLock(genius, 1), 0);
        assertEq(col.getSignalLock(genius, 2), 1500e6);

        // Available = 3k - 1.5k = 1.5k
        assertEq(col.getAvailable(genius), 1500e6);
    }

    function test_slash_exceeding_then_release_reverts_underflow() public {
        _depositAs(genius, 5000e6);

        // Lock 4k
        vm.prank(authorizedCaller);
        col.lock(1, genius, 4000e6);

        // Slash all 5k -> deposits=0, locked clamped to 0 (CF-03)
        vm.prank(authorizedCaller);
        col.slash(genius, 5000e6, recipient);

        assertEq(col.getDeposit(genius), 0);
        assertEq(col.getLocked(genius), 0); // clamped to deposits (0)
        assertEq(col.getAvailable(genius), 0);

        // signalLock still shows 4k (stale, but harmless after full slash)
        assertEq(col.getSignalLock(genius, 1), 4000e6);

        // CF-04: release now reverts on underflow instead of silently clamping.
        // This surfaces the accounting inconsistency rather than hiding it.
        // In production, Audit._releaseSignalLocks caps release to min(expectedLock, actualLock),
        // and releases happen BEFORE slash, so this path is only reachable via a bug.
        vm.expectRevert();
        vm.prank(authorizedCaller);
        col.release(1, genius, 4000e6);
    }

    function test_slash_returnsActualAmount() public {
        _depositAs(genius, 5000e6);

        vm.prank(authorizedCaller);
        uint256 slashed = col.slash(genius, 3000e6, recipient);
        assertEq(slashed, 3000e6, "Should return exact slash amount");
    }

    function test_slash_returnsCappedAmount() public {
        _depositAs(genius, 2000e6);

        vm.prank(authorizedCaller);
        uint256 slashed = col.slash(genius, 5000e6, recipient);
        assertEq(slashed, 2000e6, "Should return capped amount");
    }

    function test_slash_revertZeroRecipient() public {
        _depositAs(genius, 5000e6);

        vm.expectRevert(Collateral.ZeroAddress.selector);
        vm.prank(authorizedCaller);
        col.slash(genius, 1000e6, address(0));
    }

    function test_deposit_locked_available_invariant() public {
        _depositAs(genius, 10_000e6);

        // Lock various amounts
        vm.prank(authorizedCaller);
        col.lock(1, genius, 2000e6);
        vm.prank(authorizedCaller);
        col.lock(2, genius, 3000e6);

        // Invariant: available = deposit - locked
        assertEq(col.getAvailable(genius), col.getDeposit(genius) - col.getLocked(genius));

        // Slash 4k
        vm.prank(authorizedCaller);
        col.slash(genius, 4000e6, recipient);

        // After slash: deposit=6k, locked capped to 5k (but was already 5k, capped to 6k)
        // Actually locked was 5k, deposits became 6k, 5k <= 6k so locked stays 5k
        assertEq(col.getDeposit(genius), 6000e6);
        assertEq(col.getLocked(genius), 5000e6);

        // Invariant still holds
        assertEq(col.getAvailable(genius), col.getDeposit(genius) - col.getLocked(genius));
    }
}
