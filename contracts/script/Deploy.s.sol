// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC} from "../test/MockUSDC.sol"; // Used only on testnet chains (guarded by chain ID check)
import {Account as DjinnAccount} from "../src/Account.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {KeyRecovery} from "../src/KeyRecovery.sol";
import {Collateral} from "../src/Collateral.sol";
import {Escrow} from "../src/Escrow.sol";
import {Audit} from "../src/Audit.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title Deploy
/// @notice Deploys the full Djinn Protocol behind UUPS proxies with TimelockController governance.
///         On testnet, deploys MockUSDC and mints test tokens.
///         On mainnet, uses the real USDC contract at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
contract Deploy is Script {
    /// @dev Base mainnet USDC (Circle's official deployment)
    address constant BASE_MAINNET_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev Base Sepolia testnet chain ID
    uint256 constant BASE_SEPOLIA_CHAIN_ID = 84532;
    /// @dev Hardhat/Foundry local chain ID
    uint256 constant LOCAL_CHAIN_ID = 31337;

    struct Contracts {
        DjinnAccount acct;
        CreditLedger cl;
        SignalCommitment sc;
        KeyRecovery kr;
        Collateral coll;
        Escrow esc;
        Audit aud;
        OutcomeVoting voting;
        TimelockController timelock;
        address usdc;
    }

    function _proxy(address impl, bytes memory initData) internal returns (address) {
        return address(new ERC1967Proxy(impl, initData));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);
        address treasury = vm.envOr("PROTOCOL_TREASURY", deployer);
        address multisig = vm.envOr("MULTISIG_ADDRESS", deployer);
        address pauserAddr = vm.envOr("PAUSER_ADDRESS", deployer);

        console.log("Deployer:", deployer);
        console.log("Multisig:", multisig);
        console.log("Pauser:", pauserAddr);
        console.log("Protocol Treasury:", treasury);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerKey);

        Contracts memory c;
        c.usdc = _deployUsdc(deployer);
        _deployProxies(c, deployer);
        _wireContracts(c, treasury);
        _setupPauser(c, pauserAddr);
        c.timelock = _deployTimelock(multisig);
        _transferOwnership(c);
        _verify(c, pauserAddr);

        // Mint test USDC to deployer (explicit testnet allowlist only)
        if (block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == LOCAL_CHAIN_ID) {
            MockUSDC(c.usdc).mint(deployer, 1_000_000 * 1e6);
            console.log("Minted 1,000,000 USDC to deployer");
        }

        vm.stopBroadcast();
        _logSummary(c, multisig, pauserAddr);
    }

    function _deployUsdc(address) internal returns (address) {
        if (block.chainid == 8453) {
            console.log("Using real USDC:", BASE_MAINNET_USDC);
            return BASE_MAINNET_USDC;
        }
        require(
            block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == LOCAL_CHAIN_ID,
            "Deploy: unsupported chain ID"
        );
        MockUSDC usdc_ = new MockUSDC();
        console.log("MockUSDC:", address(usdc_));
        return address(usdc_);
    }

    function _deployProxies(Contracts memory c, address deployer) internal {
        c.acct = DjinnAccount(
            _proxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (deployer)))
        );
        console.log("Account (proxy):", address(c.acct));

        c.cl = CreditLedger(
            _proxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (deployer)))
        );
        console.log("CreditLedger (proxy):", address(c.cl));

        c.sc = SignalCommitment(
            _proxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (deployer)))
        );
        console.log("SignalCommitment (proxy):", address(c.sc));

        c.kr = new KeyRecovery();
        console.log("KeyRecovery:", address(c.kr));

        c.coll = Collateral(
            _proxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (c.usdc, deployer)))
        );
        console.log("Collateral (proxy):", address(c.coll));

        c.esc = Escrow(
            _proxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (c.usdc, deployer)))
        );
        console.log("Escrow (proxy):", address(c.esc));

        c.aud = Audit(
            _proxy(address(new Audit()), abi.encodeCall(Audit.initialize, (deployer)))
        );
        console.log("Audit (proxy):", address(c.aud));

        c.voting = OutcomeVoting(
            _proxy(address(new OutcomeVoting()), abi.encodeCall(OutcomeVoting.initialize, (deployer)))
        );
        console.log("OutcomeVoting (proxy):", address(c.voting));
    }

    function _wireContracts(Contracts memory c, address treasury) internal {
        // Audit -> all protocol contracts + treasury
        c.aud.setEscrow(address(c.esc));
        c.aud.setCollateral(address(c.coll));
        c.aud.setCreditLedger(address(c.cl));
        c.aud.setAccount(address(c.acct));
        c.aud.setSignalCommitment(address(c.sc));
        c.aud.setProtocolTreasury(treasury);
        c.aud.setOutcomeVoting(address(c.voting));

        // OutcomeVoting -> Audit + Account
        c.voting.setAudit(address(c.aud));
        c.voting.setAccount(address(c.acct));

        // Escrow -> protocol contracts + audit
        c.esc.setSignalCommitment(address(c.sc));
        c.esc.setCollateral(address(c.coll));
        c.esc.setCreditLedger(address(c.cl));
        c.esc.setAccount(address(c.acct));
        c.esc.setAuditContract(address(c.aud));

        // Collateral: authorize Escrow + Audit to lock/release/slash
        c.coll.setAuthorized(address(c.esc), true);
        c.coll.setAuthorized(address(c.aud), true);

        // CreditLedger: authorize Escrow + Audit to mint/burn credits
        c.cl.setAuthorizedCaller(address(c.esc), true);
        c.cl.setAuthorizedCaller(address(c.aud), true);

        // Account: authorize Escrow + Audit to record purchases and settle
        c.acct.setAuthorizedCaller(address(c.esc), true);
        c.acct.setAuthorizedCaller(address(c.aud), true);

        // SignalCommitment: authorize Escrow to update signal status
        c.sc.setAuthorizedCaller(address(c.esc), true);
    }

    function _setupPauser(Contracts memory c, address pauserAddr) internal {
        c.aud.setPauser(pauserAddr);
        c.esc.setPauser(pauserAddr);
        c.coll.setPauser(pauserAddr);
        c.sc.setPauser(pauserAddr);
        c.voting.setPauser(pauserAddr);
    }

    function _deployTimelock(address multisig) internal returns (TimelockController) {
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone can execute after delay
        TimelockController timelock = new TimelockController(
            259200, // 72 hours in seconds
            proposers,
            executors,
            address(0) // no admin — self-governing
        );
        console.log("TimelockController:", address(timelock));
        return timelock;
    }

    function _transferOwnership(Contracts memory c) internal {
        address tl = address(c.timelock);
        c.acct.transferOwnership(tl);
        c.cl.transferOwnership(tl);
        c.sc.transferOwnership(tl);
        c.coll.transferOwnership(tl);
        c.esc.transferOwnership(tl);
        c.aud.transferOwnership(tl);
        c.voting.transferOwnership(tl);
    }

    function _verify(Contracts memory c, address pauserAddr) internal view {
        address tl = address(c.timelock);

        // Wiring
        require(address(c.aud.escrow()) == address(c.esc), "Audit.escrow not wired");
        require(address(c.aud.collateral()) == address(c.coll), "Audit.collateral not wired");
        require(address(c.aud.creditLedger()) == address(c.cl), "Audit.creditLedger not wired");
        require(address(c.aud.account()) == address(c.acct), "Audit.account not wired");
        require(address(c.aud.signalCommitment()) == address(c.sc), "Audit.signalCommitment not wired");
        require(address(c.aud.outcomeVoting()) == address(c.voting), "Audit.outcomeVoting not wired");
        require(address(c.voting.audit()) == address(c.aud), "OutcomeVoting.audit not wired");
        require(address(c.voting.account()) == address(c.acct), "OutcomeVoting.account not wired");
        require(address(c.esc.signalCommitment()) == address(c.sc), "Escrow.signalCommitment not wired");
        require(address(c.esc.collateral()) == address(c.coll), "Escrow.collateral not wired");
        require(address(c.esc.creditLedger()) == address(c.cl), "Escrow.creditLedger not wired");
        require(address(c.esc.account()) == address(c.acct), "Escrow.account not wired");
        require(c.esc.auditContract() == address(c.aud), "Escrow.auditContract not wired");
        require(c.coll.authorized(address(c.esc)), "Collateral: Escrow not authorized");
        require(c.coll.authorized(address(c.aud)), "Collateral: Audit not authorized");
        require(c.cl.authorizedCallers(address(c.esc)), "CreditLedger: Escrow not authorized");
        require(c.cl.authorizedCallers(address(c.aud)), "CreditLedger: Audit not authorized");
        require(c.acct.authorizedCallers(address(c.esc)), "Account: Escrow not authorized");
        require(c.acct.authorizedCallers(address(c.aud)), "Account: Audit not authorized");

        // Pauser
        require(c.aud.pauser() == pauserAddr, "Audit: pauser not set");
        require(c.esc.pauser() == pauserAddr, "Escrow: pauser not set");
        require(c.coll.pauser() == pauserAddr, "Collateral: pauser not set");
        require(c.sc.pauser() == pauserAddr, "SignalCommitment: pauser not set");
        require(c.voting.pauser() == pauserAddr, "OutcomeVoting: pauser not set");

        // Ownership
        require(c.acct.owner() == tl, "Account: owner not timelock");
        require(c.cl.owner() == tl, "CreditLedger: owner not timelock");
        require(c.sc.owner() == tl, "SignalCommitment: owner not timelock");
        require(c.coll.owner() == tl, "Collateral: owner not timelock");
        require(c.esc.owner() == tl, "Escrow: owner not timelock");
        require(c.aud.owner() == tl, "Audit: owner not timelock");
        require(c.voting.owner() == tl, "OutcomeVoting: owner not timelock");

        console.log("All contract wiring, pauser, and ownership verified");
    }

    function _logSummary(Contracts memory c, address multisig, address pauserAddr) internal pure {
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE (UUPS Proxies + TimelockController) ===");
        console.log("Copy these proxy addresses to your .env files:");
        console.log("");
        console.log("NEXT_PUBLIC_USDC_ADDRESS=", c.usdc);
        console.log("NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS=", address(c.sc));
        console.log("NEXT_PUBLIC_ESCROW_ADDRESS=", address(c.esc));
        console.log("NEXT_PUBLIC_COLLATERAL_ADDRESS=", address(c.coll));
        console.log("NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS=", address(c.cl));
        console.log("NEXT_PUBLIC_ACCOUNT_ADDRESS=", address(c.acct));
        console.log("NEXT_PUBLIC_AUDIT_ADDRESS=", address(c.aud));
        console.log("OUTCOME_VOTING_ADDRESS=", address(c.voting));
        console.log("KEY_RECOVERY_ADDRESS=", address(c.kr));
        console.log("TIMELOCK_ADDRESS=", address(c.timelock));
        console.log("MULTISIG_ADDRESS=", multisig);
        console.log("PAUSER_ADDRESS=", pauserAddr);
    }
}
