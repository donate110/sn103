/**
 * PM2 Multi-Miner Ecosystem Configuration
 *
 * Architecture:
 *   - Redis: docker container for shared cache
 *   - Broadcaster: single process fetching from The Odds API every 15s
 *   - Miners 01-20: each with unique ports, consuming from Redis cache
 *
 * Usage:
 *   # Install dependencies first
 *   cd miner && pip install -e . && cd ..
 *
 *   # Start Redis container
 *   ./scripts/pm2-redis.sh start
 *
 *   # Start all services
 *   pm2 start ecosystem.config.js
 *
 *   # Or start specific miners
 *   pm2 start ecosystem.config.js --only broadcaster,miner01,miner02
 *
 *   # Monitor
 *   pm2 monit
 *
 *   # View logs
 *   pm2 logs miner01 --lines 100
 *
 * API Usage: ~4 calls/minute (1 per sport every 15s) vs ~80/minute without sharing
 */

// Common environment for all miners
const COMMON_ENV = {
  BT_NETUID: '103',
  BT_NETWORK: 'finney',
  BT_WALLET_NAME: process.env.BT_WALLET_NAME || 'sn78_21',
  API_HOST: '0.0.0.0',
  // Use Redis provider instead of direct Odds API
  SPORTS_DATA_PROVIDER: 'djinn_miner.data.redis_provider.RedisOddsProvider',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  ODDS_L1_TTL: '5',
  ODDS_FALLBACK_API: 'false',
  LOG_FORMAT: 'json',
  // Limit concurrent attestations to prevent memory spikes
  ATTEST_MAX_CONCURRENT: '2',
  // CORS for production
  CORS_ORIGINS: 'https://app.djinn.com,https://staging.djinn.com',
};

// Generate miner configs for miners 01-20
function generateMiners(count = 20) {
  const miners = [];
  for (let i = 1; i <= count; i++) {
    const num = String(i).padStart(2, '0');
    const apiPort = 15600 + i;     // 15601-15620
    const notaryPort = 7040 + i;   // 7041-7060

    miners.push({
      name: `miner${num}`,
      script: '../scripts/venv-python.sh',
      args: '-m djinn_miner.main',
      cwd: './miner',
      interpreter: 'bash',
      env: {
        ...COMMON_ENV,
        BT_WALLET_HOTKEY: `h${num}`,
        API_PORT: String(apiPort),
        NOTARY_PORT: String(notaryPort),
        EXTERNAL_PORT: String(apiPort),
      },
      // PM2 settings
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '3G',  // Restart if single miner exceeds 3GB
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `./logs/miner${num}-error.log`,
      out_file: `./logs/miner${num}-out.log`,
      merge_logs: true,
      // Stagger startup to avoid thundering herd
      wait_ready: true,
      listen_timeout: 30000,
    });
  }
  return miners;
}

module.exports = {
  apps: [
    // ─────────────────────────────────────────────────────────────────────
    // Broadcaster: Single process that fetches from Odds API and pushes to Redis
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'broadcaster',
      script: '../scripts/venv-python.sh',
      args: '-m djinn_miner.data.odds_broadcaster',
      cwd: './miner',
      interpreter: 'bash',
      env: {
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        ODDS_API_KEY: process.env.ODDS_API_KEY,
        BROADCAST_INTERVAL: '30',  // 30s is sufficient; odds don't change faster
        ACTIVE_SPORTS: 'basketball_nba,football_nfl,baseball_mlb,hockey_nhl',
        LOG_FORMAT: 'json',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/broadcaster-error.log',
      out_file: './logs/broadcaster-out.log',
      merge_logs: true,
    },

    // ─────────────────────────────────────────────────────────────────────
    // Miners 01-20: Each with unique API port (15601-15620) and notary port (7041-7060)
    // ─────────────────────────────────────────────────────────────────────
    ...generateMiners(20),
  ],
};
