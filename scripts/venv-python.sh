#!/bin/bash
# Wrapper script to run Python with the djinn-miner venv
# This ensures PM2 uses the correct Python environment

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/../miner/.venv"
ENV_FILE="$SCRIPT_DIR/../miner/.env"

# Load environment from .env file, but DON'T override existing vars (PM2 sets those)
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        # Remove quotes from value
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        # Only export if not already set (PM2 env takes precedence)
        if [[ -z "${!key}" ]]; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Run the command
exec python "$@"
