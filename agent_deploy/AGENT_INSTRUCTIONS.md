# Memory System — VPS Deployment Instructions for AI Agents

These instructions are written for an AI agent (or a human) performing a fresh deployment of the Memory System on a VPS. Follow each step in order. Do not skip steps.

---

## 1. Server Requirements

| Requirement | Minimum |
|---|---|
| OS | Ubuntu 22.04 LTS or newer (Debian 12+ also works) |
| Docker | 24.0+ |
| Docker Compose plugin | v2 (`docker compose` — note: no hyphen) |
| RAM | 2 GB (4 GB recommended) |
| Disk | 10 GB free |
| Open port | TCP 80 (HTTP) |

Verify Docker Compose v2 is available:
```bash
docker compose version
# Expected: Docker Compose version v2.x.x
```

If you only have `docker-compose` (v1, with a hyphen), install the v2 plugin:
```bash
apt-get install -y docker-compose-plugin
```

---

## 2. Obtain API Keys

You need two external API keys before proceeding.

### Voyage AI (embeddings)
1. Sign up at https://dash.voyageai.com/
2. Create an API key in the dashboard.
3. Note the key — you will set it as `VOYAGE_API_KEY`.

### Google Gemini (entity extraction)
1. Go to https://aistudio.google.com/app/apikey
2. Create a new API key.
3. Note the key — you will set it as `GEMINI_API_KEY`.

---

## 3. Clone the Repository

```bash
git clone <your-repository-url> memory-system
cd memory-system
```

Replace `<your-repository-url>` with the actual Git URL.

---

## 4. Create the `.env` File

```bash
cd agent_deploy
cp .env.example .env
```

Edit `.env` with your actual values:

```bash
nano .env   # or use any editor
```

**Required fields to update:**

| Variable | What to set |
|---|---|
| `POSTGRES_USER` | Any username, e.g. `memory` |
| `POSTGRES_PASSWORD` | A strong random password |
| `POSTGRES_DB` | Database name, e.g. `memory` |
| `DATABASE_URL` | Must match the three fields above: `postgresql://POSTGRES_USER:POSTGRES_PASSWORD@postgres:5432/POSTGRES_DB` |
| `MEMORY_API_KEY` | A long random secret — this is the Bearer token clients use |
| `VITE_MEMORY_API_KEY` | Same value as `MEMORY_API_KEY` (embedded into the Inspector UI at build time) |
| `VOYAGE_API_KEY` | Key from Step 2 |
| `GEMINI_API_KEY` | Key from Step 2 |

Optional:
- `MEMORY_API_KEYS` — set this instead of (or in addition to) `MEMORY_API_KEY` for multi-tenant setups. Format: `{"key-one":"tenant-a","key-two":"tenant-b"}`

Leave `NODE_ENV=production`, `PORT=3001`, `BASE_PATH=/` unchanged unless you know what you are doing.

Generate a strong random key:
```bash
openssl rand -hex 32
```

---

## 5. Build Docker Images

Run this from the `agent_deploy/` directory:

```bash
docker compose build
```

This will take several minutes on first run (downloading base images, installing pnpm dependencies, compiling TypeScript).

Expected output ends with:
```
[+] Building ... (done)
```

If the build fails, check:
- Network connectivity (pnpm needs to download packages)
- That `pnpm-lock.yaml` is committed and up to date in the repository

---

## 6. Start PostgreSQL and Initialize the Database

### 6a. Start only the postgres service first

```bash
docker compose up -d postgres
```

Wait for it to become healthy (usually 5–10 seconds):

```bash
docker compose ps postgres
# Status should show: healthy
```

### 6b. Enable the pgvector extension

