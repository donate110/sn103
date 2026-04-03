"""Shield configuration."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ShieldConfig:
    """Configuration for the tunnel shield.

    Subnets override these to match their epoch cadence and risk tolerance.
    """

    # Tunnel activation
    enabled: bool = True
    cloudflare_token: str = ""  # Empty = quick tunnel (emergency only)

    # DDoS detection: activate emergency tunnel after this many seconds
    # without a validator ping. Set expected_ping_interval=0 to disable
    # auto-detection (named tunnel runs permanently if token is set).
    expected_ping_interval: float = 12.0  # seconds between pings from any validator
    min_missed_pings: int = 5  # consecutive misses before DDoS detection
    recovery_cooldown: float = 300.0  # seconds of stable pings before deactivating emergency tunnel

    # On-chain commitment
    recommit_interval: float = 3600.0  # re-commit URL every hour
    commitment_max_age: float = 7200.0  # validators reject commitments older than 2 hours

    # Validator-side fallback
    direct_failure_threshold: int = 2  # switch to tunnel after N consecutive direct-IP failures
    direct_probe_interval: float = 300.0  # probe direct IP every 5 min while in tunnel mode

    # Notary sidecar tunnel (named tunnels only, requires CLOUDFLARE_TOKEN)
    notary_tunnel_enabled: bool = False
    notary_port: int = 8091  # local port of the TLSNotary sidecar

    # Binary management
    cloudflared_path: str = ""  # auto-detect or download if empty
    cloudflared_checksum: str = ""  # SHA256 of expected binary (empty = skip verification)

    @property
    def ping_silence_threshold(self) -> float:
        """Seconds of silence before DDoS detection triggers."""
        return self.expected_ping_interval * self.min_missed_pings
