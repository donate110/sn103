// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

contract CreditLedgerTest is Test {
    CreditLedger public ledger;

    address public owner = address(this);
    address public authorizedCaller = address(0xA1);
    address public unauthorizedCaller = address(0xA2);
    address public user1 = address(0xB1);
    address public user2 = address(0xB2);

    function setUp() public {
        ledger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        ledger.setAuthorizedCaller(authorizedCaller, true);
    }

    // ─── Tests: Mint by authorized, check balance
    // ────────────────────────

    function test_mint_success() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        assertEq(ledger.balanceOf(user1), 1000e6);
    }

    function test_mint_multipleMints() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 500e6);
        vm.prank(authorizedCaller);
        ledger.mint(user1, 300e6);

        assertEq(ledger.balanceOf(user1), 800e6);
    }

    function test_mint_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit CreditLedger.CreditsMinted(user1, 1000e6);

        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);
    }

    function test_mint_revertOnZeroAmount() public {
        vm.expectRevert(CreditLedger.MintAmountZero.selector);
        vm.prank(authorizedCaller);
        ledger.mint(user1, 0);
    }

    function test_mint_revertOnZeroAddress() public {
        vm.expectRevert(CreditLedger.MintToZeroAddress.selector);
        vm.prank(authorizedCaller);
        ledger.mint(address(0), 100e6);
    }

    // ─── Tests: Burn by authorized
    // ───────────────────────────────────────

    function test_burn_success() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        vm.prank(authorizedCaller);
        ledger.burn(user1, 400e6);

        assertEq(ledger.balanceOf(user1), 600e6);
    }

    function test_burn_entireBalance() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        vm.prank(authorizedCaller);
        ledger.burn(user1, 1000e6);

        assertEq(ledger.balanceOf(user1), 0);
    }

    function test_burn_emitsEvent() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        vm.expectEmit(true, false, false, true);
        emit CreditLedger.CreditsBurned(user1, 500e6);

        vm.prank(authorizedCaller);
        ledger.burn(user1, 500e6);
    }

    // ─── Tests: Revert burn exceeding balance
    // ────────────────────────────

    function test_burn_revertExceedingBalance() public {
        vm.prank(authorizedCaller);
        ledger.mint(user1, 500e6);

        vm.expectRevert(abi.encodeWithSelector(CreditLedger.InsufficientCreditBalance.selector, user1, 500e6, 1000e6));
        vm.prank(authorizedCaller);
        ledger.burn(user1, 1000e6);
    }

    function test_burn_revertOnZeroBalance() public {
        vm.expectRevert(abi.encodeWithSelector(CreditLedger.InsufficientCreditBalance.selector, user1, 0, 100e6));
        vm.prank(authorizedCaller);
        ledger.burn(user1, 100e6);
    }

    function test_burn_revertOnZeroAmount() public {
        vm.expectRevert(CreditLedger.BurnAmountZero.selector);
        vm.prank(authorizedCaller);
        ledger.burn(user1, 0);
    }

    // ─── Tests: Revert mint/burn by unauthorized
    // ─────────────────────────

    function test_mint_revertByUnauthorized() public {
        vm.expectRevert(abi.encodeWithSelector(CreditLedger.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        ledger.mint(user1, 1000e6);
    }

    function test_burn_revertByUnauthorized() public {
        // First mint some credits
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        vm.expectRevert(abi.encodeWithSelector(CreditLedger.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        ledger.burn(user1, 500e6);
    }

    // ─── Tests: Non-transferable
    // ─────────────────────────────────────────

    function test_nonTransferable_noTransferFunction() public {
        // Mint credits to user1
        vm.prank(authorizedCaller);
        ledger.mint(user1, 1000e6);

        // Credits are separate per user, no way to transfer
        assertEq(ledger.balanceOf(user1), 1000e6);
        assertEq(ledger.balanceOf(user2), 0);

        // Mint separately to user2 -- balances remain independent
        vm.prank(authorizedCaller);
        ledger.mint(user2, 200e6);

        assertEq(ledger.balanceOf(user1), 1000e6);
        assertEq(ledger.balanceOf(user2), 200e6);
    }

    // ─── Tests: setAuthorizedCaller
    // ──────────────────────────────────────

    function test_setAuthorizedCaller_onlyOwner() public {
        address newCaller = address(0xCAFE);
        ledger.setAuthorizedCaller(newCaller, true);
        assertTrue(ledger.authorizedCallers(newCaller));

        ledger.setAuthorizedCaller(newCaller, false);
        assertFalse(ledger.authorizedCallers(newCaller));
    }

    function test_setAuthorizedCaller_revertNonOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        ledger.setAuthorizedCaller(address(0xDEAD), true);
    }

    // ─── Tests: balanceOf
    // ────────────────────────────────────────────────

    function test_balanceOf_zeroForNewAddress() public view {
        assertEq(ledger.balanceOf(address(0xDEAD)), 0);
    }
}
