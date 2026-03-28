const LEGACY_KEY = "djinn-sportsbook-prefs";

function prefsKey(address: string): string {
  return `djinn-sportsbook-prefs:${address.toLowerCase()}`;
}

export function getSportsbookPrefs(address?: string): string[] {
  if (!address) return [];
  try {
    const key = prefsKey(address);
    let stored = localStorage.getItem(key);

    // Lazy migration: move legacy non-namespaced data to namespaced key
    if (!stored) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_KEY);
        stored = legacy;
      }
    }

    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

export function setSportsbookPrefs(address: string, prefs: string[]): void {
  try {
    localStorage.setItem(prefsKey(address), JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable in private browsing mode
  }
}

// ---------------------------------------------------------------------------
// Genius signal creation defaults
// ---------------------------------------------------------------------------

export interface GeniusDefaults {
  maxPriceBps?: string;
  slaMultiplier?: string;
  maxNotional?: string;
  minNotional?: string;
  expiresIn?: string;
  isExclusive?: boolean;
}

function geniusDefaultsKey(address: string): string {
  return `djinn-genius-defaults:${address.toLowerCase()}`;
}

export function getGeniusDefaults(address?: string): GeniusDefaults {
  if (!address || typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(geniusDefaultsKey(address));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function setGeniusDefaults(address: string, defaults: GeniusDefaults): void {
  try {
    localStorage.setItem(geniusDefaultsKey(address), JSON.stringify(defaults));
  } catch {
    // localStorage may be unavailable
  }
}

// ---------------------------------------------------------------------------
// Purchased signal data (idiot side)
// ---------------------------------------------------------------------------

export interface PurchasedSignalData {
  signalId: string;
  realIndex: number;
  pick: string;
  sportsbook: string;
  notional: string;
  purchasedAt: number;
}

function purchasedKey(address: string): string {
  return `djinn-purchased-signals:${address.toLowerCase()}`;
}

export function getPurchasedSignals(address?: string): PurchasedSignalData[] {
  if (!address || typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(purchasedKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePurchasedSignal(address: string, data: PurchasedSignalData): void {
  try {
    const existing = getPurchasedSignals(address);
    // Avoid duplicates
    if (existing.some((e) => e.signalId === data.signalId)) return;
    existing.push(data);
    localStorage.setItem(purchasedKey(address), JSON.stringify(existing));
  } catch {
    // localStorage may be unavailable
  }
}
