import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer } from '../../support/peer.mjs';
import { createApp } from '../../src/server.mjs';

const partnerConfig = JSON.parse(await readFile(new URL('../../fixtures/partner.json', import.meta.url)));
const seedUrl = new URL('../../fixtures/records.json', import.meta.url);

export const TOKENS = {
  repA: 'tok-representative-a', // PER-A，CO-1 代表（需先核实草案）
  front: 'tok-front',
  ops: 'tok-operations',
  review: 'tok-review',
  cashier: 'tok-cashier',
};

// 固定时钟，保证“发生时间”不由测试执行时刻决定。
export function fakeClock(startIso) {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current).toISOString(),
    advance: (minutes) => { current += minutes * 60000; return new Date(current).toISOString(); },
    date: () => new Date(current).toISOString().slice(0, 10),
  };
}

export async function startHarness({ carrierRules = {}, seed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'app-'));
  const appState = join(dir, 'app.json');
  const peerState = join(dir, 'peer.json');

  const peer = createPeer(partnerConfig, peerState);
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  const peerPort = peer.address().port;
  const peerBase = `http://127.0.0.1:${peerPort}`;

  // 预置承运台规则（accepted/pending/rejected/accepted_disconnect）。
  for (const [id, mode] of Object.entries(carrierRules)) {
    await fetch(`${peerBase}/control/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    });
  }

  const clock = fakeClock('2026-11-26T03:00:00Z');
  const buildApp = () => createApp({
    stateFile: appState,
    seedFile: seed ? seedUrl.pathname : null,
    carrierBaseUrl: peerBase,
    clock: clock.now,
    carrierTimeoutMs: 1500,
  });
  let app = buildApp();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;

  const makeCall = baseUrl => async (token, method, path, body) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, body: json };
  };
  let call = makeCall(base);

  const harness = {
    dir, appState, peerState, peerBase, clock,
    get base() { return base; },
    get app() { return app; },
    call: (...args) => call(...args),
    async restart() {
      await new Promise(resolve => app.server.close(resolve));
      // 重启不重新播种：验证持久化保留。
      app = createApp({
        stateFile: appState,
        seedFile: null,
        carrierBaseUrl: peerBase,
        clock: clock.now,
        carrierTimeoutMs: 1500,
      });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
      call = makeCall(base);
      return harness;
    },
    async stop() {
      await new Promise(resolve => app.server.close(resolve));
      await new Promise(resolve => peer.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export { partnerConfig };
