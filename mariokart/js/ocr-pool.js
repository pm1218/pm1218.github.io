// A small pool of Tesseract workers so a photo's ~100 OCR passes run in
// parallel instead of one after another. Pure JS (no DOM) so it can be
// tested in Node with fake workers.
//
// Each job carries its own Tesseract parameters (page-seg mode, character
// whitelist). A worker only calls setParameters when they differ from what
// it last used, and idle workers prefer queued jobs that match their current
// parameters, so most jobs skip that extra round trip.

// Workers to use on this device: 1–3, fewer on low-core or low-memory phones.
export function defaultPoolSize(nav = globalThis.navigator) {
  const cores = nav?.hardwareConcurrency || 2;
  let n = cores >= 6 ? 3 : cores >= 4 ? 2 : 1;
  if (nav?.deviceMemory && nav.deviceMemory < 4) n = Math.min(n, 2);
  return n;
}

export function createOcrPool(createWorker, size = defaultPoolSize()) {
  const slots = [];   // { worker, key }
  const idle = [];
  const queue = [];   // { image, params, key, resolve, reject }
  let started = false;
  let alive = 0;
  let pending = 0;    // workers still being created
  let fatal = null;

  function add(worker) { const slot = { worker, key: null }; slots.push(slot); alive++; idle.push(slot); pump(); }
  function failed(err) {
    if (alive === 0 && pending === 0) {   // nothing will ever run the queue
      fatal = err;
      queue.splice(0).forEach((j) => j.reject(err));
    }
  }
  function spawn() {
    pending++;
    return Promise.resolve().then(createWorker)
      .then((w) => { pending--; add(w); }, (e) => { pending--; failed(e); });
  }

  // The first worker downloads and caches the language data; the others
  // start once it's ready so they read it from the cache instead of all
  // downloading it at the same time.
  function start() {
    if (started) return;
    started = true;
    spawn().then(() => { if (alive) for (let i = 1; i < size; i++) spawn(); });
  }

  function pump() {
    while (idle.length && queue.length) {
      const slot = idle.pop();
      let i = queue.findIndex((j) => j.key === slot.key);
      if (i < 0) i = 0;
      const [job] = queue.splice(i, 1);
      exec(slot, job).then(job.resolve, job.reject).finally(() => { idle.push(slot); pump(); });
    }
  }

  async function exec(slot, job) {
    if (slot.key !== job.key) {
      slot.key = null;   // unknown state if setParameters throws
      await slot.worker.setParameters(job.params);
      slot.key = job.key;
    }
    const { data } = await slot.worker.recognize(job.image);
    return data;
  }

  return {
    get size() { return size; },
    get workers() { return slots.length; },
    /** Queue one recognize call; resolves with Tesseract's `data`. */
    recognize(image, params = {}) {
      if (fatal) return Promise.reject(fatal);
      start();
      return new Promise((resolve, reject) => {
        queue.push({ image, params, key: JSON.stringify(params), resolve, reject });
        pump();
      });
    },
    async terminate() {
      await Promise.all(slots.map((s) => s.worker.terminate?.()));
      slots.length = 0; idle.length = 0; alive = 0; started = false;
    },
  };
}
