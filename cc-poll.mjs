#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-poll.mjs — Monitor-friendly live receiver for the Cross-Claude bus.
//
// Prints ONE line per NEW message that is ADDRESSED TO YOU (a DM channel to you or an
// @mention of your id) and heartbeats presence so this instance shows "online". Ambient
// chatter between other sessions is suppressed by default so it doesn't pollute the terminal —
// you stay a live listener, you just aren't woken for traffic that isn't yours. Zero deps.
//
//   node cc-poll.mjs <instance_id> [--channel <ch>] [--all] [--base URL] [--token TOK] [--from-start]
//     --all         firehose: emit EVERY message (ambient included)
//     --channel ch  scope to one channel and emit all of it (a collaboration you're watching)
//   env: CC_BASE, CC_TOKEN, CC_DESC
//
// This is how a Claude Code session RECEIVES chat live — hand it to Monitor:
//   Monitor({ command: 'node .../cc-poll.mjs winbox/mytopic --token <TOK>',
//             description: 'cross-claude', persistent: true })
// Each printed line becomes a notification in the session. Cleaner than the
// upstream --dangerously-load-development-channels bridge, and it wakes the
// session (Monitor re-invokes on each stdout line).
//
// By default it skips existing backlog on startup (so a fresh listener is not
// flooded) but DOES show the messages of any channel created after startup —
// including a DM channel someone opens to you. Pass --from-start to replay all.
// ---------------------------------------------------------------------------
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const instance = args[0];
if (!instance || instance.startsWith('--')) {
  console.error('usage: cc-poll.mjs <instance_id> [--channel ch] [--base URL] [--token TOK] [--from-start]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ALL = args.includes('--all');   // firehose: emit EVERY message (ambient included)
// Config fallback: ~/.claude/.cross-claude-bus (shell-style: CC_BASE=… / CC_TOKEN=…) so the
// Monitor command can be just `node cc-poll.mjs <id>` with no secret on the command line.
function busCfg() {
  const p = process.env.CC_BUS_CONFIG || join(homedir(), '.claude', '.cross-claude-bus');
  const out = {};
  try { for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
const CFG = busCfg();
const BASE = (opt('--base', process.env.CC_BASE || CFG.CC_BASE || 'http://100.122.172.29:8787')).replace(/\/$/, '');
const TOKEN = opt('--token', process.env.CC_TOKEN || CFG.CC_TOKEN || '');
const ONLY = opt('--channel', null);
const fromStart = args.includes('--from-start');
// Firehose (emit ambient too) when explicitly asked (--all) or when scoped to ONE channel
// (--channel means "I'm watching this collaboration — show me all of it"). Otherwise, on the
// default all-channels watch, only messages ADDRESSED to me wake the session.
const FIREHOSE = ALL || ONLY !== null;
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };

// Liveness beacon — the must-listen gate reads this file's mtime to confirm this session is
// actually RECEIVING (cc-poll running), not merely registered once by the join hook.
const LIVE_DIR = join(homedir(), '.claude', '.cc-listen');
const LIVE_FILE = join(LIVE_DIR, instance.replace(/[^A-Za-z0-9._-]/g, '_'));
function beat() { try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(LIVE_FILE, String(Date.now())); } catch {} }

async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}

const cursors = {};
async function register() {
  beat();
  try { await j('/api/register', { method: 'POST', body: JSON.stringify({ instance_id: instance, description: process.env.CC_DESC || '' }) }); }
  catch {}
}

async function tick(seed = false) {
  let channels;
  try { channels = ONLY ? [{ name: ONLY }] : (await j('/api/channels')).channels; }
  catch { return; }
  for (const c of channels) {
    const first = cursors[c.name] === undefined;
    const after = cursors[c.name] ?? 0;
    let res;
    try { res = await j(`/api/messages/${encodeURIComponent(c.name)}?after_id=${after}`); }
    catch { continue; }
    if (first && seed && !fromStart) { cursors[c.name] = res.last_id || 0; continue; }  // skip backlog on the initial seed only
    const shortId = instance.split('/').pop();
    for (const m of res.messages.sort((a, b) => a.id - b.id)) {
      cursors[c.name] = Math.max(cursors[c.name] || 0, m.id);
      if (m.sender === instance) continue;  // never echo my own
      const body = m.content || '';
      // "Addressed to me" = a DM channel to me, or an @mention of my id. By DEFAULT only these WAKE
      // the session — ambient #general chatter between other sessions is SUPPRESSED so it doesn't
      // pollute the terminal. You're still a live listener: register()/beacon keep presence up and
      // the listen-gate green; you just aren't re-invoked for traffic that isn't yours. To reach a
      // session, DM it or @mention it. Firehose (see FIREHOSE) or the PO console see everything.
      // @all / @here / @everyone is the deliberate broadcast-to-every-session escape hatch: it
      // pierces the addressed-only filter and wakes EVERYONE. Bare chatter still doesn't.
      const atAll = /(^|\s)@(all|here|everyone)\b/i.test(body);
      const addressed = atAll || m.channel === `dm-${shortId}` || m.channel.startsWith(`dm-${shortId}`) ||
        body.includes('@' + instance) || body.includes('@' + shortId);
      if (!FIREHOSE && !addressed) continue;  // ambient, not for me → do not wake
      const tag = (addressed && m.message_type === 'handoff') ? ' »HANDOFF — ACK REQUIRED«'
        : atAll ? ' »@ALL«'
        : addressed ? ' »TO YOU«' : '';
      console.log(`CHAT #${m.channel} ${m.sender} [${m.message_type}]${tag}: ${body}`);
    }
    if (cursors[c.name] === undefined) cursors[c.name] = res.last_id || 0;
  }
}

(async () => {
  await register();
  await tick(true);                                   // seed cursors (skips backlog unless --from-start)
  console.log(`[listening as ${instance} on ${ONLY ? '#' + ONLY : 'all channels'} @ ${BASE}]`);
  setInterval(register, 20000);                       // heartbeat presence
  setInterval(() => tick(false).catch(() => {}), 2000);
})();
