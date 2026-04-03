# djinn-tunnel-shield

Zero-config DDoS protection for Bittensor miners via Cloudflare Tunnel.

## Install

```bash
pip install djinn-tunnel-shield
```

## Miner (3 lines)

```python
from djinn_tunnel_shield import MinerShield

shield = MinerShield(wallet, subtensor, netuid, port=8422)
asyncio.create_task(shield.run())

# In your health endpoint, include: {"tunnel_url": shield.tunnel_url}
```

**Without `CLOUDFLARE_TOKEN`**: emergency quick tunnel activates only when DDoS is detected (validator pings go silent). Logs a warning to set up a permanent tunnel.

**With `CLOUDFLARE_TOKEN`**: permanent named tunnel, stable URL, fully TOS-compliant.

## Validator (3 lines)

```python
from djinn_tunnel_shield import ShieldResolver

resolver = ShieldResolver(wallet=wallet)

# In health check, after parsing response:
resolver.cache_from_health(uid, health_data)

# When connecting to a miner:
for url in resolver.urls(uid, ip, port, "/health"):
    try:
        resp = await client.get(url)
        resolver.record_success(uid)
        break
    except Exception:
        resolver.record_failure(uid)
```

The resolver tries direct IP first. After consecutive failures, it switches to the cached tunnel URL. Periodically probes direct IP to detect recovery.

## How it works

1. Miner starts a Cloudflare Tunnel (quick or named)
2. Tunnel URL is encrypted per-validator (ECIES) and committed on-chain
3. Validators decrypt the URL and cache it
4. On direct-IP failure (DDoS), validators route through the tunnel
5. Cloudflare absorbs the volumetric attack; miner stays reachable

## Configuration

```python
from djinn_tunnel_shield import ShieldConfig

config = ShieldConfig(
    expected_ping_interval=12.0,  # seconds between validator pings
    min_missed_pings=5,           # consecutive misses before DDoS detection
    recovery_cooldown=300.0,      # seconds of stable pings before deactivating
    recommit_interval=3600.0,     # re-commit URL on-chain every hour
    direct_failure_threshold=2,   # switch to tunnel after N direct-IP failures
    direct_probe_interval=300.0,  # probe direct IP every 5 min while in tunnel mode
)
```

## Third-party services

This package uses [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (via the `cloudflared` binary) to route traffic through Cloudflare's network. By using this package, you agree to comply with [Cloudflare's Terms of Service](https://www.cloudflare.com/terms/) and [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/).

**Quick tunnels** (activated without `CLOUDFLARE_TOKEN`) use Cloudflare's `trycloudflare.com` service, which is intended for testing and development. This package only activates quick tunnels as a temporary emergency measure during detected DDoS attacks. For permanent, production-grade, TOS-compliant protection, set `CLOUDFLARE_TOKEN` to use a named tunnel with your own Cloudflare account (free tier is sufficient).

**Named tunnels** (activated with `CLOUDFLARE_TOKEN`) use Cloudflare's Zero Trust free plan, which supports production use. You are responsible for creating and managing your own Cloudflare account.

The `cloudflared` binary is downloaded from [Cloudflare's official GitHub releases](https://github.com/cloudflare/cloudflared/releases). This package verifies the binary via SHA256 checksum when configured.

Djinn Inc. is not affiliated with, endorsed by, or sponsored by Cloudflare, Inc. Cloudflare, cloudflared, and related marks are trademarks of Cloudflare, Inc.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. USE AT YOUR OWN RISK.

This package provides DDoS mitigation on a best-effort basis. It does not guarantee protection against all forms of attack. The authors and contributors are not liable for any damages, losses, or service disruptions arising from the use of this software, including but not limited to: data loss, missed validator pings, miner deregistration, lost emissions, or any financial losses.

You are solely responsible for:
- Compliance with Cloudflare's Terms of Service
- The security of your Cloudflare API tokens and credentials
- Monitoring the operation of tunnels on your infrastructure
- Any costs incurred from Cloudflare or other third-party services

This software automatically downloads and executes the `cloudflared` binary from Cloudflare's GitHub releases. While checksums are verified when configured, you should review and understand the software you run on your infrastructure.

## License

MIT. See [LICENSE](LICENSE) for full text.
