import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ORIGIN } from './support/harness.mjs';
import { POLL_TTL_MS, createVoteStore, validatePoll } from '../votes.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5" fill="#888"/></svg>';
const layout = (name, over = {}) => ({ name, priceSek: 12000, thumb: svg, ...over });
const body = () => ({ layouts: [layout('Open'), layout('Cosy')] });
const TOKEN_A = 'tokenAAAAAAAAAAAA1';
const TOKEN_B = 'tokenBBBBBBBBBBBB2';

describe('votes over http', () => {
  let s;
  let clock = 1_000_000;
  before(async () => { s = await startServer({ now: () => clock }); });
  after(() => s.close());

  test('create, read, vote once per token, counts update', async () => {
    const made = await s.request('/v1/votes', { json: body() });
    assert.equal(made.status, 201);
    const poll = await made.json();
    assert.match(poll.id, /^[A-Za-z0-9]{10}$/);
    assert.deepEqual(poll.layouts.map((l) => l.votes), [0, 0]);

    const v1 = await s.request(`/v1/votes/${poll.id}/vote`, { json: { choice: 1, token: TOKEN_A } });
    assert.equal(v1.status, 200);
    assert.deepEqual((await v1.json()).layouts.map((l) => l.votes), [0, 1]);

    const again = await s.request(`/v1/votes/${poll.id}/vote`, { json: { choice: 0, token: TOKEN_A } });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'already_voted');

    await s.request(`/v1/votes/${poll.id}/vote`, { json: { choice: 1, token: TOKEN_B } });
    const read = await (await s.request(`/v1/votes/${poll.id}`)).json();
    assert.deepEqual(read.layouts.map((l) => l.votes), [0, 2]);
    assert.equal(read.total, 2);
  });

  test('bad input uses the error envelope', async () => {
    const one = await s.request('/v1/votes', { json: { layouts: [layout('Only')] } });
    assert.equal(one.status, 400);
    assert.equal((await one.json()).error.code, 'invalid_request');
    const text = await s.request('/v1/votes', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
    const poll = await (await s.request('/v1/votes', { json: body() })).json();
    assert.equal((await s.request(`/v1/votes/${poll.id}/vote`, { json: { choice: 5, token: TOKEN_A } })).status, 400);
    assert.equal((await s.request(`/v1/votes/${poll.id}/vote`, { json: { choice: 0, token: 'short' } })).status, 400);
    assert.equal((await s.request('/v1/votes/abcdefghij')).status, 404);
    assert.equal((await s.request('/v1/votes/abc')).status, 404);
  });

  test('the body cap and origin rules still apply', async () => {
    const big = { layouts: [layout('A'), layout('B', { thumb: `<svg>${'x'.repeat(70_000)}</svg>` })] };
    assert.equal((await s.request('/v1/votes', { json: big })).status, 413);
    const res = await s.request('/v1/votes', { json: body(), origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const noOrigin = await s.request('/v1/votes', { json: body(), origin: null });
    assert.equal(noOrigin.status, 403);
    const get = await s.request('/v1/votes/abcdefghij', { method: 'DELETE' });
    assert.equal(get.status, 405);
  });

  test('a poll expires after 48 hours', async () => {
    const poll = await (await s.request('/v1/votes', { json: body() })).json();
    clock += POLL_TTL_MS + 1;
    assert.equal((await s.request(`/v1/votes/${poll.id}`)).status, 404);
  });

  test('CORS preflight allows the vote routes', async () => {
    const res = await s.request('/v1/votes/abcdefghij/vote', {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  });
});

describe('votes units', () => {
  test('unsafe thumbnails are refused', () => {
    for (const thumb of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="x()"></svg>',
      '<svg><image href="https://x.example/a.png"/></svg>',
      '<svg><a xlink:href="javascript:x()"/></svg>',
      '<svg><foreignObject/></svg>',
      '<div></div>',
    ]) assert.throws(() => validatePoll({ layouts: [layout('A', { thumb }), layout('B')] }), /thumbnail/, thumb);
  });

  test('plan data is accepted instead of a thumbnail, and checked', () => {
    const plan = { w: 4, h: 3, items: [{ x: 1, y: 1, w: 1, d: 0.5, r: 0 }] };
    const ok = validatePoll({ layouts: [{ name: 'A', priceSek: 1, plan }, layout('B')] });
    assert.equal(ok.layouts[0].plan.items.length, 1);
    assert.throws(() => validatePoll({ layouts: [{ name: 'A', priceSek: 1, plan: { w: 4, h: 3, items: [{ x: 'a' }] } }, layout('B')] }), /Plan/);
    assert.throws(() => validatePoll({ layouts: [{ name: 'A', priceSek: 1 }, layout('B')] }), /thumbnail or plan/);
  });

  test('store: capped, oldest polls leave first, and it expires', () => {
    let t = 0;
    const store = createVoteStore({ now: () => t, maxPolls: 3, ttlMs: 100 });
    const v = validatePoll(body());
    const ids = [store.create(v).id, store.create(v).id, store.create(v).id];
    store.create(v);
    assert.equal(store.size(), 3);
    assert.equal(store.get(ids[0]), null);
    assert.ok(store.get(ids[2]));
    t = 101;
    assert.equal(store.get(ids[2]), null);
  });
});