```bash
docker compose exec postgres psql \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Expected output:
```
CREATE EXTENSION
```

If you see `ERROR: could not open extension control file ... vector.control`:
- The `pgvector/pgvector:pg17` image includes pgvector. If this error appears, the image may not have pulled correctly. Run `docker compose pull postgres` and try again.

### 6c. Start the api-server (needed to run the setup script)

```bash
docker compose up -d api-server
```

Wait 10 seconds for it to start, then check logs:
```bash
docker compose logs api-server
```

You will see an error like `Database schema is incomplete` — this is expected before the schema is applied.

### 6d. Apply the database schema

```bash
chmod +x scripts/db-setup.sh
./scripts/db-setup.sh
```

This script:
1. Waits for postgres to be ready
2. Enables pgvector extension (idempotent)
3. Runs `pnpm --filter @workspace/db run setup` inside the api-server container, which creates all tables, adds the embedding vector column, creates the HNSW index, and runs tenant migrations
4. Verifies all required tables exist

Expected final output:
```
=== Database setup complete. You can now start all services: ===
    docker compose up -d
```

---

## 7. Start All Services

```bash
docker compose up -d
```

This starts: postgres, api-server, inspector (UI), nginx.

Check all containers are running:
```bash
docker compose ps
```

All four services should show `Up` or `healthy` status.

---

## 8. Verify the Deployment

### Health check
```bash
curl http://localhost/api/healthz
```

Expected response: `{"status":"ok"}` (or similar JSON — any 200 response means the API is up)

### Open the Inspector UI
Visit `http://<your-server-ip>/` in a browser.

The Memory Inspector should load and be able to connect to the API.

### Check logs if something is wrong
```bash
docker compose logs --tail=50 api-server
docker compose logs --tail=50 nginx
docker compose logs --tail=50 postgres
```

---

## 9. Common Errors and Solutions

### `VOYAGE_API_KEY environment variable is not set`
The api-server checks for this key at runtime when processing embedding requests. Make sure `VOYAGE_API_KEY` is set in `.env` and that you ran `docker compose up -d` (not just `docker compose build`).

### `Database schema is incomplete — required tables are missing`
The api-server refuses to start if the schema is not applied. Run Step 6d (`./scripts/db-setup.sh`) and restart: `docker compose restart api-server`.

### `Neither MEMORY_API_KEYS nor MEMORY_API_KEY environment variable is set. Refusing to start.`
Set `MEMORY_API_KEY` in `.env`. The server will not start without at least one API key configured.

### `Could not open extension control file ... vector.control: No such file or directory`
pgvector is not installed in the postgres container. Make sure you are using the `pgvector/pgvector:pg17` image (set in `docker-compose.yml`). Run `docker compose pull postgres` and `docker compose up -d postgres`.

### Port 80 is already in use
Another process (e.g. Apache, another nginx) is listening on port 80. Stop it first:
```bash
sudo systemctl stop apache2    # or nginx, caddy, etc.
docker compose up -d
```

Alternatively, change the nginx port mapping in `docker-compose.yml`:
```yaml
ports:
  - "8080:80"   # expose on 8080 instead
```

### `pnpm install --frozen-lockfile` fails during build
The `pnpm-lock.yaml` file is out of sync with `package.json`. On your development machine, run `pnpm install` to update the lockfile, commit it, and push. Then re-pull on the VPS and rebuild.

### Inspector UI shows "Failed to fetch" or API errors
Make sure `VITE_MEMORY_API_KEY` in `.env` matches a valid `MEMORY_API_KEY` or entry in `MEMORY_API_KEYS`. Rebuild after changing build-time variables:
```bash
docker compose build inspector
docker compose up -d inspector
```

---

## 10. SSL/TLS (Optional — Not Configured Here)

The setup above serves HTTP on port 80. To add HTTPS:

**Option A — Caddy (simplest):**
```bash
apt-get install -y caddy
```
Create `/etc/caddy/Caddyfile`:
```
yourdomain.com {
    reverse_proxy localhost:80
}
```
```bash
systemctl enable --now caddy
```

**Option B — Certbot + nginx on the host:**
```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```
Then configure nginx on the host to proxy to port 80 of this Docker stack and handle SSL termination.

---

## 11. Useful Maintenance Commands

```bash
# View real-time logs
docker compose logs -f

# Restart a single service
docker compose restart api-server

# Stop everything
docker compose down

# Stop everything and delete the database volume (DESTRUCTIVE)
docker compose down -v

# Rebuild after code changes
docker compose build
docker compose up -d

# Run a database query manually
docker compose exec postgres psql -U memory -d memory -c "SELECT count(*) FROM notes;"
```
