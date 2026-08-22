#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-bus.mjs — Cross-Claude bus supervisor + control CLI.
//
//   cc-bus start                     Elect: if a bus is already present anywhere
//                                     (loopback / LAN / tailnet) → run CLIENT-ONLY
//                                     (start no server). If none → become LEADER
//                                     (start the server at epoch+1 + LAN beacon).
//                                     Stays up; fails over if the leader vanishes.
//   cc-bus status                    Print the discovered authoritative leader.
//   cc-bus receive [--port N]        STANDBY on a migration target: hold the port,
//                                     accept one /cc/import, then promote to leader.
//   cc-bus migrate --to <host> --confirm
//                                     Move the live bus to <host> (must be in
//                                     `receive`). Exports the DB, starts the target
//                                     at epoch+1 (authoritative), verifies it, THEN
//                                     steps the old leader down.
//
// One clone of this repo on any node can host the bus or connect to whoever hosts.
// Config (token, optional pin/peers) comes from ~/.claude/.cross-claude-bus.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  loadConfig, resolveFull, whoami, cacheLeader, DEFAULT_PORT,
} from './cc-discover.mjs';
import { startBeacon } from './cc-beacon.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'server', 'server.mjs');
const HOST = process.env.CC_HOST || hostname();
const DATA_DIR = process.env.CC_DATA_DIR || join(homedir(), '.cross-claude-mcp');
const EPOCH_FILE = join(DATA_DIR, 'epoch');
const DB_FILE = join(DATA_DIR, 'messages.db');

// --- epoch sidecar (travels with the DB; monotonic authority) ---
function readEpoch() {
  try { return parseInt(readFileSync(EPOCH_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeEpoch(n) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(EPOCH_FILE, String(n));
}

const log = (...a) => console.log(`[cc-bus ${HOST}]`, ...a);

// --- spawn the vendored server as leader at a given epoch ---
function spawnLeader(epoch, port, token) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      MCP_API_KEY: token || process.env.MCP_API_KEY || '',
      CC_EPOCH: String(epoch),
      CC_HOST: HOST,
      CC_DATA_DIR: DATA_DIR,
    },
    stdio: 'inherit',
  });
  return child;
}

