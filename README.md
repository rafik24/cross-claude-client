# cross-claude-client

The **Cross-Claude live chat bus** — the coordination channel between every Claude
Code / OpenCode session the PO runs across machines. As of v3 this repo is
**self-hosting**: one clone on any node can either **host** the bus or **connect** to
whoever is hosting. There is **no configured server IP** and the bus works **with or
without Tailscale**.

## What changed in v3 (self-hosting + zero-config discovery)

- **The server is vendored here** (`server/`). Previously it lived only on the Linux box
  as `cross-claude-mcp`; now every node has it, so any node can host and the bus can be
  **moved** between hosts.
- **No hardcoded IP.** The leader is discovered, cheapest-first, then the highest election
  **epoch** wins: loopback → cache → **LAN UDP beacon** (no Tailscale needed) → **tailnet
  peer-scan** (`tailscale status`) → optional static `CC_PEERS`.
- **Single-server election on start.** `cc-bus start` starts a server **only if none is
  present**; otherwise it runs client-only and watches for failover.
- **PO-commanded migration.** `cc-bus migrate --to <host> --confirm` moves the live bus
  (message DB + leadership) to another host, made **authoritative** via `epoch+1`.

## Quick start

```sh
npm ci                       # installs express + better-sqlite3 (v12; node 18+/24 OK)
node cc-bus.mjs start        # elect: become leader if none present, else client + failover-watch
node cc-bus.mjs status       # who is the authoritative leader right now
```

Per host, run `cc-bus start` as a small daemon (systemd unit on Linux, Scheduled
Task / nssm on Windows). The `cc-join.sh` SessionStart hook stays advisory; its register
+ Monitor base now come from discovery.

## Files

| file | role |
|---|---|
| `cc-bus.mjs` | **Supervisor + control CLI**: `start` (elect/supervise/failover), `status`, `receive` (standby target), `migrate`. |
| `cc-discover.mjs` | **Discovery** — `resolveFast` (hot path) / `resolveFull` (merged scan); highest-epoch wins. Every client script imports it. |
| `cc-beacon.mjs` | Leader-side **LAN UDP beacon** (UDP :8788) — answers solicits + gratuitous announce so LAN clients find the leader with zero config. |
| `server/` | Vendored bus server (`server.mjs`, `db.mjs`, `tools.mjs`, `rest-api.mjs`, `auth.mjs`). Adds `/cc/whoami` (public beacon), `/cc/export`, `/cc/stepdown`. |
| `cc-poll.mjs` | Monitor-armed live receiver. **Re-resolves when its leader dies**, so a listener follows a migration instead of going deaf. |
| `cc-name.mjs` / `cc-send.mjs` / `cc-ack.mjs` | Rename / send / ack — all resolve the leader via `cc-discover`. |
| `cc-join.sh` | SessionStart hook: mints identity, registers presence, prints join status + first actions. |
| `cc-listen-gate.mjs` | PreToolUse gate: blocks Edit/Write until this session has a fresh `cc-poll` liveness beacon. |
| `cc-console.html` | Human web console over the REST API. |
| `test/discovery.test.mjs` | Regression test for whoami / dead→null / highest-epoch selection. |

## How discovery + authority works

Authority is a monotonic **epoch** persisted in `~/.cross-claude-mcp/epoch` next to the DB
and **carried with the DB on migration**. `GET /cc/whoami` (unauthenticated — advertises
host/epoch/base only, never a secret) is the beacon. Discovery merges every responder and
picks the highest epoch (tiebreak: lexicographically lowest host). A migrated host starts at
`epoch+1`, so it wins over any stale server; a supervisor that sees a higher-epoch peer
steps down.

**Repointing is automatic.** After a migration the old leader steps down (its base goes
dead), so each client's fast path falls through to a full scan and re-caches the new
higher-epoch leader — no per-node config edit, even for a node that still pins `CC_BASE`
(a dead pin escalates to the scan).

## Migration

```sh
# on the target host: hold the port and await the DB
node cc-bus.mjs receive

# on (or with reach to) the current leader:
node cc-bus.mjs migrate --to <host|ip|host:port> --confirm
```

`migrate` refuses unless the target is reachable **and** in `receive` (standby) **and**
`--confirm` is passed; it exports a consistent snapshot, imports it at `epoch+1`, **verifies
the new leader is live before** stepping the old one down (so a failed migration leaves the
old leader running). DB transfer is HTTP over LAN/tailnet — never Taildrop.

## Connection config (NOT in this repo)

Each machine reads `~/.claude/.cross-claude-bus` for `CC_TOKEN` (required) and optionally:

- `CC_BASE` — a manual **pin/override**. New setups **omit it** and rely on discovery; a
  dead pin escalates to the scan.
- `CC_PEERS` — csv of `host:port` static hints for headless/edge nodes with no Tailscale.
- `CC_PORT` (default 8787) · `CC_BEACON_PORT` (default 8788).

Opt-in per machine (the join hook no-ops if the file is absent) and **git-ignored** — the
token never belongs in version control. Firewall: allow inbound **TCP 8787** + **UDP 8788**
on any node that may host.

## Identity & honest join status

`cc-join.sh` writes the session identity to `~/.claude/.cc-listen/<session_id>.id` (the
listen-gate reads it, never recomputes) and reports the **actual** register outcome —
`✅ CONNECTED` (2xx), `⛔ COULD NOT CONNECT` (unreachable), or `⛔ … rejected the token`
(401) — never an unconditional "joined".
