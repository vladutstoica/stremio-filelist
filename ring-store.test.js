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
  store.setWindow("r", 90, 99);
  fill(store, null, 0, 99);
  expect(store.bytes).toBeLessThanOrEqual(10 * CHUNK);
});

test("never evicts the pinned head and tail", () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 50, 60);
  fill(store, null, 0, 99);
  expect(store.chunks.has(0)).toBe(true);
  expect(store.chunks.has(99)).toBe(true);
});

test("drops pieces behind the window before pieces inside it", () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 70);
  fill(store, null, 10, 70);
  // 61 pieces into a 30-piece budget: everything behind the window goes first,
  // and the one in-window piece that still has to go is 70 -- the far end of the
  // window, which the reader reaches last.
  for (let i = 60; i <= 69; i++) expect(store.chunks.has(i)).toBe(true);
  expect(store.chunks.has(10)).toBe(false);
});

// Players keep several requests open at once -- a header probe, a tail probe,
// the playhead -- and each is a separate reader with its own window. A single
// shared window meant the newest request decided what the playhead could keep,
// so the read-ahead it was about to need was the first thing evicted.
test("keeps pieces wanted by any reader, not just the newest one", () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  store.setWindow("seek-probe", 80, 90);
  fill(store, null, 10, 90);
  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);
  for (let i = 80; i <= 90; i++) expect(store.chunks.has(i)).toBe(true);
  // Between and behind the two windows is what goes.
  expect(store.chunks.has(10)).toBe(false);
  expect(store.chunks.has(65)).toBe(false);
});

test("a reader stops holding pieces once its window is cleared", () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  store.setWindow("probe", 80, 90);
  fill(store, null, 40, 50);
  fill(store, null, 80, 90);
  for (let i = 80; i <= 90; i++) expect(store.chunks.has(i)).toBe(true);

  // The probe's request ends. Its pieces are now ahead of every window, so the
  // next pieces the playhead pulls in come out of them and not out of its own
  // read-ahead.
  store.clearWindow("probe");
  expect(store.readerCount()).toBe(1);
  fill(store, null, 51, 60);
  for (let i = 40; i <= 60; i++) expect(store.chunks.has(i)).toBe(true);
  // What went over the limit came off the abandoned probe's range, furthest
  // piece first, rather than out of the playhead's window.
  expect(store.chunks.has(90)).toBe(false);
  expect(store.chunks.has(89)).toBe(false);
});

// The incident's own ordering: the playhead registers and fetches first, and
// only then does a second request turn up somewhere else in the file. Whatever
// the newcomer wants, it must not cost the reader already streaming the pieces
// it has in hand.
test("keeps a reader's pieces when a second reader registers afterwards", () => {
  setCapacity(24 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  fill(store, null, 40, 50);
  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);

  // A whole-file re-open shows up mid-stream and claims its own window.
  store.setWindow("reopen", 80, 90);
  fill(store, null, 80, 90);
  // 22 pieces, still inside the budget. The pieces that go next come from
  // outside both windows, not out of the playhead's already-fetched range.
  fill(store, null, 20, 30);

  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);
  expect(store.chunks.has(20)).toBe(false);
  expect(store.chunks.has(21)).toBe(false);
});

// put() evicts synchronously while get() answers a tick later, so a piece can
// be dropped between the bitfield check that picked it and the read already
// queued against it. WebTorrent reports that as a stream that simply finished.
test("does not evict a piece a read is waiting on", (done) => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 50);
  fill(store, null, 41, 50); // exactly at the budget

  store.get(50, (err, buf) => {
    expect(err).toBeNull();
    expect(buf.length).toBe(CHUNK);
    // The hold is released once the reader has the buffer, not before.
    process.nextTick(() => {
      expect(store.pending.size).toBe(0);
      done();
    });
  });
  expect(store.pending.get(50)).toBe(1);

  // One piece over the budget. 50 sits furthest into the window and is the
  // first piece eviction would take from inside it; the read in flight has to
  // send eviction to 49 instead.
  fill(store, null, 40, 40);
  expect(store.chunks.has(50)).toBe(true);
  expect(store.chunks.has(49)).toBe(false);
});

// The pending guard must fully drain: hundreds of overlapping get() calls on
// the same handful of pieces should leave nothing held once every callback
// has run.
test("leaves no pending entries after many concurrent get() calls", (done) => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  fill(store, null, 40, 45);

  let remaining = 300;
  for (let i = 0; i < 300; i++) {
    store.get(40 + (i % 6), () => {
      remaining--;
      // The last callback's own release runs in a `finally` that fires after
      // this callback returns, so give it one more tick before asserting.
      if (remaining === 0) {
        setImmediate(() => {
          expect(store.pending.size).toBe(0);
          done();
        });
      }
    });
  }
});

test("tells the torrent a dropped piece is gone", () => {
  setCapacity(10 * CHUNK);
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  store.setWindow("r", 90, 99);
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
  a.setWindow("r", 90, 99);
  b.setWindow("r", 90, 99);
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
