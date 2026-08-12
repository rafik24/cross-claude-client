#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-name.mjs — (re)name THIS session on the Cross-Claude bus to host/<slug>.
//
// The join hook gives every session a unique-but-terse default id
// (host/<branch>-<shortid>). This lets a session rename itself after what it is
// actually working on — the session TITLE — so peers can @mention it and the PO
// console reads a meaningful roster instead of a wall of branch names.
//
//   node cc-name.mjs <session_id> "<title / what you're working on>"
//   node cc-name.mjs 3a7f5cfe-... "Improve bus architecture"   ->  host/improve-bus-architecture
//
// It does three things, in order:
//   1. writes ~/.claude/.cc-listen/<session_id>.id  (the map the listen-gate READS —
//      so the gate agrees with your new name automatically, no recompute),
//   2. registers the new id on the bus (upsert),
//   3. prints the exact Monitor(...) line to (re)arm live-receive under the new id.
//
// IMPORTANT: arm cc-poll with the id printed here. If you had already armed a
// Monitor under the old id, STOP it first — the beacon must be written under the
// SAME id the gate now reads, or edits stay blocked.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const sid = a[0];
const title = a.slice(1).filter((x) => !x.startsWith('--')).join(' ').trim();
if (!sid || sid.startsWith('--') || !title) {
  console.error('usage: cc-name.mjs <session_id> "<title / what you are working on>"');
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

// slug: lowercase, non-[a-z0-9._-] -> '-', collapse, trim, cap 48. Matches cc-join.sh's charset.
const slug = (s) => (s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')) || 'misc';
const host = (hostname().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+$/, '')) || 'unknown';
const id = `${host}/${slug(title)}`;

// 1. the session->id map the listen-gate reads (keyed by RAW session id; UUIDs are filename-safe)
const dir = join(homedir(), '.claude', '.cc-listen');
try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, sid + '.id'), id); } catch {}

// 2. register on the bus (fail-soft — never wedge on a transient network blip)
try {
  await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: id, description: title.slice(0, 120) }),
  });
} catch {}

// 3. tell the session how to (re)arm under the new id
const HERE = dirname(fileURLToPath(import.meta.url));
const poll = join(HERE, 'cc-poll.mjs');
const send = join(HERE, 'cc-send.mjs');
console.log(`named on the bus as: ${id}`);
console.log(`ARM (or RE-ARM) live-receive with THIS id — stop any prior Monitor first:`);
console.log(`  Monitor({ command: 'node ${poll} ${id}', description: 'cross-claude bus (${id})', persistent: true })`);
console.log(`From now, send as:  node ${send} ${id} <channel|all> 'message'`);
