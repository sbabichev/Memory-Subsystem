#!/usr/bin/env bash
# =============================================================================
# db-setup.sh — Initialize the database schema on a fresh VPS deployment.
#
# Run this script ONCE after the postgres container is healthy and BEFORE
# starting api-server for the first time.
#
# Usage (from the agent_deploy/ directory):
#   ./scripts/db-setup.sh
#
# Prerequisites:
#   - docker compose services are accessible (postgres must be running)
#   - .env file is present in the agent_deploy/ directory with DATABASE_URL set
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$COMPOSE_DIR"

# ---------------------------------------------------------------------------
# Load .env so POSTGRES_USER / POSTGRES_DB are available in this shell.
# Docker Compose reads .env automatically for container env vars, but the
# host shell needs it too for the pg_isready and psql commands below.
# ---------------------------------------------------------------------------
if [ -f .env ]; then
    set -a
    # shellcheck source=/dev/null
    source .env
    set +a
else
    echo "WARNING: .env file not found in $(pwd). Falling back to defaults."
fi

echo ""
echo "=== Memory System — Database Setup ==="
echo ""

# ---------------------------------------------------------------------------
# Step 1: Wait for postgres to be healthy
# ---------------------------------------------------------------------------
echo "[1/4] Waiting for postgres to be healthy..."

MAX_RETRIES=30
RETRY=0
until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-memory}" -d "${POSTGRES_DB:-memory}" > /dev/null 2>&1; do
    RETRY=$((RETRY + 1))
    if [ "$RETRY" -ge "$MAX_RETRIES" ]; then
        echo "ERROR: postgres did not become ready after ${MAX_RETRIES} attempts. Aborting."
        exit 1
    fi
    echo "  postgres not ready yet (attempt $RETRY/$MAX_RETRIES), retrying in 3s..."
    sleep 3
done

echo "  ✓ postgres is ready."
echo ""

# ---------------------------------------------------------------------------
# Step 2: Enable pgvector extension
# ---------------------------------------------------------------------------
echo "[2/4] Enabling pgvector extension..."

docker compose exec -T postgres psql \
    -U "${POSTGRES_USER:-memory}" \
    -d "${POSTGRES_DB:-memory}" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"

echo "  ✓ pgvector extension enabled."
echo ""

# ---------------------------------------------------------------------------
# Step 3: Apply schema via api-server container
# The setup script handles: table creation, embedding column, HNSW index,
# and tenant backfill — all idempotent and safe to re-run.
# ---------------------------------------------------------------------------
echo "[3/4] Applying database schema (tables, indexes, tenant migration)..."

docker compose exec -T api-server \
    sh -c "cd /app && pnpm --filter @workspace/db run setup"

echo "  ✓ Schema applied."
echo ""

# ---------------------------------------------------------------------------
# Step 4: Verify required tables exist
# ---------------------------------------------------------------------------
echo "[4/4] Verifying required tables..."

REQUIRED_TABLES="tenants raw_items notes entities note_entities note_links entity_relations"
MISSING=""

for table in $REQUIRED_TABLES; do
    EXISTS=$(docker compose exec -T postgres psql \
        -U "${POSTGRES_USER:-memory}" \
        -d "${POSTGRES_DB:-memory}" \
        -tAc "SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = '$table'
        );")
    if [ "$EXISTS" != "t" ]; then
        MISSING="$MISSING $table"
    fi
done

if [ -n "$MISSING" ]; then
    echo "ERROR: The following tables are missing after setup:$MISSING"
    echo "Check the output above for errors and re-run this script."
    exit 1
fi

echo "  ✓ All required tables present."
echo ""
echo "=== Database setup complete. You can now start all services: ==="
echo "    docker compose up -d"
echo ""
