// Discovery regression test — no external test framework, just node:assert.
//   node test/discovery.test.mjs
// Boots two vendored servers at different epochs and asserts discovery selects the
// HIGHEST epoch, and that a dead base probes to null.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami, resolveFull } from '../cc-discover.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(port, epoch, host) {
  const dir = mkdtempSync(join(tmpdir(), 'ccdisc-'));
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CC_EPOCH: String(epoch), CC_HOST: host, CC_DATA_DIR: dir, MCP_API_KEY: 'tt' },
    stdio: 'ignore',
  });
}

const a = boot(8792, 3, 'lowEpoch');
const b = boot(8793, 9, 'highEpoch');
let failed = false;
try {
  await sleep(2500);

  // whoami hits each
  assert.equal((await whoami('http://127.0.0.1:8792')).epoch, 3, 'server A epoch');
  assert.equal((await whoami('http://127.0.0.1:8793')).epoch, 9, 'server B epoch');

  // dead base → null
  assert.equal(await whoami('http://127.0.0.1:8799', 800), null, 'dead base → null');

  // resolveFull with both as peers must pick the HIGHEST epoch
  process.env.CC_PORT = '8792';
  process.env.CC_PEERS = '127.0.0.1:8792,127.0.0.1:8793';
  process.env.CC_TOKEN = 'tt';
  const leader = await resolveFull({});
  assert.ok(leader, 'a leader is found');
  assert.equal(leader.epoch, 9, 'highest epoch wins');
  assert.equal(leader.host, 'highEpoch', 'winner is the high-epoch host');

  console.log('✅ discovery.test: all assertions passed (whoami, dead→null, highest-epoch selection)');
} catch (e) {
  failed = true;
  console.error('❌ discovery.test FAILED:', e.message);
} finally {
  a.kill(); b.kill();
}
process.exit(failed ? 1 : 0);
