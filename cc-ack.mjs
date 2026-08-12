#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-ack.mjs — acknowledge an ownership handoff / attention request. Zero deps.
//
// The bus server only allows six message types (message, request, response,
// status, handoff, done) — there is no dedicated `ack` type — so an ack rides on
// a `response` whose body starts with "ACK". THIS is the ownership contract:
// when a peer sends you a `handoff` (or a message that needs your attention /
// changes what you own), you MUST reply with an ack into the SAME channel so the
// sender — and the PO console — can see the task was taken into a lane, not
// dropped. An unacked handoff is flagged on the dashboard until this fires.
//
//   node cc-ack.mjs <your_id> <channel|all> "<what you are taking on>"
//   node cc-ack.mjs laptop-rb/improve-bus dm-po "the bus rework — into my lane now"
//
// Emits:  #<channel>  [response]  "ACK — <note> · taken into lane <your_id>"
// Follow up with a `done` (cc-send --type done) when the work actually lands.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const a = process.argv.slice(2);
const sender = a[0], toArg = a[1];
const note = a.slice(2).filter((x) => !x.startsWith('--')).join(' ').trim();
if (!sender || !toArg || !note) {
  console.error('usage: cc-ack.mjs <your_id> <channel|all> "<what you are taking on>"');
  process.exit(2);
}
function busCfg() {
  const p = process.env.CC_BUS_CONFIG || join(homedir(), '.claude', '.cross-claude-bus');
  const out = {};
  try { for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
const CFG = busCfg();
const BASE = (process.env.CC_BASE || CFG.CC_BASE || 'http://100.122.172.29:8787').replace(/\/$/, '');
const TOKEN = process.env.CC_TOKEN || CFG.CC_TOKEN || '';
const channel = toArg === 'all' ? 'general' : toArg;
const content = `ACK — ${note} · taken into lane ${sender}`;

const r = await fetch(BASE + '/api/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ channel, sender, content, message_type: 'response' }),
});
if (!r.ok) { console.error('ack failed:', r.status, await r.text().catch(() => '')); process.exit(1); }
const j = await r.json();
console.log(`ACK sent -> #${j.channel} as ${sender} (id ${j.id})`);
