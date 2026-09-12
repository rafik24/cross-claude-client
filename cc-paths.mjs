// ---------------------------------------------------------------------------
// cc-paths.mjs — single source of truth for the on-disk locations, with a SAFE
// one-time migration from the pre-rename names.
//
// Rename (branding → "Crosstalk", and dropping the stale "-mcp" from when MCP was a thing):
//   config file : ~/.claude/.cross-claude-bus   →  ~/.claude/.crosstalk
//   data dir    : ~/.cross-claude-mcp           →  ~/.crosstalk   (messages.db, epoch, supervisor.json)
//
// Migration is BACK-COMPAT and never destructive:
//   - env override (CC_DATA_DIR / CC_BUS_CONFIG) always wins (tests + isolated nodes).
//   - if the NEW path already exists, use it.
//   - else if the OLD path exists, migrate it to the new name ONCE (atomic rename); if the rename
//     can't happen (e.g. the DB is still open on Windows, or a concurrent process raced it), FALL
//     BACK to the old path rather than create an empty new one — so a node is never left split or
//     blanked. A returning node self-heals on the next start once the old dir is free.
//   - else create the new path.
// ---------------------------------------------------------------------------
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

const OLD_DATA_DIR = join(homedir(), '.cross-claude-mcp');
const NEW_DATA_DIR = join(homedir(), '.crosstalk');
const OLD_CONFIG = join(homedir(), '.claude', '.cross-claude-bus');
const NEW_CONFIG = join(homedir(), '.claude', '.crosstalk');

export const DATA_DIR_NAMES = { old: OLD_DATA_DIR, new: NEW_DATA_DIR };
export const CONFIG_NAMES = { old: OLD_CONFIG, new: NEW_CONFIG };

// Pure, testable directory migration: prefer `newDir`; else migrate `oldDir`→`newDir` once (atomic
// rename); if the rename can't happen (in-use/raced) keep `oldDir`; if neither exists, create
// `newDir`. Never creates an empty `newDir` alongside a populated `oldDir`.
export function migrateDir(oldDir, newDir) {
  if (existsSync(newDir)) return newDir;
  if (existsSync(oldDir)) {
    try { renameSync(oldDir, newDir); return newDir; }
    catch { return oldDir; }   // in-use / raced → keep the old (never blank the bus)
  }
  try { mkdirSync(newDir, { recursive: true }); } catch {}
  return newDir;
}

// Resolve (and migrate once) the data directory that holds messages.db / epoch / supervisor.json.
export function dataDir() {
  if (process.env.CC_DATA_DIR) return process.env.CC_DATA_DIR;   // override wins (tests / isolation)
  return migrateDir(OLD_DATA_DIR, NEW_DATA_DIR);
}

// Resolve the connection-config file. Back-compat READ only (no move): a fresh install writes the
// new path; an already-enrolled node keeps working off the old file until it's rewritten.
export function configPath() {
  if (process.env.CC_BUS_CONFIG) return process.env.CC_BUS_CONFIG;   // override wins
  if (existsSync(NEW_CONFIG)) return NEW_CONFIG;
  if (existsSync(OLD_CONFIG)) return OLD_CONFIG;
  return NEW_CONFIG;
}
