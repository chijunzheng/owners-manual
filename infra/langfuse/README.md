# Langfuse self-host (local observability)

Self-hosted [Langfuse](https://langfuse.com) v3 for owners-manual. Langfuse is
the **sole system of record** for traces, datasets, scores, and annotation
queues (see [CONTEXT.md](../../CONTEXT.md) → _Evaluation_). Langfuse Cloud is an
env-var fallback via `LANGFUSE_HOST`; nothing else changes when you switch.

This is the Phase-0 stand-up (issue #4): bring the stack up, confirm a healthy
UI, and emit one visible trace from each SDK (TypeScript and Python). The eval
harness and agent wire their real tracing onto this in later issues.

## Prerequisites

- Docker Desktop (or a Docker Engine) running. `docker info` must succeed.
- The repo deps installed: `pnpm install` at the repo root and `uv sync` in
  `evals/`.

## Data location contract (read this first)

This repo lives inside a Google-Drive-synced folder. **Database files must not
sync** — Postgres/ClickHouse corrupt if their data directory is copied out from
under them. So every stateful store bind-mounts its data from an **external**
host directory:

```
LANGFUSE_DATA_ROOT   default: ~/.owners-manual/langfuse-data
```

- Pick any absolute path **outside** the repo and outside any cloud-synced
  folder (Google Drive / Dropbox / OneDrive). Override via `LANGFUSE_DATA_ROOT`
  in `.env`, or leave it unset to use the default.
- Enforcement: the `data-root-guard` service runs before the stores start and
  **aborts `compose up`** if the resolved data root points back inside the repo
  or a known cloud-sync mount. You cannot accidentally persist into the synced
  tree.

Layout under `LANGFUSE_DATA_ROOT`:

```
<LANGFUSE_DATA_ROOT>/
  postgres/      relational data (orgs, projects, datasets, scores)
  clickhouse/    traces + observations (analytics store)
  minio/         S3-compatible blob store (event + media uploads)
  redis/         queue / cache
```

## Environment

Copy the canonical example env to the repo root (it is gitignored — never
commit it). The root `.env.example` is the full project env contract (issue
#6); the Langfuse sections are the ones this stack reads:

```bash
cp .env.example .env
```

Then edit `.env`:

1. Replace every `CHANGEME` secret. Generate `ENCRYPTION_KEY` with
   `openssl rand -hex 32`.
2. Fill in `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` (see _First run_).
3. Optionally set `LANGFUSE_DATA_ROOT` to your chosen external path.

### `LANGFUSE_HOST` contract

| Mode                    | `LANGFUSE_HOST`                  | Notes                                            |
| ----------------------- | -------------------------------- | ------------------------------------------------ |
| Local self-host (default) | `http://localhost:3000`        | The stack in this folder. The default everywhere. |
| Langfuse Cloud (EU)     | `https://cloud.langfuse.com`     | Fallback — no code change, just the env var.      |
| Langfuse Cloud (US)     | `https://us.cloud.langfuse.com`  | US data region.                                   |

Both SDKs read the same three vars: `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`. When `LANGFUSE_HOST` is unset the hello-trace scripts
fall back to `http://localhost:3000`.

## Bring the stack up

```bash
docker compose -f infra/langfuse/docker-compose.yml --env-file .env up -d
```

The first boot pulls images and runs DB migrations, so the web service takes a
minute or two to report healthy. Watch it:

```bash
docker compose -f infra/langfuse/docker-compose.yml ps
```

Wait until `langfuse-web` shows `(healthy)`. To block until then:

```bash
until [ "$(docker inspect -f '{{.State.Health.Status}}' langfuse-langfuse-web-1)" = healthy ]; do
  sleep 5; echo "waiting for langfuse-web…"
done
echo "Langfuse UI is up at http://localhost:3000"
```

### Healthcheck

- **Web** (`langfuse-web`): the UI + ingestion API on host port `3000`. The
  compose healthcheck probes `GET /api/public/health` (via the container
  hostname, because the server binds to the container IP, not loopback). Check
  it from the host:
  ```bash
  curl -s http://localhost:3000/api/public/health
  # {"status":"OK","version":"3.x.y"}
  ```
- **Backing stores** (`postgres`, `clickhouse`, `redis`, `minio`): each has its
  own healthcheck; web and worker `depends_on` all four reporting healthy, so a
  clean `up` already means the stores are good.
- **Worker** (`langfuse-worker`): consumes the ingestion queue; no inbound
  healthcheck (it has no UI). Confirm it is processing via the logs:
  ```bash
  docker compose -f infra/langfuse/docker-compose.yml logs --tail 20 langfuse-worker
  ```

Ports (all bound to `127.0.0.1` except the web UI): web `3000`, worker `3030`,
postgres `5432`, clickhouse `8123`/`9000`, redis `6379`, minio `9090` (S3) /
`9091` (console).

Media uploads use **presigned URLs** that Langfuse hands back to clients running
on the host, so the media-upload endpoint points at the host-published MinIO
address (`http://127.0.0.1:9090`), not the in-network `minio:9000` used for
server-side event uploads. Override `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT` if you
remap that port.

## First run: create a project + API keys

You need a project public/secret key pair for the SDKs. Two options:

- **UI**: open http://localhost:3000, sign up (the first user is the instance
  owner), create an organization + project, then **Settings → API Keys → Create**.
  Copy the `pk-lf-…` / `sk-lf-…` pair into `.env`.
- **Headless bootstrap**: set the `LANGFUSE_INIT_*` vars in `.env` (see the
  example file) before the first `up`. The stack creates the org/project/user
  and the exact key pair you specify, so `.env` is self-consistent with no UI
  step. Match `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `_SECRET_KEY` to
  `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.

## Emit a hello trace from each SDK

With the stack healthy and `.env` populated, first load the keys into your
shell. `.env` is read by Docker Compose (`--env-file`), but the SDK CLIs read
their credentials from the **process environment**, so export the values once
before running either command (run this from the repo root):

```bash
set -a; source .env; set +a   # export LANGFUSE_HOST / _PUBLIC_KEY / _SECRET_KEY
```

```bash
# TypeScript SDK
pnpm --filter @owners-manual/observability run hello-trace

# Python SDK
( cd evals && uv run hello-trace )
```

(`uv run` inherits the exported vars, so the keys carry into the `evals`
subshell. If you start a fresh terminal, re-run the `source` step first.)

Each prints the emitted trace id and a pointer into the UI. Open
http://localhost:3000, go to **Tracing → Traces**, and filter for
`owners-manual.hello-trace.ts` / `owners-manual.hello-trace.py`. Traces ingest
asynchronously through the worker, so allow a few seconds. You can also verify
over the API:

```bash
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "http://localhost:3000/api/public/traces/<trace-id>" | python3 -m json.tool
```

## Stop / reset

```bash
# stop, keep data
docker compose -f infra/langfuse/docker-compose.yml down

# stop and wipe data (host bind mounts → delete the external dir)
docker compose -f infra/langfuse/docker-compose.yml down
rm -rf "${LANGFUSE_DATA_ROOT:-$HOME/.owners-manual/langfuse-data}"
```

## Security notes

- `.env` is gitignored. Secrets are LOCAL-ONLY dev values; rotate every
  `CHANGEME` before exposing the stack beyond `localhost`.
- Only `langfuse-web` (`3000`) is published on all interfaces; every other
  service binds to `127.0.0.1`.
- The repo-root `.env.example` (the full env contract, issue #6) carries
  placeholders only; never commit real keys.
