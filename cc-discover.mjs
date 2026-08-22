// ---------------------------------------------------------------------------
// cc-discover.mjs — zero-config discovery of the authoritative Cross-Claude bus.
//
// No IP is configured in the default path. The leader is found by probing, in
// order, cheapest-first, then MERGING every responder and picking the HIGHEST
// election epoch (tiebreak: lexicographically lowest host id). Works LAN-only
// (UDP broadcast beacon, no Tailscale needed), tailnet-only (peer scan), or mixed.
//
//   loadConfig()                      → { token, pin, peers[], port, beaconPort }
//   resolveFast({token,pin})          → {base,host,epoch} | null   (pin→cache→loopback; hot path)
//   resolveFull({token,pin,skipSelf}) → {base,host,epoch} | null   (full merged scan; election/migrate)
//   cacheLeader(leader) / readCache()
//   whoami(base, timeoutMs, token)    → {role,host,epoch,base_url} | null
//
// Every client script imports resolveFast(); cc-bus imports resolveFull().
// Zero external deps.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';

export const DEFAULT_PORT = 8787;
export const DEFAULT_BEACON_PORT = 8788;

const CACHE_DIR = join(homedir(), '.claude', '.cc-listen');
const CACHE_FILE = join(CACHE_DIR, 'leader.json');

// --- config (shell-style ~/.claude/.cross-claude-bus) ---
export function loadConfig() {
  const p = process.env.CC_BUS_CONFIG || join(homedir(), '.claude', '.cross-claude-bus');
  const out = {};
  try {
    for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  const token = process.env.CC_TOKEN || out.CC_TOKEN || '';
  // CC_BASE is a manual PIN/override (back-compat). New configs omit it and rely on discovery.
  const pin = (process.env.CC_BASE || out.CC_BASE || '').replace(/\/$/, '') || null;
  const port = parseInt(process.env.CC_PORT || out.CC_PORT) || DEFAULT_PORT;
  const beaconPort = parseInt(process.env.CC_BEACON_PORT || out.CC_BEACON_PORT) || DEFAULT_BEACON_PORT;
  const peers = (process.env.CC_PEERS || out.CC_PEERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { token, pin, port, beaconPort, peers };
}

// --- cache ---
export function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}
export function cacheLeader(leader) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ...leader, ts: Date.now() }));
  } catch {}
}

// --- one whoami probe ---
export async function whoami(base, timeoutMs = 1500) {
  base = base.replace(/\/$/, '');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/cc/whoami', { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j.epoch !== 'number') return null;
    // Canonical base = the address WE dialed (guaranteed reachable from here), not what the
    // server guesses. host/epoch come from the server.
    return { base, host: j.host, epoch: j.epoch, role: j.role || 'leader' };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// pick highest epoch; tiebreak lexicographically lowest host id (deterministic).
function pickAuthoritative(responders) {
  const live = responders.filter(Boolean);
  if (!live.length) return null;
  live.sort((a, b) => (b.epoch - a.epoch) || String(a.host).localeCompare(String(b.host)));
  return live[0];
}

// --- LAN UDP solicit: broadcast "who's the leader?", collect unicast announces ---
function lanSolicit(beaconPort, timeoutMs = 400) {
  return new Promise((resolve) => {
    const found = [];
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve(found); }
    const done = () => { try { sock.close(); } catch {} resolve(found); };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString());
        if (m && m.t === 'announce' && typeof m.epoch === 'number') {
          found.push({ ip: rinfo.address, port: m.port || DEFAULT_PORT, host: m.host, epoch: m.epoch });
        }
      } catch {}
    });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      const payload = Buffer.from(JSON.stringify({ t: 'solicit', v: 1 }));
      // Send to the global broadcast plus each interface's directed broadcast (some
      // networks drop 255.255.255.255 but pass the subnet broadcast).
      const targets = new Set(['255.255.255.255']);
      for (const list of Object.values(networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family !== 'IPv4' || ni.internal) continue;
          const b = directedBroadcast(ni.address, ni.netmask);
          if (b) targets.add(b);
        }
      }
      for (const ip of targets) { try { sock.send(payload, beaconPort, ip); } catch {} }
      setTimeout(done, timeoutMs);
    });
  });
}

