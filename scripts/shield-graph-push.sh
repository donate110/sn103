#!/usr/bin/env bash
# Regenerate the SN103 health dashboard and push to Telegram.
# Run via cron every 30 minutes.
set -euo pipefail

source /home/user/telegram-bot/.env

cd /home/user/djinn

python3 << 'PYEOF'
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

data = []
with open("/home/user/djinn/scripts/shield-metrics.jsonl") as f:
    for line in f:
        d = json.loads(line)
        if "avg_uptime" in d:
            data.append(d)

if len(data) < 3:
    print("Not enough data yet")
    import sys; sys.exit(1)

times = [datetime.fromisoformat(d["ts"].replace("Z", "+00:00")) for d in data]
healthy = [d["healthy_miners"] for d in data]
offline = [d["offline_miners"] for d in data]
uptime = [d["avg_uptime"] * 100 for d in data]
low_up = [d["low_uptime_miners"] for d in data]
attest = [d.get("avg_attestation_rate", 0) * 100 for d in data]

fig, axes = plt.subplots(4, 2, figsize=(14, 14), facecolor='#0f1729')
fig.suptitle(f"SN103 Network Health ({len(data)} samples, updated {times[-1].strftime('%H:%M UTC')})",
             color='white', fontsize=16, fontweight='bold', y=0.98)

for ax in axes.flat:
    ax.set_facecolor('#0f1729')
    ax.tick_params(colors='#94a3b8', labelsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
    for spine in ax.spines.values():
        spine.set_color('#334155')
    ax.grid(axis='y', color='#1e293b', alpha=0.5)

ax = axes[0, 0]
ax.plot(times, healthy, color='#10b981', linewidth=1.5)
ax.fill_between(times, healthy, alpha=0.2, color='#10b981')
ax.set_title('Healthy Miners', color='white', fontsize=11)
ax.set_ylabel('Count', color='#94a3b8')
ax.set_ylim(0, 260)

ax = axes[0, 1]
ax.plot(times, offline, color='#ef4444', linewidth=1.5)
ax.fill_between(times, offline, alpha=0.2, color='#ef4444')
ax.set_title('Offline Miners', color='white', fontsize=11)
ax.set_ylabel('Count', color='#94a3b8')

ax = axes[1, 0]
ax.plot(times, uptime, color='#f97316', linewidth=1.5)
ax.fill_between(times, uptime, alpha=0.2, color='#f97316')
ax.set_title('Average Miner Uptime %', color='white', fontsize=11)
ax.set_ylabel('%', color='#94a3b8')
ax.set_ylim(85, 100)

ax = axes[1, 1]
ax.plot(times, low_up, color='#f43f5e', linewidth=1.5)
ax.fill_between(times, low_up, alpha=0.2, color='#f43f5e')
ax.set_title('Miners Below 90% Uptime', color='white', fontsize=11)
ax.set_ylabel('Count', color='#94a3b8')

ax = axes[2, 0]
ax.plot(times, attest, color='#60a5fa', linewidth=1.5)
ax.fill_between(times, attest, alpha=0.2, color='#60a5fa')
ax.set_title('Miner Attestation Success Rate %', color='white', fontsize=11)
ax.set_ylabel('%', color='#94a3b8')
ax.set_ylim(70, 100)

# Version distribution (latest)
ax = axes[2, 1]
latest = data[-1]
mv = latest.get("miner_versions", {})
if mv and len(mv) > 1:
    versions = sorted(mv.items(), key=lambda x: -x[1])[:6]
    labels = [v[0] if v[0] != 'unknown' else '?' for v in versions]
    counts = [v[1] for v in versions]
    colors = ['#10b981', '#60a5fa', '#f97316', '#f43f5e', '#a78bfa', '#94a3b8']
    ax.barh(range(len(labels)), counts, color=colors[:len(labels)])
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels([f'v{l}' for l in labels], color='#94a3b8', fontsize=10)
    ax.set_title('Miner Version Distribution', color='white', fontsize=11)
    ax.set_xlabel('Count', color='#94a3b8')
else:
    ax.text(0.5, 0.5, 'Awaiting data', transform=ax.transAxes,
            ha='center', va='center', color='#475569', fontsize=14)
    ax.set_title('Miner Version Distribution', color='white', fontsize=11)

# Row 4: Our miner (UID 240) stats
our_uptime = [d.get("our_miner_240", {}).get("uptime", 0) * 100 for d in data]
our_weight = [d.get("our_miner_240", {}).get("weight", 0) for d in data]

ax = axes[3, 0]
ax.plot(times, our_uptime, color='#10b981', linewidth=2)
ax.fill_between(times, our_uptime, alpha=0.2, color='#10b981')
ax.axhline(y=100, color='#334155', linestyle='--', alpha=0.5)
ax.set_title('Our Miner (UID 240) Uptime %', color='white', fontsize=11)
ax.set_ylabel('%', color='#94a3b8')
ax.set_ylim(0, 105)

ax = axes[3, 1]
ax.plot(times, our_weight, color='#a78bfa', linewidth=2)
ax.fill_between(times, our_weight, alpha=0.2, color='#a78bfa')
avg_w = sum(w for w in our_weight if w > 0) / max(sum(1 for w in our_weight if w > 0), 1)
if avg_w > 0:
    ax.axhline(y=avg_w, color='#a78bfa', linestyle='--', alpha=0.3)
ax.set_title('Our Miner (UID 240) Weight', color='white', fontsize=11)
ax.set_ylabel('Weight', color='#94a3b8')

plt.subplots_adjust(bottom=0.05, top=0.94, hspace=0.4, wspace=0.25)
fig.text(0.02, 0.012, 'INFORMATION x EXECUTION', color='#475569', fontsize=9)
fig.text(0.98, 0.012, 'djinn.gg', color='#10b981', fontsize=10, ha='right', fontweight='bold')

out = '/home/user/djinn/tweets/daily/shield_timeseries.png'
plt.savefig(out, dpi=150, facecolor='#0f1729')
print(f"Chart saved: {out}")
PYEOF

# Push to Telegram
POINTS=$(wc -l < /home/user/djinn/scripts/shield-metrics.jsonl)
LATEST=$(tail -1 /home/user/djinn/scripts/shield-metrics.jsonl | python3 -c "
import sys,json
d=json.loads(sys.stdin.readline())
h=d.get('healthy_miners',0)
t=d.get('total_miners',0)
o=d.get('offline_miners',0)
u=d.get('avg_uptime',0)*100
a=d.get('avg_attestation_rate',0)*100
print(f'{h}/{t} healthy, {o} offline, {u:.1f}% uptime, {a:.1f}% attestation')
")

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto" \
  -F "chat_id=-1003733752686" \
  -F "photo=@/home/user/djinn/tweets/daily/shield_timeseries.png" \
  -F "caption=SN103 Health Update: ${LATEST} (${POINTS} samples)" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print('OK' if r.get('ok') else r)"
