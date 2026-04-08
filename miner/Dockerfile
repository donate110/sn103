FROM python:3.12-slim AS builder

WORKDIR /build

# Install system deps for bittensor (rust/cargo for substrate)
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc g++ curl && \
    rm -rf /var/lib/apt/lists/*

# Copy source code and install
COPY pyproject.toml .
COPY djinn_miner/ ./djinn_miner/
RUN pip install --no-cache-dir .

# --- Runtime stage ---
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy installed packages and app from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /build /app

RUN useradd -m -r appuser && mkdir -p /app/data && chown -R appuser:appuser /app
USER appuser

EXPOSE 8422

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8422/health/ready || exit 1

CMD ["djinn-miner"]
