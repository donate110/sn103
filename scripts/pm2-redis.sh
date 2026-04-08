#!/bin/bash
# Redis management for PM2 multi-miner setup
# Redis runs in Docker while miners run via PM2 for better memory management

set -e

REDIS_CONTAINER="djinn-redis"
REDIS_PORT=6379

case "$1" in
  start)
    if docker ps -q -f name=$REDIS_CONTAINER | grep -q .; then
      echo "✓ Redis already running"
    else
      # Remove stopped container if exists
      docker rm -f $REDIS_CONTAINER 2>/dev/null || true
      echo "Starting Redis..."
      docker run -d \
        --name $REDIS_CONTAINER \
        --restart unless-stopped \
        -p 127.0.0.1:$REDIS_PORT:6379 \
        redis:7-alpine \
        redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
      echo "✓ Redis started on localhost:$REDIS_PORT"
    fi
    ;;

  stop)
    echo "Stopping Redis..."
    docker stop $REDIS_CONTAINER 2>/dev/null || true
    docker rm $REDIS_CONTAINER 2>/dev/null || true
    echo "✓ Redis stopped"
    ;;

  restart)
    $0 stop
    $0 start
    ;;

  status)
    if docker ps -q -f name=$REDIS_CONTAINER | grep -q .; then
      echo "✓ Redis is running"
      docker exec $REDIS_CONTAINER redis-cli info server | grep -E "^(redis_version|uptime)"
    else
      echo "✗ Redis is not running"
      exit 1
    fi
    ;;

  logs)
    docker logs -f $REDIS_CONTAINER
    ;;

  cli)
    docker exec -it $REDIS_CONTAINER redis-cli "${@:2}"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs|cli}"
    echo ""
    echo "Commands:"
    echo "  start   - Start Redis container"
    echo "  stop    - Stop and remove Redis container"
    echo "  restart - Restart Redis"
    echo "  status  - Check if Redis is running"
    echo "  logs    - Follow Redis logs"
    echo "  cli     - Open Redis CLI (pass extra args after 'cli')"
    exit 1
    ;;
esac
