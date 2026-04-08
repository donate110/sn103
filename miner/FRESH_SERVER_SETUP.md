# Fresh Server Setup for Djinn Miners

Quick guide to set up Djinn miners on a new server from scratch.

## Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16+ GB (add ~500MB per miner) |
| Storage | 20 GB SSD | 50 GB SSD |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 |
| Network | 100 Mbps | 1 Gbps |

## 1. System Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y git curl build-essential python3.11 python3.11-venv docker.io ufw

# Add user to docker group (logout/login required after)
sudo usermod -aG docker $USER
newgrp docker

# Install Node.js 20+ (for PM2)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install uv (fast Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.cargo/env
```

## 2. Clone Repository

```bash
mkdir -p ~/workspace && cd ~/workspace
git clone https://github.com/your-org/sn103.git
cd sn103
```

## 3. Setup Python Environment

```bash
cd miner

# Create virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# Install miner package
pip install -e .

cd ..
```

## 4. Configure Environment

```bash
cp miner/.env.example miner/.env
nano miner/.env
```

**Required settings:**

```bash
# Odds API key (get from https://the-odds-api.com)
ODDS_API_KEY=your_api_key_here

# Bittensor wallet (must match your registered wallet)
BT_WALLET_NAME=your_wallet_name
BT_NETWORK=finney
```

**DO NOT set these** (PM2 configures them per-miner):
- `BT_WALLET_HOTKEY`
- `API_PORT`
- `NOTARY_PORT`

## 5. Register Hotkeys on Bittensor

Each miner needs its own hotkey registered on Subnet 103.

```bash
# Install Bittensor CLI if not present
pip install bittensor

# Create wallet (skip if you already have one)
btcli wallet new_coldkey --wallet.name your_wallet_name

# Create and register hotkeys (4 miners example)
for i in 01 02 03 04; do
  btcli wallet new_hotkey --wallet.name your_wallet_name --wallet.hotkey h$i
  btcli subnet register --netuid 103 --wallet.name your_wallet_name --wallet.hotkey h$i
done
```

**Cost:** Registration requires ~0.1 TAO per hotkey.

## 6. Configure Firewall

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow miner API ports (validators send challenges here)
# For 4 miners: 15601-15604, for 20 miners: 15601-15620
sudo ufw allow 15601:15604/tcp

# Allow notary ports (peer MPC connections)
sudo ufw allow 7041:7044/tcp

# Enable firewall
sudo ufw enable
sudo ufw status
```

## 7. Create Logs Directory

```bash
mkdir -p miner/logs
```

## 8. Start Services

```bash
# Start Redis container (shared cache)
./scripts/pm2-redis.sh start

# Verify Redis is running
./scripts/pm2-redis.sh status

# Start broadcaster + miners
pm2 start ecosystem.config.js --only broadcaster,miner01,miner02,miner03,miner04

# Verify all processes are running
pm2 status
```

Expected output:
```
┌────┬────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name           │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ broadcaster    │ fork     │ 0    │ online    │ 0%       │ 40mb     │
│ 1  │ miner01        │ fork     │ 0    │ online    │ 0%       │ 220mb    │
│ 2  │ miner02        │ fork     │ 0    │ online    │ 0%       │ 220mb    │
│ 3  │ miner03        │ fork     │ 0    │ online    │ 0%       │ 220mb    │
│ 4  │ miner04        │ fork     │ 0    │ online    │ 0%       │ 220mb    │
└────┴────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

## 9. Enable Auto-Start on Reboot

```bash
pm2 save
pm2 startup
# Run the command it outputs (requires sudo)
```

## 10. Verify Miners Are Working

```bash
# Watch challenge results
pm2 logs --nostream --lines 50 | grep check_complete

# You should see entries like:
# {"total": 10, "available": 1, "time_ms": 5.2, ...}
```

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Odds API   │────▶│ Broadcaster │────▶│   Redis     │
│  (external) │     │  (1 proc)   │     │  (Docker)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
              ┌────────────────────────────────┼────────────────────────────────┐
              │                                │                                │
         ┌────▼────┐                      ┌────▼────┐                      ┌────▼────┐
         │ miner01 │                      │ miner02 │                      │ miner03 │
         │ :15601  │                      │ :15602  │                      │ :15603  │
         │ h01     │                      │ h02     │                      │ h03     │
         └─────────┘                      └─────────┘                      └─────────┘
```

- **Broadcaster**: Fetches live odds every 30s + historical odds every hour
- **Redis**: Shared cache (256MB, all miners read from here)
- **Miners**: Each with unique `API_PORT`, `NOTARY_PORT`, and `BT_WALLET_HOTKEY`

---

## Common Commands

| Task | Command |
|------|---------|
| View all processes | `pm2 status` |
| View miner logs | `pm2 logs miner01 --lines 100` |
| Monitor all | `pm2 monit` |
| Restart all | `pm2 restart all` |
| Restart one miner | `pm2 restart miner01` |
| Stop all | `pm2 stop all` |
| Check Redis | `./scripts/pm2-redis.sh status` |
| Check challenges | `pm2 logs --nostream --lines 100 \| grep check_complete` |

---

## Troubleshooting

### Miner shows "ODDS_API_KEY required"
```bash
# Check .env file exists and has the key
cat miner/.env | grep ODDS_API_KEY
```

### Redis connection refused
```bash
# Restart Redis
./scripts/pm2-redis.sh restart

# Check it's running
docker ps | grep redis
```

### Miner keeps restarting
```bash
# Check error logs
pm2 logs miner01 --err --lines 50

# Common causes:
# - Wrong wallet name
# - Hotkey not registered
# - Port conflict
```

### available: 0 on all challenges
This is normal during off-hours. Odds are only available for upcoming/live games:
- **NBA**: Games typically start 23:00-03:00 UTC
- **MLB**: Games typically start 17:00-03:00 UTC
- **NFL**: Off-season (Feb-Aug)

### Check API quota usage
```bash
pm2 logs broadcaster --nostream --lines 20 | grep api_remaining
```

---

## Scaling to 20 Miners

1. Register additional hotkeys:
```bash
for i in $(seq -w 5 20); do
  btcli wallet new_hotkey --wallet.name your_wallet_name --wallet.hotkey h$i
  btcli subnet register --netuid 103 --wallet.name your_wallet_name --wallet.hotkey h$i
done
```

2. Open additional ports:
```bash
sudo ufw allow 15605:15620/tcp
sudo ufw allow 7045:7060/tcp
```

3. Start additional miners:
```bash
pm2 start ecosystem.config.js --only miner05,miner06,miner07,...
```

4. Memory requirement: ~500MB per miner (20 miners ≈ 10GB RAM)

---

## Port Reference

| Miner | API Port | Notary Port | Hotkey |
|-------|----------|-------------|--------|
| miner01 | 15601 | 7041 | h01 |
| miner02 | 15602 | 7042 | h02 |
| miner03 | 15603 | 7043 | h03 |
| miner04 | 15604 | 7044 | h04 |
| ... | ... | ... | ... |
| miner20 | 15620 | 7060 | h20 |
