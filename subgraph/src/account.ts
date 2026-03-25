import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  PurchaseRecorded,
  OutcomeRecorded,
  NewCycleStarted,
  SettledChanged,
} from "../generated/Account/Account";
import { Account, Genius, Idiot, ProtocolStats } from "../generated/schema";

function accountId(genius: Bytes, idiot: Bytes): string {
  // Mirror the Solidity keccak256(abi.encodePacked(genius, idiot)) for a
  // deterministic ID, but use a human-readable format for GraphQL convenience
  return genius.toHexString() + "-" + idiot.toHexString();
}

function getOrCreateAccount(
  geniusAddr: Bytes,
  idiotAddr: Bytes,
  timestamp: BigInt
): Account {
  let id = accountId(geniusAddr, idiotAddr);
  let acct = Account.load(id);
  if (acct == null) {
    acct = new Account(id);
    acct.genius = geniusAddr.toHexString();
    acct.idiot = idiotAddr.toHexString();
    acct.currentCycle = BigInt.zero();
    acct.signalCount = BigInt.zero();
    acct.qualityScore = BigInt.zero();
    acct.settled = false;
    acct.createdAt = timestamp;

    // Ensure Genius and Idiot entities exist
    ensureGenius(geniusAddr, timestamp);
    ensureIdiot(idiotAddr, timestamp);
  }
  return acct;
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
    stats.uniqueGeniuses = BigInt.zero();
    stats.uniqueIdiots = BigInt.zero();
    stats.totalTrackRecordProofs = BigInt.zero();
  }
  return stats;
}

function ensureGenius(address: Bytes, timestamp: BigInt): void {
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
    genius.totalTrackRecordProofs = BigInt.zero();
    genius.totalFavorable = BigInt.zero();
    genius.totalUnfavorable = BigInt.zero();
    genius.totalVoid = BigInt.zero();
    genius.createdAt = timestamp;

    let stats = getOrCreateProtocolStats();
    stats.uniqueGeniuses = stats.uniqueGeniuses.plus(BigInt.fromI32(1));
    stats.save();

    genius.save();
  }
}

function ensureIdiot(address: Bytes, timestamp: BigInt): void {
  let id = address.toHexString();
  let idiot = Idiot.load(id);
  if (idiot == null) {
    idiot = new Idiot(id);
    idiot.totalPurchases = BigInt.zero();
    idiot.totalDeposited = BigInt.zero();
    idiot.totalWithdrawn = BigInt.zero();
    idiot.escrowBalance = BigInt.zero();
    idiot.totalFeesPaid = BigInt.zero();
    idiot.totalCreditsUsed = BigInt.zero();
    idiot.creditBalance = BigInt.zero();
    idiot.createdAt = timestamp;
    idiot.save();
  }
}

export function handlePurchaseRecorded(event: PurchaseRecorded): void {
  let acct = getOrCreateAccount(
    event.params.genius,
    event.params.idiot,
    event.block.timestamp
  );
  acct.signalCount = event.params.signalCount;
  acct.save();
}

export function handleOutcomeRecorded(event: OutcomeRecorded): void {
  let acct = getOrCreateAccount(
    event.params.genius,
    event.params.idiot,
    event.block.timestamp
  );

  // Update quality score: +1 for Favorable (1), -1 for Unfavorable (2), 0 for Void (3)
  let outcome = event.params.outcome;
  if (outcome == 1) {
    acct.qualityScore = acct.qualityScore.plus(BigInt.fromI32(1));
  } else if (outcome == 2) {
    acct.qualityScore = acct.qualityScore.minus(BigInt.fromI32(1));
  }
  acct.save();
}

export function handleNewCycleStarted(event: NewCycleStarted): void {
  let acct = getOrCreateAccount(
    event.params.genius,
    event.params.idiot,
    event.block.timestamp
  );
  acct.currentCycle = event.params.newCycle;
  acct.signalCount = BigInt.zero();
  acct.qualityScore = BigInt.zero();
  acct.settled = false;
  acct.save();
}

export function handleSettledChanged(event: SettledChanged): void {
  let acct = getOrCreateAccount(
    event.params.genius,
    event.params.idiot,
    event.block.timestamp
  );
  acct.settled = event.params.settled;
  acct.save();
}
