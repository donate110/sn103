import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  Deposited,
  Withdrawn,
  Locked,
  Released,
  Slashed,
} from "../generated/Collateral/Collateral";
import {
  CollateralPosition,
  Genius,
  ProtocolStats,
} from "../generated/schema";

function getOrCreateCollateralPosition(
  geniusAddress: Bytes,
  timestamp: BigInt
): CollateralPosition {
  let id = geniusAddress.toHexString();
  let position = CollateralPosition.load(id);
  if (position == null) {
    position = new CollateralPosition(id);
    position.genius = id;
    position.deposited = BigInt.zero();
    position.locked = BigInt.zero();
    position.available = BigInt.zero();
    position.totalSlashed = BigInt.zero();
    position.lastUpdatedAt = timestamp;
  }
  return position;
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

function updateAvailable(position: CollateralPosition): void {
  let diff = position.deposited.minus(position.locked);
  position.available = diff.gt(BigInt.zero()) ? diff : BigInt.zero();
}

export function handleCollateralDeposited(event: Deposited): void {
  let position = getOrCreateCollateralPosition(
    event.params.genius,
    event.block.timestamp
  );
  position.deposited = position.deposited.plus(event.params.amount);
  updateAvailable(position);
  position.lastUpdatedAt = event.block.timestamp;
  position.save();

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  genius.collateralDeposited = genius.collateralDeposited.plus(
    event.params.amount
  );
  genius.save();

  let stats = getOrCreateProtocolStats();
  stats.totalCollateralDeposited = stats.totalCollateralDeposited.plus(
    event.params.amount
  );
  stats.save();
}

export function handleCollateralWithdrawn(event: Withdrawn): void {
  let position = getOrCreateCollateralPosition(
    event.params.genius,
    event.block.timestamp
  );
  position.deposited = position.deposited.gt(event.params.amount)
    ? position.deposited.minus(event.params.amount)
    : BigInt.zero();
  updateAvailable(position);
  position.lastUpdatedAt = event.block.timestamp;
  position.save();

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  genius.collateralDeposited = genius.collateralDeposited.gt(event.params.amount)
    ? genius.collateralDeposited.minus(event.params.amount)
    : BigInt.zero();
  genius.save();
}

export function handleCollateralLocked(event: Locked): void {
  let position = getOrCreateCollateralPosition(
    event.params.genius,
    event.block.timestamp
  );
  position.locked = position.locked.plus(event.params.amount);
  updateAvailable(position);
  position.lastUpdatedAt = event.block.timestamp;
  position.save();

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  genius.collateralLocked = genius.collateralLocked.plus(event.params.amount);
  genius.save();
}

export function handleCollateralReleased(event: Released): void {
  let position = getOrCreateCollateralPosition(
    event.params.genius,
    event.block.timestamp
  );
  if (position.locked.lt(event.params.amount)) {
    position.locked = BigInt.zero();
  } else {
    position.locked = position.locked.minus(event.params.amount);
  }
  updateAvailable(position);
  position.lastUpdatedAt = event.block.timestamp;
  position.save();

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  if (genius.collateralLocked.lt(event.params.amount)) {
    genius.collateralLocked = BigInt.zero();
  } else {
    genius.collateralLocked = genius.collateralLocked.minus(event.params.amount);
  }
  genius.save();
}

export function handleCollateralSlashed(event: Slashed): void {
  let position = getOrCreateCollateralPosition(
    event.params.genius,
    event.block.timestamp
  );
  position.deposited = position.deposited.gt(event.params.amount)
    ? position.deposited.minus(event.params.amount)
    : BigInt.zero();
  position.totalSlashed = position.totalSlashed.plus(event.params.amount);
  // Cap locked at deposited after slash (mirrors contract logic)
  if (position.locked.gt(position.deposited)) {
    position.locked = position.deposited;
  }
  updateAvailable(position);
  position.lastUpdatedAt = event.block.timestamp;
  position.save();

  let genius = getOrCreateGenius(event.params.genius, event.block.timestamp);
  genius.collateralDeposited = genius.collateralDeposited.gt(event.params.amount)
    ? genius.collateralDeposited.minus(event.params.amount)
    : BigInt.zero();
  genius.totalSlashed = genius.totalSlashed.plus(event.params.amount);
  if (genius.collateralLocked.gt(genius.collateralDeposited)) {
    genius.collateralLocked = genius.collateralDeposited;
  }
  genius.save();

  let stats = getOrCreateProtocolStats();
  stats.totalCollateralSlashed = stats.totalCollateralSlashed.plus(
    event.params.amount
  );
  stats.save();
}
