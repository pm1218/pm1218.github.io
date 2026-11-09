import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrPool, defaultPoolSize } from '../js/ocr-pool.js';

// Fake Tesseract worker: echoes the image back after a delay, records calls.
function fakeFactory({ delay = 20, failFirst = false } = {}) {
  const log = { created: 0, setParameters: 0, inFlight: 0, maxInFlight: 0 };
  let n = 0;
  const create = async () => {
    const id = n++;
    if (failFirst && id === 0) throw new Error('boom');
    log.created++;
    let params = null;
    return {
      async setParameters(p) { log.setParameters++; params = p; },
      async recognize(image) {
        log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        await new Promise((r) => setTimeout(r, delay));
        log.inFlight--;
        return { data: { words: [{ text: `${image}|${params.psm}` }] } };
      },
      async terminate() {},
    };
  };
  return { create, log };
}

test('pool runs jobs in parallel and keeps each result with its job', async () => {
  const { create, log } = fakeFactory();
  const pool = createOcrPool(create, 3);
  const jobs = Array.from({ length: 30 }, (_, i) => pool.recognize(`img${i}`, { psm: i % 2 ? '7' : '11' }));
  const out = await Promise.all(jobs);
  out.forEach((d, i) => assert.equal(d.words[0].text, `img${i}|${i % 2 ? '7' : '11'}`));
  assert.equal(log.created, 3);
  assert.equal(log.maxInFlight, 3);
});

test('parallel is faster than one worker', async () => {
  const time = async (size) => {
    const { create } = fakeFactory({ delay: 15 });
    const pool = createOcrPool(create, size);
    await pool.recognize('warm', { psm: '7' });
    const t = Date.now();
    await Promise.all(Array.from({ length: 24 }, (_, i) => pool.recognize(`i${i}`, { psm: '7' })));
    return Date.now() - t;
  };
  const one = await time(1); const three = await time(3);
  assert.ok(three < one * 0.6, `3 workers ${three}ms vs 1 worker ${one}ms`);
});

test('setParameters only when a worker switches parameters', async () => {
  const { create, log } = fakeFactory();
  const pool = createOcrPool(create, 1);
  await Promise.all([1, 2, 3, 4, 5].map((i) => pool.recognize(`a${i}`, { psm: '7', wl: 'abc' })));
  assert.equal(log.setParameters, 1);
  await pool.recognize('b', { psm: '11', wl: '' });
  assert.equal(log.setParameters, 2);
});

test('a failing first worker rejects queued jobs instead of hanging', async () => {
  const { create } = fakeFactory({ failFirst: true });
  const pool = createOcrPool(create, 3);
  await assert.rejects(pool.recognize('x', {}), /boom/);
});

test('pool size follows the device', () => {
  assert.equal(defaultPoolSize({ hardwareConcurrency: 8 }), 3);
  assert.equal(defaultPoolSize({ hardwareConcurrency: 4 }), 2);
  assert.equal(defaultPoolSize({ hardwareConcurrency: 2 }), 1);
  assert.equal(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 2 }), 2);
  assert.equal(defaultPoolSize(undefined), 1);
});
