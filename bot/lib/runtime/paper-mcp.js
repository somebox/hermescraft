/**
 * PaperMCP client — sends server-side commands via the PaperMCP WebSocket API.
 *
 * PaperMCP plugin uses a custom auth handshake then JSON-RPC for requests:
 *   1. Send { type: "authenticate", token } → receive { type: "auth_response", success }
 *   2. Send JSON-RPC { jsonrpc: "2.0", id, method: "execute_command", params: { command } }
 *
 * Config via env: PAPERMCP_HOST, PAPERMCP_PORT, PAPERMCP_TOKEN.
 */

let _idCounter = 0;

/**
 * Wait for the next message matching a predicate.
 * @param {WebSocket} ws
 * @param {(msg: any) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('PaperMCP response timeout'));
    }, timeoutMs);
    /** @param {MessageEvent} ev */
    const handler = (ev) => {
      try {
        const msg = JSON.parse(typeof ev === 'string' ? ev : ev.data);
        if (predicate(msg)) {
          ws.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve(msg);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.addEventListener('message', handler);
  });
}

/**
 * Execute a server command via PaperMCP.
 * Opens a one-shot WebSocket connection, authenticates, runs the command, closes.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {string} command - the command WITHOUT leading slash (e.g. "kill Flint")
 * @returns {Promise<{ok: boolean, result?: string, error?: string}>}
 */
let _executeImpl = defaultExecuteServerCommand;

async function defaultExecuteServerCommand({ host, port, token }, command) {
  const url = `ws://${host}:${port}`;
  const ws = new WebSocket(url);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PaperMCP connect timeout: ${url}`)), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
    });

    // Step 1: authenticate with custom message format
    const authPromise = waitForMessage(ws, (m) => m.type === 'auth_response', 5000);
    ws.send(JSON.stringify({ type: 'authenticate', token }));
    const authResp = await authPromise;
    if (!authResp.success) {
      throw new Error(`PaperMCP auth failed: ${authResp.message || 'invalid token'}`);
    }

    // Step 2: send JSON-RPC execute_command
    const id = ++_idCounter;
    const rpcPromise = waitForMessage(ws, (m) => m.id === id, 10000);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'execute_command', params: { command } }));
    const rpcResp = await rpcPromise;

    if (rpcResp.error) {
      throw new Error(rpcResp.error.message || JSON.stringify(rpcResp.error));
    }
    const result = rpcResp.result;
    return { ok: true, result: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message || String(err) };
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

export async function executeServerCommand(cfg, command) {
  return _executeImpl(cfg, command);
}

// Test seam: allows contract tests to inject a successful stub without touching the network
// or mutating read-only namespace bindings.
export function __testOnly_setExecuteServerCommand(fn) {
  _executeImpl = fn || defaultExecuteServerCommand;
}

export function __testOnly_resetExecuteServerCommand() {
  _executeImpl = defaultExecuteServerCommand;
}

import { getConfig } from '../config/index.js';

/**
 * Build PaperMCP config, returns null if token not set.
 * Reads from the central config singleton (loaded once at server startup).
 * @returns {{ host: string, port: number, token: string } | null}
 */
export function paperMcpConfig() {
  const { papermcp } = getConfig();
  if (!papermcp.token) return null;
  return { host: papermcp.host, port: papermcp.port, token: papermcp.token };
}
