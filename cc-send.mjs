#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-send.mjs — send one message to the Cross-Claude bus. Zero deps.
// Reads ~/.claude/.cross-claude-bus for CC_BASE + CC_TOKEN (override with flags/env).
//
//   node cc-send.mjs <sender_id> <channel|all> "message" [--type status|message|request|response|handoff|done]
//   node cc-send.mjs winbox/reclaim-offline all "rebased onto main abc1234"
//   node cc-send.mjs winbox/reclaim-offline dm-po "your delete change landed"
//
// 'all' is sugar for the #general channel (broadcast). Exit 0 on success, 1 otherwise.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const a = process.argv.slice(2);
const sender = a[0], toArg = a[1];
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const type = opt('--type', 'message');
// body = the first positional after sender+channel that isn't a flag pair
const body = a.slice(2).filter((x, i, arr) => x !== '--type' && arr[i - 1] !== '--type' && !x.startsWith('--')).join(' ');
if (!sender || !toArg || !body) {
  console.error('usage: cc-send.mjs <sender_id> <channel|all> "message" [--type status]');
  process.exit(2);
}
function busCfg() {
  const p = process.env.CC_BUS_CONFIG || join(homedir(), '.claude', '.cross-claude-bus');
  const out = {};
  try { for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
const CFG = busCfg();
const BASE = (opt('--base', process.env.CC_BASE || CFG.CC_BASE || 'http://100.122.172.29:8787')).replace(/\/$/, '');
const TOKEN = opt('--token', process.env.CC_TOKEN || CFG.CC_TOKEN || '');
const channel = toArg === 'all' ? 'general' : toArg;

const r = await fetch(BASE + '/api/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ channel, sender, content: body, message_type: type }),
});
if (!r.ok) { console.error('send failed:', r.status, await r.text().catch(() => '')); process.exit(1); }
const j = await r.json();
console.log(`sent → #${j.channel} as ${sender} [${type}] (id ${j.id})`);
