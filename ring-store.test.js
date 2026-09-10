const { RingStore, setCapacity, stats, DEFAULT_CAPACITY } = require("./ring-store");

const CHUNK = 1024;
const CHUNKS = 100;
const LENGTH = CHUNK * CHUNKS;

function fakeTorrent() {
  const have = new Set();
  return {
    destroyed: false,
    unverified: [],
    bitfield: { get: (i) => have.has(i) },
    _markUnverified(i) { this.unverified.push(i); have.delete(i); },
    _have: have,
  };
}

function fill(store, torrent, from, to) {
  for (let i = from; i <= to; i++) {
    store.put(i, Buffer.alloc(CHUNK, i % 256));
    if (torrent) torrent._have.add(i);
  }
}

let store;
afterEach((done) => {
  setCapacity(DEFAULT_CAPACITY);
  if (store && !store.closed) store.close(() => done());
  else done();
});

test("round-trips a chunk it still holds", (done) => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.put(5, Buffer.alloc(CHUNK, 7));
  store.get(5, (err, buf) => {
    expect(err).toBeNull();
    expect(buf.length).toBe(CHUNK);
    expect(buf[0]).toBe(7);
    done();
  });
});

test("honours offset and length on get", (done) => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.put(0, Buffer.alloc(CHUNK, 3));
  store.get(0, { offset: 10, length: 20 }, (err, buf) => {
    expect(err).toBeNull();
    expect(buf.length).toBe(20);
    done();
  });
});

test("rejects a chunk of the wrong length", (done) => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.put(0, Buffer.alloc(CHUNK - 1), (err) => {
    expect(err).toBeTruthy();
    done();
  });
});

test("errors rather than lying when a chunk was evicted", (done) => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.get(42, (err) => {
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/not in window/);
    done();
  });
});

test("keeps total bytes within the configured capacity", () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow(90, 99);
  fill(store, null, 0, 99);
  expect(store.bytes).toBeLessThanOrEqual(10 * CHUNK);
});

test("never evicts the pinned head and tail", () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow(50, 60);
  fill(store, null, 0, 99);
  expect(store.chunks.has(0)).toBe(true);
  expect(store.chunks.has(99)).toBe(true);
});

test("drops pieces behind the window before pieces inside it", () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow(40, 70);
  fill(store, null, 10, 70);
  for (let i = 60; i <= 70; i++) expect(store.chunks.has(i)).toBe(true);
  expect(store.chunks.has(10)).toBe(false);
});

test("tells the torrent a dropped piece is gone", () => {
  setCapacity(10 * CHUNK);
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  store.setWindow(90, 99);
  fill(store, torrent, 0, 99);
  expect(torrent.unverified.length).toBeGreaterThan(0);
  // Pinned pieces are never handed back to the picker.
  expect(torrent.unverified).not.toContain(0);
  expect(torrent.unverified).not.toContain(99);
});

test("splits the budget between concurrent streams", () => {
  setCapacity(40 * CHUNK);
  const a = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  const b = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  a.setWindow(90, 99);
  b.setWindow(90, 99);
  fill(a, null, 0, 99);
  fill(b, null, 0, 99);
  expect(stats().bytes).toBeLessThanOrEqual(40 * CHUNK);
  a.close();
  b.close();
});

test("close frees the memory and leaves the registry", (done) => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  fill(store, null, 0, 20);
  const before = stats().stores;
  store.close(() => {
    expect(stats().stores).toBe(before - 1);
    expect(store.bytes).toBe(0);
    done();
  });
});

// RingStore.drop() depends on torrent._markUnverified(), a private WebTorrent
// method, and on `deselect: true` to stop it re-selecting the piece we just
// dropped. If either disappears in an upgrade, eviction silently turns into a
// download/evict loop -- so fail here rather than in production.
test("the private WebTorrent internals we depend on still exist", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("webtorrent/lib/torrent.js"), "utf8");
  const version = require("webtorrent/package.json").version;

  expect(src).toMatch(/_markUnverified\s*\(index\)/);
  expect(src).toMatch(/if\s*\(!this\._startAsDeselected\)\s*this\.select\(index, index\)/);
  expect(src).toMatch(/this\._startAsDeselected\s*=\s*opts\.deselect/);
  expect(version).toMatch(/^2\.8\./); // widen deliberately, after re-reading the source
});
