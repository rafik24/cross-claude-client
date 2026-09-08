// ---------------------------------------------------------------------------
// ws-hub.mjs — real-time push transport for the Cross-Claude bus (issue #3).
//
// Attaches a WebSocket endpoint to the leader's existing http.Server via the
// `upgrade` event, so push lives on the SAME port/token as the REST API — no new
// daemon, no new port, no new dependency. Hand-rolled framing (server->client
// text, plus enough client->server decode to honour ping/close): a handful of
// well-understood opcodes, verified against Node's built-in WebSocket client and
// Claude Code's Monitor `ws` source (2026-09-08).
//
// WHY hand-rolled and not the `ws` package: the estate is a fleet of machines,
// any of which may be the leader. node_modules is per-node and gitignored, so a
// new dependency would force `npm install` on every box before the bus could
// start. Hand-rolling keeps the estate update to a plain `git pull` + restart —
// which matters when a dozen live sessions are waiting on the upgrade.
//
// Model: a client (the cc-ws.mjs bridge) connects to
//   GET /cc/ws?identity=<id>&token=<tok>
// and the hub pushes it one JSON frame — {"type":"msg","message":{…}} — for every
// NEW message ADDRESSED to <id> (same filter cc-poll applied: dm channel, @mention,
// @all). The bridge does the rendering/wrapping and the cursor backfill; the hub is
// deliberately dumb about presentation. Fan-out is best-effort: a dead socket is
// dropped, never blocks a send, and the REST cursor API remains the reliability
// backstop (the bridge replays anything missed on reconnect).
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { addressedTo } from '../cc-render.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// --- server->client text frame (unmasked, single, unfragmented) ---
function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// --- incoming (client->server) frame decoder: buffers across TCP chunks, unmasks,
// yields {opcode, payload} per complete frame. We only ACT on close (0x8) and ping
// (0x9); data frames from the bridge are ignored (it never sends app data). ---
function makeDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset); offset += 8;
        len = Number(big);
      }
      let maskKey;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return;   // frame not fully arrived yet
      let payload = buf.subarray(offset, offset + len);
      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      buf = buf.subarray(offset + len);
      onFrame(opcode, payload);
    }
  };
}

// Attach the hub. Returns { notify(msg), connectionCount(), identities() }.
//   token: the shared bus token; a WS connect must present it (?token= or ?api_key=).
export function attachWsHub(httpServer, { token, log = () => {} } = {}) {
  // identity -> Set<socket>. A box may briefly hold two (old + reconnect) — both get the push.
  const conns = new Map();

  function add(identity, socket) {
    if (!conns.has(identity)) conns.set(identity, new Set());
    conns.get(identity).add(socket);
  }
  function remove(identity, socket) {
    const set = conns.get(identity);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) conns.delete(identity);
  }

  httpServer.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/cc/ws') { socket.destroy(); return; }

    const presented = url.searchParams.get('token') || url.searchParams.get('api_key') || '';
    if (token && presented !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const identity = url.searchParams.get('identity') || '';
    if (!identity) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket.setNoDelay?.(true);
    add(identity, socket);
    log(`[ws] + ${identity} (now ${conns.get(identity).size} socket(s); ${conns.size} identities)`);

    // Greet so the bridge knows push is live (it flips from poll-fallback to push-primary).
    try { socket.write(encodeFrame(JSON.stringify({ type: 'hello', identity }))); } catch {}

    const cleanup = () => {
      remove(identity, socket);
      log(`[ws] - ${identity} (${conns.size} identities remain)`);
    };

    const decode = makeDecoder((opcode, payload) => {
      if (opcode === 0x8) {                       // close
        try { socket.write(encodeFrame('', 0x8)); } catch {}
        try { socket.end(); } catch {}
      } else if (opcode === 0x9) {                // ping -> pong (echo payload)
        try { socket.write(encodeFrame(payload.toString('binary'), 0xA)); } catch {}
      }
      // 0x1/0x2 (data) and 0xA (pong) ignored — the bridge sends no application data.
    });

    socket.on('data', (chunk) => { try { decode(chunk); } catch {} });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('end', () => { try { socket.end(); } catch {} });

    // Server-initiated keepalive: ping every 30s. Node's WebSocket client and the Monitor
    // ws source auto-pong at the protocol level, keeping NAT/tailnet paths warm and letting
    // 'error'/'close' fire promptly on a dead peer.
    const ping = setInterval(() => { try { socket.write(encodeFrame('', 0x9)); } catch {} }, 30000);
    ping.unref?.();
    const clearPing = () => clearInterval(ping);
    socket.on('close', clearPing);
    socket.on('error', clearPing);
  });

  // Fan out a freshly-inserted message to every connected identity it is addressed to.
  // Best-effort and synchronous-ish: a failed write drops that socket and never throws.
  function notify(msg) {
    if (!conns.size) return;
    let frame = null;   // built lazily, reused across recipients
    for (const [identity, sockets] of conns) {
      if (msg.sender === identity) continue;             // never echo a lane its own message
      if (!addressedTo(msg, identity)) continue;
      if (!frame) frame = encodeFrame(JSON.stringify({ type: 'msg', message: msg }));
      for (const socket of sockets) {
        try { socket.write(frame); } catch { remove(identity, socket); try { socket.destroy(); } catch {} }
      }
    }
  }

  return {
    notify,
    connectionCount: () => { let n = 0; for (const s of conns.values()) n += s.size; return n; },
    identities: () => [...conns.keys()],
  };
}
