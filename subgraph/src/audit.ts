import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  AuditSettled,
  EarlyExitSettled,
} from "../generated/Audit/Audit";
import {
  AuditResult,
  Account,
  Genius,
  Idiot,
  ProtocolStats,
} from "../generated/schema";

function auditResultId(
  genius: Bytes,
  idiot: Bytes,
  cycle: BigInt
): string {
  return (
    genius.toHexString() +
    "-" +
    idiot.toHexString() +
    "-" +
    cycle.toString()
  );
}

function accountId(genius: Bytes, idiot: Bytes): string {
  return genius.toHexString() + "-" + idiot.toHexString();
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

function ensureGenius(address: Bytes, timestamp: BigInt): Genius {
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
  }
  return genius;
}

function ensureIdiot(address: Bytes, timestamp: BigInt): Idiot {
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
  }
  return idiot;
}

export function handleAuditSettled(event: AuditSettled): void {
  let id = auditResultId(
    event.params.genius,
    event.params.idiot,
    event.params.cycle
  );

  let result = new AuditResult(id);
  result.genius = event.params.genius.toHexString();
  result.idiot = event.params.idiot.toHexString();
  result.account = accountId(event.params.genius, event.params.idiot);
  result.cycle = event.params.cycle;
  result.qualityScore = event.params.qualityScore;
  result.trancheA = event.params.trancheA;
  result.trancheB = event.params.trancheB;
  result.protocolFee = event.params.protocolFee;
  result.isEarlyExit = false;
  result.settledAt = event.block.timestamp;
  result.settledAtBlock = event.block.number;
  result.settledAtTx = event.transaction.hash;
  result.save();

  // Update Genius aggregate stats
  let genius = ensureGenius(event.params.genius, event.block.timestamp);
  genius.totalAudits = genius.totalAudits.plus(BigInt.fromI32(1));
  genius.aggregateQualityScore = genius.aggregateQualityScore.plus(
    event.params.qualityScore
  );
  genius.save();

  // Ensure Idiot entity exists
  let idiot = ensureIdiot(event.params.idiot, event.block.timestamp);
  idiot.save();

  // Update Account entity
  let acctId = accountId(event.params.genius, event.params.idiot);
  let account = Account.load(acctId);
  if (account != null) {
    account.qualityScore = event.params.qualityScore;
    account.settled = true;
    account.save();
  }

  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalAudits = stats.totalAudits.plus(BigInt.fromI32(1));
  stats.totalProtocolFees = stats.totalProtocolFees.plus(
    event.params.protocolFee
  );
  stats.save();
}

export function handleEarlyExitSettled(event: EarlyExitSettled): void {
  let id = auditResultId(
    event.params.genius,
    event.params.idiot,
    event.params.cycle
  );

  let result = new AuditResult(id);
  result.genius = event.params.genius.toHexString();
  result.idiot = event.params.idiot.toHexString();
  result.account = accountId(event.params.genius, event.params.idiot);
  result.cycle = event.params.cycle;
  result.qualityScore = event.params.qualityScore;
  result.trancheA = BigInt.zero();
  result.trancheB = event.params.creditsAwarded;
  result.protocolFee = BigInt.zero();
  result.isEarlyExit = true;
  result.settledAt = event.block.timestamp;
  result.settledAtBlock = event.block.number;
  result.settledAtTx = event.transaction.hash;
  result.save();

  // Update Genius aggregate stats
  let genius = ensureGenius(event.params.genius, event.block.timestamp);
  genius.totalAudits = genius.totalAudits.plus(BigInt.fromI32(1));
  genius.aggregateQualityScore = genius.aggregateQualityScore.plus(
    event.params.qualityScore
  );
  genius.save();

  // Ensure Idiot entity exists
  let idiot = ensureIdiot(event.params.idiot, event.block.timestamp);
  idiot.save();

  // Update Account entity
  let acctId = accountId(event.params.genius, event.params.idiot);
  let account = Account.load(acctId);
  if (account != null) {
    account.qualityScore = event.params.qualityScore;
    account.settled = true;
    account.save();
  }

  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalEarlyExits = stats.totalEarlyExits.plus(BigInt.fromI32(1));
  stats.save();
}