// wait until base answers /cc/whoami with predicate(w) true, or timeout
async function waitFor(base, predicate, timeoutMs = 20000, everyMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = await whoami(base, 1200);
    if (w && predicate(w)) return w;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

// ===========================================================================
// cc-bus start — election + supervise + failover
// ===========================================================================
async function cmdStart() {
  const cfg = loadConfig();
  const port = cfg.port;
  const token = cfg.token;

  let child = null;
  let stopBeacon = null;
  let steppingDown = false;
  let role = null;
  let monitorIv = null;

  const STEPDOWN_MARKER = join(DATA_DIR, '.stepdown');

  async function becomeLeader() {
    try { rmSync(STEPDOWN_MARKER); } catch {}   // clear any stale marker before we lead
    const epoch = readEpoch() + 1;      // strictly higher than the last term this DB served
    writeEpoch(epoch);
    role = 'leader';
    log(`no bus present → becoming LEADER at epoch ${epoch} (port ${port})`);
    child = spawnLeader(epoch, port, token);
    stopBeacon = startBeacon({ host: HOST, epoch, port, beaconPort: cfg.beaconPort });

    child.on('exit', (code) => {
      if (stopBeacon) { stopBeacon(); stopBeacon = null; }
      if (monitorIv) { clearInterval(monitorIv); monitorIv = null; }
      // An intentional stepdown (local flag OR the server's marker written by /cc/stepdown)
      // means "become CLIENT" — NOT re-elect. Re-electing on stepdown was the migration flap:
      // the old leader would re-take the term at an epoch TIE with the freshly-migrated host.
      const wasStepdown = steppingDown || existsSync(STEPDOWN_MARKER);
      try { if (existsSync(STEPDOWN_MARKER)) rmSync(STEPDOWN_MARKER); } catch {}
      if (wasStepdown) { log('stepped down → switching to CLIENT'); steppingDown = false; role = null; runClient(); return; }
      log(`server exited (code ${code}) → re-electing in 1s`);
      role = null;
      setTimeout(electAndRun, 1000);
    });

    // Continuous leadership monitor: while we lead, keep scanning for a peer that OUTRANKS us
    // (higher epoch, or equal epoch + lexicographically-lower host) and step down to it. A
    // repeating check (not the old one-shot) so any tie/race self-corrects within seconds to
    // the single deterministic winner.
    monitorIv = setInterval(async () => {
      if (role !== 'leader') { clearInterval(monitorIv); monitorIv = null; return; }
      const peer = await resolveFull({ token, skipLoopback: true, skipSelf: true });
      if (peer && (peer.epoch > epoch || (peer.epoch === epoch && String(peer.host).localeCompare(HOST) < 0))) {
        log(`peer ${peer.host} epoch ${peer.epoch} outranks me (I am ${HOST} epoch ${epoch}) → stepping down to CLIENT`);
        clearInterval(monitorIv); monitorIv = null;
        steppingDown = true;
        try { await fetch(`http://127.0.0.1:${port}/cc/stepdown`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch { try { child.kill(); } catch {} }
      }
    }, 5000);
  }

  function runClient() {
    role = 'client';
    log('CLIENT mode — a bus is already present; not starting a server. Watching for failover.');
    // Periodic failover check: if the leader vanishes, take over.
    const iv = setInterval(async () => {
      if (role !== 'client') { clearInterval(iv); return; }
      const leader = await resolveFull({ token });
      if (!leader) {
        clearInterval(iv);
        // ⚠️ Finding 3 (not yet fixed): auto-failover promotes THIS node on its own local
        // messages.db. A pure client never syncs the leader's DB, so any messages written to
        // the vanished leader since this node last held/synced the DB are ABSENT — and per-DB
        // AUTOINCREMENT ids will fork. Surfaced loudly rather than lost silently; the durable
        // fix (snapshot replication or global message ids) needs multi-node QA.
        log('leader vanished → re-electing. ⚠️ auto-failover promotes on this node\'s LOCAL DB — messages sent to the vanished leader since this node last synced are NOT present (no replication yet).');
        electAndRun();
      } else cacheLeader(leader);
    }, 15000);
  }

  async function electAndRun() {
    const leader = await resolveFull({ token });   // any live bus, incl. this box's loopback
    if (leader) {
      cacheLeader(leader);
      if (leader.host === HOST && /127\.0\.0\.1|localhost/.test(leader.base)) {
        // A server is already running on THIS host (previous cc-bus). Don't double-start.
        log(`a server is already running here (epoch ${leader.epoch}) → CLIENT mode`);
      } else {
        log(`bus present: leader ${leader.host} epoch ${leader.epoch} @ ${leader.base}`);
      }
      runClient();
    } else {
      await becomeLeader();
    }
  }

  process.on('SIGINT', () => { steppingDown = true; try { child?.kill(); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { steppingDown = true; try { child?.kill(); } catch {} process.exit(0); });

  await electAndRun();
}

// ===========================================================================
// cc-bus status
// ===========================================================================
async function cmdStatus() {
  const cfg = loadConfig();
  const leader = await resolveFull({ token: cfg.token });
  if (leader) {
    console.log(`LEADER: ${leader.host}  epoch=${leader.epoch}  base=${leader.base}`);
  } else {
    console.log('no bus leader found (loopback / LAN / tailnet all silent)');
    process.exitCode = 1;
  }
}

// ===========================================================================
// cc-bus receive — standby on a migration target
// ===========================================================================
async function cmdReceive(args) {
  const cfg = loadConfig();
  const port = parseInt(argOf(args, '--port')) || cfg.port;
  const token = cfg.token;
  const standbyEpoch = readEpoch();

  // Refuse if a bus is already leading on this port (don't clobber a live host).
  const existing = await whoami(`http://127.0.0.1:${port}`, 1000);
  if (existing && existing.role === 'leader') {
    console.error(`refusing: a leader (epoch ${existing.epoch}) is already running on :${port} here`);
    process.exit(1);
  }

  log(`STANDBY on :${port} (epoch ${standbyEpoch}) — awaiting /cc/import. Ctrl-C to cancel.`);

  const srv = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/cc/whoami') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ role: 'standby', host: HOST, epoch: standbyEpoch, port }));
      return;
    }
    if (req.method === 'POST' && req.url === '/cc/import') {
      const auth = req.headers['authorization'] || '';
      if (token && auth !== 'Bearer ' + token) { res.statusCode = 401; res.end('unauthorized'); return; }
      const newEpoch = parseInt(req.headers['x-cc-epoch']) || (standbyEpoch + 1);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          mkdirSync(DATA_DIR, { recursive: true });
          // Clear any stale WAL/SHM so the imported image is authoritative.
          for (const suf of ['', '-wal', '-shm']) { try { rmSync(DB_FILE + suf); } catch {} }
          writeFileSync(DB_FILE, buf);
          writeEpoch(newEpoch);
          res.setHeader('content-type', 'application/json');
          res.setHeader('connection', 'close');   // no keep-alive → the bootstrap can free :8787 at once
          res.end(JSON.stringify({ ok: true, host: HOST, epoch: newEpoch, bytes: buf.length }));
          log(`imported ${buf.length} bytes → promoting to LEADER at epoch ${newEpoch}`);

          // Hand the port from the bootstrap listener to the full server. srv.close() only
          // fires once every connection is gone, and the migrate client's keep-alive socket
          // would otherwise hold it open — so force-drop lingering sockets first, THEN spawn
          // the full server in the close callback (guaranteeing :8787 is actually free, no
          // EADDRINUSE). A one-shot guard prevents a double-spawn.
          let promoted = false;
          const promote = () => {
            if (promoted) return; promoted = true;
            const child = spawnLeader(newEpoch, port, token);
            const stop = startBeacon({ host: HOST, epoch: newEpoch, port, beaconPort: cfg.beaconPort });
            child.on('exit', (code) => {
              stop();
              // A migrate-promoted leader must NOT just die on its server's exit — that left the
              // 2026-08 "zombie"/no-failover gap (review Findings 1 & 5). Re-join via `cc-bus start`
              // so the node re-elects (leader if truly alone) or drops to CLIENT (if the server
              // self-demoted to a higher-epoch peer — the .stepdown marker path). This gives a
              // migrate-born leader the same resilience as a `start`-elected one.
              log(`server exited (code ${code}) — re-joining the bus via 'cc-bus start'`);
              try {
                spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], { detached: true, stdio: 'ignore' }).unref();
              } catch {}
              process.exit(code || 0);
            });
          };
          try { srv.closeAllConnections?.(); } catch {}
          srv.close(promote);
          // last-resort net in case the close callback never fires (should not happen once
          // connections are force-dropped); long enough that the normal close path always wins.
          setTimeout(promote, 8000);
        } catch (e) {
          res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  srv.listen(port, '0.0.0.0');
}

// ===========================================================================
// cc-bus migrate --to <host> --confirm
// ===========================================================================
async function cmdMigrate(args) {
  const cfg = loadConfig();
  const token = cfg.token;
  const port = cfg.port;
  const to = argOf(args, '--to');
  const confirm = args.includes('--confirm');
  if (!to) { console.error('usage: cc-bus migrate --to <host|ip|host:port> --confirm'); process.exit(2); }

  // 1. current leader to export FROM
  const leader = await resolveFull({ token });
  if (!leader) { console.error('abort: no current bus leader found to migrate from'); process.exit(1); }
  log(`current leader: ${leader.host} epoch=${leader.epoch} @ ${leader.base}`);

  // 2. resolve target address
  const targetBase = await resolveTarget(to, port);
  if (!targetBase) { console.error(`abort: cannot resolve target "${to}" to an address (try --to <ip>:${port} or add CC_PEERS)`); process.exit(1); }

  // 3. precheck: target must be a standby, and --confirm required
  const tw = await whoami(targetBase, 3000);
  if (!tw) { console.error(`abort: target ${targetBase} is not answering. Run \`cc-bus receive\` on ${to} first.`); process.exit(1); }
  if (tw.role !== 'standby') { console.error(`abort: target ${targetBase} is role="${tw.role}", expected "standby". Run \`cc-bus receive\` on ${to}.`); process.exit(1); }
  if (!confirm) {
    console.error(`\nAbout to MIGRATE the live bus:\n  from  ${leader.host}  epoch ${leader.epoch}  ${leader.base}\n  to    ${tw.host}  ${targetBase}  (new epoch ${leader.epoch + 1})\nThis moves the message DB and steps the old leader down.\nRe-run with --confirm to proceed.`);
    process.exit(1);
  }

  const newEpoch = leader.epoch + 1;

  // 4. export consistent snapshot from current leader
  log('exporting DB snapshot from current leader…');
  const exp = await fetch(leader.base + '/cc/export', { headers: { Authorization: 'Bearer ' + token } });
  if (!exp.ok) { console.error(`abort: export failed ${exp.status} ${await exp.text().catch(() => '')}`); process.exit(1); }
  const dbBytes = Buffer.from(await exp.arrayBuffer());
  log(`snapshot ${dbBytes.length} bytes`);

  // 5. push to target /cc/import with the new epoch
  log(`importing into ${tw.host} at epoch ${newEpoch}…`);
  const imp = await fetch(targetBase + '/cc/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream', 'x-cc-epoch': String(newEpoch) },
    body: dbBytes,
  });
  if (!imp.ok) { console.error(`abort: import failed ${imp.status} ${await imp.text().catch(() => '')}`); process.exit(1); }

  // 6. verify target promoted to leader@newEpoch BEFORE stepping the old one down
  log('verifying new leader…');
  const promoted = await waitFor(targetBase, (w) => w.role === 'leader' && w.epoch === newEpoch, 60000);
  if (!promoted) { console.error('abort: target did not promote to leader in time — OLD LEADER LEFT RUNNING (safe). Investigate before retrying.'); process.exit(1); }
  log(`✅ new leader live: ${promoted.host} epoch=${promoted.epoch} @ ${targetBase}`);

  // 7. step the old leader down (only now that the new one is confirmed)
  log('stepping old leader down…');
  try {
    await fetch(leader.base + '/cc/stepdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  } catch (e) { log(`warning: stepdown call errored (${e.message}); the new higher-epoch leader wins regardless`); }

  cacheLeader(promoted);

  // 8. announce on the bus
  try {
    await fetch(targetBase + '/api/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'general', sender: `cc-bus/${HOST}`, message_type: 'status', content: `@all bus MIGRATED: leader is now ${promoted.host} (epoch ${newEpoch}) @ ${targetBase}. Old leader ${leader.host} stepped down. Re-discovery is automatic.` }),
    });
  } catch {}

  log(`done. Bus now led by ${promoted.host} at epoch ${newEpoch}.`);
}

// --- resolve a --to target to a base URL ---
async function resolveTarget(to, port) {
  // ip:port or host:port
  if (/^https?:\/\//.test(to)) return to.replace(/\/$/, '');
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(to)) return `http://${to.includes(':') ? to : to + ':' + port}`;
  if (to.includes(':')) return `http://${to}`;                 // host:port
  // bare hostname → try tailscale map first
  const ip = await tailscaleIpForHost(to);
  if (ip) return `http://${ip}:${port}`;
  // fall back to static peers whose host matches
  const cfg = loadConfig();
  for (const p of cfg.peers) {
    const h = p.split(':')[0];
    if (h.toLowerCase() === to.toLowerCase()) return `http://${p.includes(':') ? p : p + ':' + port}`;
  }
  // last resort: DNS/MagicDNS name as-is
  return `http://${to}:${port}`;
}

function tailscaleIpForHost(host) {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 2500 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const nodes = [j.Self, ...Object.values(j.Peer || {})];
        for (const n of nodes) {
          if (n && String(n.HostName).toLowerCase() === host.toLowerCase()) {
            const ip = (n.TailscaleIPs || []).find((x) => x.includes('.'));
            return resolve(ip || null);
          }
        }
        resolve(null);
      } catch { resolve(null); }
    });
  });
}

function argOf(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

// --- main ---
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'start': await cmdStart(); break;
  case 'status': await cmdStatus(); break;
  case 'receive': await cmdReceive(rest); break;
  case 'migrate': await cmdMigrate(rest); break;
  default:
    console.log('usage: cc-bus <start|status|receive|migrate>\n' +
      '  start                        elect + supervise (leader if none present, else client)\n' +
      '  status                       print the current authoritative leader\n' +
      '  receive [--port N]           standby on a migration target\n' +
      '  migrate --to <host> --confirm  move the live bus to <host>');
    process.exit(cmd ? 1 : 0);
}
