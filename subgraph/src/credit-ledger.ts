import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  CreditsMinted,
  CreditsBurned,
} from "../generated/CreditLedger/CreditLedger";
import { CreditBalance, Idiot, ProtocolStats } from "../generated/schema";

function getOrCreateCreditBalance(
  address: Bytes,
  timestamp: BigInt
): CreditBalance {
  let id = address.toHexString();
  let balance = CreditBalance.load(id);
  if (balance == null) {
    balance = new CreditBalance(id);
    balance.balance = BigInt.zero();
    balance.totalMinted = BigInt.zero();
    balance.totalBurned = BigInt.zero();
    balance.lastUpdatedAt = timestamp;
  }
  return balance;
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

export function handleCreditsMinted(event: CreditsMinted): void {
  let creditBalance = getOrCreateCreditBalance(
    event.params.to,
    event.block.timestamp
  );
  creditBalance.balance = creditBalance.balance.plus(event.params.amount);
  creditBalance.totalMinted = creditBalance.totalMinted.plus(
    event.params.amount
  );
  creditBalance.lastUpdatedAt = event.block.timestamp;
  creditBalance.save();

  // Update Idiot credit balance if the entity exists
  let idiotId = event.params.to.toHexString();
  let idiot = Idiot.load(idiotId);
  if (idiot != null) {
    idiot.creditBalance = idiot.creditBalance.plus(event.params.amount);
    idiot.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalCreditsMinted = stats.totalCreditsMinted.plus(
    event.params.amount
  );
  stats.save();
}

export function handleCreditsBurned(event: CreditsBurned): void {
  let creditBalance = getOrCreateCreditBalance(
    event.params.from,
    event.block.timestamp
  );
  let newBalance = creditBalance.balance.minus(event.params.amount);
  creditBalance.balance = newBalance.gt(BigInt.zero()) ? newBalance : BigInt.zero();
  creditBalance.totalBurned = creditBalance.totalBurned.plus(
    event.params.amount
  );
  creditBalance.lastUpdatedAt = event.block.timestamp;
  creditBalance.save();

  // Update Idiot credit balance if the entity exists
  let idiotId = event.params.from.toHexString();
  let idiot = Idiot.load(idiotId);
  if (idiot != null) {
    let newIdiotBalance = idiot.creditBalance.minus(event.params.amount);
    idiot.creditBalance = newIdiotBalance.gt(BigInt.zero()) ? newIdiotBalance : BigInt.zero();
    idiot.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalCreditsBurned = stats.totalCreditsBurned.plus(
    event.params.amount
  );
  stats.save();
}
