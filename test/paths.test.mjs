// ---------------------------------------------------------------------------
// paths.test.mjs — the storage-rename migration (cc-paths.migrateDir) + env overrides.
//   node test/paths.test.mjs
//
// migrateDir is the load-bearing safety of the .cross-claude-mcp → .crosstalk rename: it must
// preserve a populated old dir, never blank the bus, and be idempotent. Tested hermetically on
// scratch dirs (never the real ~/.crosstalk).
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDir, dataDir, configPath } from '../cc-paths.mjs';

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };
const scratch = () => mkdtempSync(join(tmpdir(), 'ccpaths-'));

try {
  // 1. old exists, new absent → migrate (rename), old gone, content preserved at new.
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'messages.db'), 'DBDATA');
    writeFileSync(join(oldDir, 'epoch'), '24');
    const got = migrateDir(oldDir, newDir);
    ok(got === newDir, 'migrate: returns the new dir');
    ok(!existsSync(oldDir), 'migrate: old dir is gone (renamed, not copied)');
    ok(existsSync(newDir) && readFileSync(join(newDir, 'messages.db'), 'utf8') === 'DBDATA', 'migrate: DB content preserved at new');
    ok(readFileSync(join(newDir, 'epoch'), 'utf8') === '24', 'migrate: epoch sidecar preserved');
    rmSync(base, { recursive: true, force: true });
  }

  // 2. new already exists → use it, never touch old (idempotent second run / already-migrated).
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true }); writeFileSync(join(oldDir, 'stale'), 'x');
    mkdirSync(newDir, { recursive: true }); writeFileSync(join(newDir, 'messages.db'), 'CURRENT');
    const got = migrateDir(oldDir, newDir);
    ok(got === newDir, 'new-exists: returns new');
    ok(existsSync(oldDir), 'new-exists: old dir left untouched (not clobbered)');
    ok(readFileSync(join(newDir, 'messages.db'), 'utf8') === 'CURRENT', 'new-exists: new content intact');
    rmSync(base, { recursive: true, force: true });
  }

  // 3. neither exists → create new empty.
  {
    const base = scratch();
    const newDir = join(base, 'new');
    const got = migrateDir(join(base, 'nope'), newDir);
    ok(got === newDir && existsSync(newDir), 'neither: creates the new dir');
    ok(readdirSync(newDir).length === 0, 'neither: new dir is empty (fresh bus)');
    rmSync(base, { recursive: true, force: true });
  }

  // 4. env overrides win (tests + isolated nodes must never touch the real paths).
  {
    const d = scratch(); const c = join(scratch(), 'cfg');
    process.env.CC_DATA_DIR = d;
    ok(dataDir() === d, 'CC_DATA_DIR override wins for dataDir()');
    delete process.env.CC_DATA_DIR;
    writeFileSync(c, 'CC_TOKEN=x');
    process.env.CC_BUS_CONFIG = c;
    ok(configPath() === c, 'CC_BUS_CONFIG override wins for configPath()');
    delete process.env.CC_BUS_CONFIG;
  }

  console.log(failed ? '\n❌ paths.test FAILED' : '\n✅ paths.test: all assertions passed (migrateDir preserve/idempotent/create + env overrides)');
} catch (e) {
  failed = true; console.error('❌ paths.test ERROR:', e.stack || e.message);
}
process.exit(failed ? 1 : 0);
