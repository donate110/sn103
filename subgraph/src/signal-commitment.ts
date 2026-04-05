import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  SignalCommitted,
  SignalCancelled,
  SignalStatusUpdated,
  SignalCommitment,
} from "../generated/SignalCommitment/SignalCommitment";
import { Signal, Genius, ProtocolStats } from "../generated/schema";

// Maps the Solidity SignalStatus enum (uint8) to the GraphQL enum string
function statusToString(status: i32): string {
  if (status == 0) return "Active";
  if (status == 1) return "Cancelled";
  if (status == 2) return "Settled";
  return "Active";
}

function getOrCreateGenius(address: Bytes, timestamp: BigInt): Genius {
  let id = address.toHexString();
  let genius = Genius.load(id);
  if (genius == null) {
    genius = new Genius(id);
    genius.totalSignals = BigInt.zero();
    genius.activeSignals = BigInt.zero();
    genius.totalPurchases = BigInt.zero();
    genius.totalVolume = BigInt.zero();
    genius.totalFeesEarned = BigInt.zero();
    genius.totalFeesClaimed = BigInt.zero();
    genius.aggregateQualityScore = BigInt.zero();
    genius.totalAudits = BigInt.zero();
    genius.collateralDeposited = BigInt.zero();
    genius.collateralLocked = BigInt.zero();
    genius.totalSlashed = BigInt.zero();
    genius.totalFavorable = BigInt.zero();
    genius.totalUnfavorable = BigInt.zero();
    genius.totalVoid = BigInt.zero();
    genius.createdAt = timestamp;

    let stats = getOrCreateProtocolStats();
    stats.uniqueGeniuses = stats.uniqueGeniuses.plus(BigInt.fromI32(1));
    stats.save();
  }
  return genius;
}

function getOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load("1");
  if (stats == null) {
    stats = new ProtocolStats("1");
    stats.totalSignals = BigInt.zero();
    stats.totalPurchases = BigInt.zero();
    stats.totalVolume = BigInt.zero();
    stats.totalFees = BigInt.zero();
    stats.totalCreditsMinted = BigInt.zero();
    stats.totalCreditsBurned = BigInt.zero();
    stats.totalAudits = BigInt.zero();
    stats.totalEarlyExits = BigInt.zero();
    stats.totalProtocolFees = BigInt.zero();
    stats.totalCollateralDeposited = BigInt.zero();
    stats.totalCollateralSlashed = BigInt.zero();
    stats.totalRefunds = BigInt.zero();
    stats.uniqueGeniuses = BigInt.zero();
    stats.uniqueIdiots = BigInt.zero();
  }
  return stats;
}

export function handleSignalCommitted(event: SignalCommitted): void {
  let signalId = event.params.signalId.toString();
  let signal = new Signal(signalId);

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  genius.totalSignals = genius.totalSignals.plus(BigInt.fromI32(1));
  genius.activeSignals = genius.activeSignals.plus(BigInt.fromI32(1));
  genius.save();

  signal.genius = genius.id;
  signal.sport = event.params.sport;
  signal.maxPriceBps = event.params.maxPriceBps;
  signal.slaMultiplierBps = event.params.slaMultiplierBps;
  signal.maxNotional = event.params.maxNotional;
  signal.minNotional = BigInt.zero();
  signal.expiresAt = event.params.expiresAt;
  signal.status = "Active";
  signal.createdAt = event.block.timestamp;
  signal.createdAtBlock = event.block.number;
  signal.createdAtTx = event.transaction.hash;

  // v2 off-chain decoy lines: try_ calls for backward compat with v1 signals
  let contract = SignalCommitment.bind(event.address);
  let isV2Result = contract.tryCall(
    "isV2Signal",
    "isV2Signal(uint256):(bool)",
    [ethereum.Value.fromUnsignedBigInt(event.params.signalId)],
  );
  if (!isV2Result.reverted && isV2Result.value[0].toBoolean()) {
    // Signal is v2; read the extended struct from getSignal
    let sigResult = contract.tryCall(
      "getSignal",
      "getSignal(uint256):((address,bytes,bytes32,string,uint256,uint256,uint256,uint256,uint256,string[],string[],uint8,uint256,bytes32,uint16,bool))",
      [ethereum.Value.fromUnsignedBigInt(event.params.signalId)],
    );
    if (!sigResult.reverted) {
      let sigTuple = sigResult.value[0].toTuple();
      signal.minNotional = sigTuple[7].toBigInt();
      signal.linesHash = sigTuple[13].toBytes();
      signal.lineCount = sigTuple[14].toI32();
      signal.bpaMode = sigTuple[15].toBoolean();
    }
  }

  signal.save();

  let stats = getOrCreateProtocolStats();
  stats.totalSignals = stats.totalSignals.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleSignalCancelled(event: SignalCancelled): void {
  let signalId = event.params.signalId.toString();
  let signal = Signal.load(signalId);
  if (signal == null) return;

  let wasActive = signal.status == "Active";
  signal.status = "Cancelled";
  signal.save();

  // Only decrement if transitioning from Active (prevents double-decrement
  // when both SignalCancelled and SignalStatusUpdated fire for the same signal)
  if (wasActive) {
    let genius = Genius.load(signal.genius);
    if (genius != null) {
      genius.activeSignals = genius.activeSignals.gt(BigInt.zero())
        ? genius.activeSignals.minus(BigInt.fromI32(1))
        : BigInt.zero();
      genius.save();
    }
  }
}

export function handleSignalStatusUpdated(event: SignalStatusUpdated): void {
  let signalId = event.params.signalId.toString();
  let signal = Signal.load(signalId);
  if (signal == null) return;

  let oldStatus = signal.status;
  let newStatus = statusToString(event.params.newStatus);
  signal.status = newStatus;
  signal.save();

  // Update genius active signal count when transitioning away from Active
  if (oldStatus == "Active" && newStatus != "Active") {
    let genius = Genius.load(signal.genius);
    if (genius != null) {
      genius.activeSignals = genius.activeSignals.gt(BigInt.zero())
        ? genius.activeSignals.minus(BigInt.fromI32(1))
        : BigInt.zero();
      genius.save();
    }
  }
}
