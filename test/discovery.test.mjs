// Discovery regression test — no external test framework, just node:assert.
//   node test/discovery.test.mjs
// Boots two vendored servers at different epochs and asserts discovery selects the
// HIGHEST epoch, that a dead base probes to null, and that resolveFast is epoch-aware
// (a warm cache pointing at a higher epoch beats a lower-epoch pin — the zombie-leader fix).
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami, resolveFull, resolveFast, cacheLeader } from '../cc-discover.mjs';
import { createServer as createNetServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve an ephemeral port and immediately free it — a "dead base" nothing is listening on,
// without hardcoding a fixed port a tester might happen to run their own instance on (F2).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function boot(port, epoch, host) {
  const dir = mkdtempSync(join(tmpdir(), 'ccdisc-'));
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CC_EPOCH: String(epoch), CC_HOST: host, CC_DATA_DIR: dir, MCP_API_KEY: 'tt' },
    stdio: 'ignore',
  });
}

// Poll until a base answers /cc/whoami, or give up. The server can take a few seconds to bind
// on a cold host, so a fixed sleep would be flaky.
async function waitUp(base, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = await whoami(base, 1500);
    if (w) return w;
    await sleep(500);
  }
  return null;
}

// Keep discovery HERMETIC from the real estate: point the config at a nonexistent file (so no
// real CC_BASE pin / token leaks in) and the leader cache at a scratch dir. Otherwise the live
// estate leader (reachable via the real pin/cache) outranks the epoch-9 test server and the
// "highest epoch wins" assertion flakes depending on whether the estate is up.
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cccache-'));
// Also isolate the LAN beacon port — otherwise this test's UDP solicit on the default 8788
// hits the real estate leader's beacon and its epoch leaks into the scan.
process.env.CC_BEACON_PORT = '8899';

const a = boot(8792, 3, 'lowEpoch');
const b = boot(8793, 9, 'highEpoch');
let failed = false;
try {
  // Wait for both servers to actually bind (not a fixed sleep).
  assert.ok(await waitUp('http://127.0.0.1:8792'), 'server A came up');
  assert.ok(await waitUp('http://127.0.0.1:8793'), 'server B came up');

  // whoami hits each
  assert.equal((await whoami('http://127.0.0.1:8792')).epoch, 3, 'server A epoch');
  assert.equal((await whoami('http://127.0.0.1:8793')).epoch, 9, 'server B epoch');

  // dead base → null (an ephemeral, guaranteed-free port — not a fixed one a tester might occupy)
  const deadPort = await freePort();
  assert.equal(await whoami(`http://127.0.0.1:${deadPort}`, 800), null, 'dead base → null');

  // resolveFull with both as peers must pick the HIGHEST epoch
  process.env.CC_PORT = '8792';
  process.env.CC_PEERS = '127.0.0.1:8792,127.0.0.1:8793';
  process.env.CC_TOKEN = 'tt';
  const leader = await resolveFull({});
  assert.ok(leader, 'a leader is found');
  assert.equal(leader.epoch, 9, 'highest epoch wins');
  assert.equal(leader.host, 'highEpoch', 'winner is the high-epoch host');

  // resolveFast must be EPOCH-AWARE (regression for the zombie-leader fix): given a
  // low-epoch pin AND a warm cache pointing at the higher-epoch server, it must pick the
  // higher epoch — not the first (pin) responder. Prime the cache to the epoch-9 server,
  // pin the epoch-3 server, and assert 9 wins.
  cacheLeader({ base: 'http://127.0.0.1:8793', host: 'highEpoch', epoch: 9 });
  const fast = await resolveFast({ pin: 'http://127.0.0.1:8792' });
  assert.ok(fast, 'resolveFast found a leader');
  assert.equal(fast.epoch, 9, 'resolveFast picks the HIGHEST epoch (cache 9 > pin 3), not the first responder');

  console.log('✅ discovery.test: all assertions passed (whoami, dead→null, resolveFull highest-epoch, resolveFast epoch-aware)');
} catch (e) {
  failed = true;
  console.error('❌ discovery.test FAILED:', e.message);
} finally {
  a.kill(); b.kill();
}
process.exit(failed ? 1 : 0);
