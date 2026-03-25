import { BigInt } from "@graphprotocol/graph-ts";
import { TrackRecordSubmitted } from "../generated/TrackRecord/TrackRecord";
import {
  TrackRecordProof,
  Genius,
  ProtocolStats,
} from "../generated/schema";

function getOrCreateGenius(address: string, timestamp: BigInt): Genius {
  let genius = Genius.load(address);
  if (genius == null) {
    genius = new Genius(address);
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

export function handleTrackRecordSubmitted(event: TrackRecordSubmitted): void {
  let recordId = event.params.recordId.toString();
  let geniusAddress = event.params.genius.toHexString();

  let proof = new TrackRecordProof(recordId);
  proof.genius = geniusAddress;
  proof.signalCount = event.params.signalCount;
  proof.totalGain = event.params.totalGain;
  proof.totalLoss = event.params.totalLoss;
  proof.favCount = event.params.favCount;
  proof.unfavCount = event.params.unfavCount;
  proof.voidCount = event.params.voidCount;
  proof.proofHash = event.params.proofHash;
  proof.submittedAt = event.block.timestamp;
  proof.submittedAtBlock = event.block.number;
  proof.submittedAtTx = event.transaction.hash;
  proof.save();

  let genius = getOrCreateGenius(geniusAddress, event.block.timestamp);
  genius.totalTrackRecordProofs = genius.totalTrackRecordProofs.plus(
    BigInt.fromI32(1)
  );
  genius.save();

  let stats = getOrCreateProtocolStats();
  stats.totalTrackRecordProofs = stats.totalTrackRecordProofs.plus(
    BigInt.fromI32(1)
  );
  stats.save();
}