function directedBroadcast(addr, mask) {
  try {
    const a = addr.split('.').map(Number), m = mask.split('.').map(Number);
    if (a.length !== 4 || m.length !== 4) return null;
    return a.map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.');
  } catch { return null; }
}

// --- Tailnet: enumerate online peers via `tailscale status --json` ---
function tailscalePeers() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 2500 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(stdout);
        const ips = [];
        const take = (node) => {
          if (!node) return;
          const ip = (node.TailscaleIPs || []).find((x) => x.includes('.'));
          if (ip) ips.push(ip);
        };
        take(j.Self);
        for (const k of Object.keys(j.Peer || {})) {
          const p = j.Peer[k];
          if (p && p.Online) take(p);
        }
        resolve(ips);
      } catch { resolve([]); }
    });
  });
}

// --- fast path: pin → cache → loopback, HIGHEST epoch among live responders. Hot client path. ---
export async function resolveFast(opts = {}) {
  const cfg = loadConfig();
  const pin = opts.pin ?? cfg.pin;
  const port = cfg.port;
  const tryBases = [];
  if (pin) tryBases.push(pin);
  const cached = readCache();
  if (cached?.base) tryBases.push(cached.base);
  tryBases.push(`http://127.0.0.1:${port}`);
  // Probe ALL candidates (≤3) and pick the HIGHEST epoch — NOT the first responder. A
  // stale/demoted loopback or a warm cache entry must never win over a live higher-epoch
  // leader (that bug let a superseded loopback "zombie" leader keep co-located clients
  // bound to it forever). pickAuthoritative applies the epoch>tiebreak ordering.
  const responders = await Promise.all(tryBases.map((b) => whoami(b, opts.timeoutMs || 1200)));
  const best = pickAuthoritative(responders);
  if (best) { cacheLeader(best); return best; }
  // Fast path missed → escalate to a full scan (also follows a migration).
  return resolveFull({ ...opts, pin });
}

// --- full merged scan: every substrate, highest epoch wins. Election/migrate path. ---
export async function resolveFull(opts = {}) {
  const cfg = loadConfig();
  const pin = opts.pin ?? cfg.pin;
  const port = cfg.port;
  const selfHost = (process.env.CC_HOST || hostname());

  const bases = new Set();
  if (pin) bases.add(pin.replace(/\/$/, ''));
  const cached = readCache();
  if (cached?.base) bases.add(cached.base.replace(/\/$/, ''));
  if (!opts.skipLoopback) bases.add(`http://127.0.0.1:${port}`);
  for (const p of cfg.peers) {
    bases.add(/^https?:\/\//.test(p) ? p.replace(/\/$/, '') : `http://${p.includes(':') ? p : p + ':' + port}`);
  }

  // LAN + tailnet in parallel
  const [lan, ts] = await Promise.all([
    lanSolicit(cfg.beaconPort, opts.lanTimeoutMs || 400),
    tailscalePeers(),
  ]);
  for (const r of lan) bases.add(`http://${r.ip}:${r.port}`);
  for (const ip of ts) bases.add(`http://${ip}:${port}`);

  const responders = await Promise.all([...bases].map((b) => whoami(b, opts.timeoutMs || 1500)));
  let best = pickAuthoritative(responders);
  // Optionally ignore a leader that is THIS node (election needs "is anyone ELSE leading?").
  if (best && opts.skipSelf && best.host === selfHost && isLoopbackOrSelf(best.base)) {
    const others = pickAuthoritative(responders.filter((r) => r && r.base !== best.base));
    best = others;
  }
  if (best) cacheLeader(best);
  return best;
}

function isLoopbackOrSelf(base) {
  return /127\.0\.0\.1|localhost/.test(base);
}
