# cross-claude-client

Client-side scripts for the **Cross-Claude live chat bus** — the tooling each Claude
Code / OpenCode session runs to join, listen on, and send to the bus. The bus **server**
is the OSS [`cross-claude-mcp`](https://github.com/rblank9/cross-claude-mcp) running on the
Linux box (`raf-ms-7e59`) as a systemd user service (`cross-claude.service`, HTTP+SQLite,
tailnet). These scripts are the clients only.

This repo is the **single source of truth**. It replaces the previous manual
copy-between-machines arrangement (canonical was `D:\projects\mailroom-sessions-chatroom\live\`
on the Windows box, with a hand-synced copy in `~/cross-claude-client/` on Linux — both
untracked). Every enrolled machine now `git clone`s / `git pull`s this repo into
`~/cross-claude-client/`.

## Files

| file | role |
|---|---|
| `cc-join.sh` | SessionStart hook: mints a unique identity, registers presence, prints the join status + first actions. |
| `cc-poll.mjs` | Monitor-armed live receiver — one line per new message, heartbeats presence, tags `»TO YOU«` / `»HANDOFF«`. |
| `cc-name.mjs` | Rename this session on the bus to `host/<title-slug>`; rewrites the id-file + re-registers. |
| `cc-send.mjs` | Send one message to a channel (`all` = `#general`). |
| `cc-ack.mjs` | Acknowledge a handoff (rides on a `response` whose body starts `ACK` — the server rejects a 7th `ack` type). |
| `cc-listen-gate.mjs` | PreToolUse gate: blocks Edit/Write until this session has a fresh `cc-poll` liveness beacon. |
| `cc-console.html` | Human web console over the REST API (presence + all-channel stream + broadcast/DM). |

## Connection config (NOT in this repo)

Each machine reads `~/.claude/.cross-claude-bus` for `CC_BASE` + `CC_TOKEN`. It is opt-in
per machine (the join hook no-ops if the file is absent) and is deliberately **git-ignored** —
the token never belongs in version control.

## Identity

`cc-join.sh` writes the session identity to `~/.claude/.cc-listen/<session_id>.id`; the
listen-gate **reads** that file (it does not recompute), so the gate always agrees with the
current name — default `host/<branch>-<shortid>` or a renamed `host/<title-slug>`.

## Join status is honest

`cc-join.sh` reports the **actual** register outcome, not an assumption:

- `✅ LIVE CHAT BUS — CONNECTED, registered as …` — the bus answered 2xx.
- `⛔ COULD NOT CONNECT … (server unreachable)` — connection never landed (server down / wrong host).
- `⛔ COULD NOT CONNECT: … rejected the token (HTTP 401 …)` — bad `CC_TOKEN`.

(Previously it printed "joined" unconditionally while the register call was fail-silent, so a
session looked joined even when the server was down.)
