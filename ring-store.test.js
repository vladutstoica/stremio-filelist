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

// Mirrors WebTorrent: a piece only counts as verified once put()'s callback
// has run, and the next piece arrives at least a tick later.
async function fill(store, torrent, from, to) {
  for (let i = from; i <= to; i++) {
    await new Promise((resolve) => {
      store.put(i, Buffer.alloc(CHUNK, i % 256), () => {
        if (torrent) torrent._have.add(i);
        resolve();
      });
    });
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

test("keeps total bytes within the configured capacity", async () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 90, 99);
  await fill(store, null, 0, 99);
  expect(store.bytes).toBeLessThanOrEqual(10 * CHUNK);
});

test("never evicts the pinned head and tail", async () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 50, 60);
  await fill(store, null, 0, 99);
  expect(store.chunks.has(0)).toBe(true);
  expect(store.chunks.has(99)).toBe(true);
});

test("drops pieces behind the window before pieces inside it", async () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 70);
  await fill(store, null, 10, 70);
  // 61 pieces into a 30-piece budget: everything behind the window goes first,
  // and the one in-window piece that still has to go comes off the far end of
  // the window, which the reader reaches last. That is 69, not 70: 70 is the
  // piece being put, and dropping it before WebTorrent has marked it verified
  // is how a piece ends up verified and missing.
  for (let i = 60; i <= 68; i++) expect(store.chunks.has(i)).toBe(true);
  expect(store.chunks.has(70)).toBe(true);
  expect(store.chunks.has(69)).toBe(false);
  expect(store.chunks.has(10)).toBe(false);
});

// Players keep several requests open at once -- a header probe, a tail probe,
// the playhead -- and each is a separate reader with its own window. A single
// shared window meant the newest request decided what the playhead could keep,
// so the read-ahead it was about to need was the first thing evicted.
test("keeps pieces wanted by any reader, not just the newest one", async () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  store.setWindow("seek-probe", 80, 90);
  await fill(store, null, 10, 90);
  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);
  for (let i = 80; i <= 90; i++) expect(store.chunks.has(i)).toBe(true);
  // Between and behind the two windows is what goes.
  expect(store.chunks.has(10)).toBe(false);
  expect(store.chunks.has(65)).toBe(false);
});

test("a reader stops holding pieces once its window is cleared", async () => {
  setCapacity(30 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  store.setWindow("probe", 80, 90);
  await fill(store, null, 40, 50);
  await fill(store, null, 80, 90);
  for (let i = 80; i <= 90; i++) expect(store.chunks.has(i)).toBe(true);

  // The probe's request ends. Its pieces are now ahead of every window, so the
  // next pieces the playhead pulls in come out of them and not out of its own
  // read-ahead.
  store.clearWindow("probe");
  expect(store.readerCount()).toBe(1);
  await fill(store, null, 51, 60);
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
test("keeps a reader's pieces when a second reader registers afterwards", async () => {
  setCapacity(24 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("playhead", 40, 50);
  await fill(store, null, 40, 50);
  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);

  // A whole-file re-open shows up mid-stream and claims its own window.
  store.setWindow("reopen", 80, 90);
  await fill(store, null, 80, 90);
  // 22 pieces, still inside the budget. The pieces that go next come from
  // outside both windows, not out of the playhead's already-fetched range.
  await fill(store, null, 20, 30);

  for (let i = 40; i <= 50; i++) expect(store.chunks.has(i)).toBe(true);
  expect(store.chunks.has(20)).toBe(false);
  expect(store.chunks.has(21)).toBe(false);
});

// put() evicts synchronously while get() answers a tick later, so a piece can
// be dropped between the bitfield check that picked it and the read already
// queued against it. WebTorrent reports that as a stream that simply finished.
test("does not evict a piece a read is waiting on", async () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 50);
  await fill(store, null, 41, 50); // exactly at the budget

  const read = new Promise((resolve) => {
    store.get(50, (err, buf) => {
      expect(err).toBeNull();
      expect(buf.length).toBe(CHUNK);
      // The hold is released once the reader has the buffer, not before.
      process.nextTick(() => {
        expect(store.pending.size).toBe(0);
        resolve();
      });
    });
  });
  expect(store.pending.get(50)).toBe(1);

  // One piece over the budget. 50 sits furthest into the window and is the
  // first piece eviction would take from inside it; the read in flight has to
  // send eviction to 49 instead.
  await fill(store, null, 40, 40);
  expect(store.chunks.has(50)).toBe(true);
  expect(store.chunks.has(49)).toBe(false);
  await read;
});

// The pending guard must fully drain: hundreds of overlapping get() calls on
// the same handful of pieces should leave nothing held once every callback
// has run.
test("leaves no pending entries after many concurrent get() calls", async () => {
  setCapacity(10 * CHUNK);
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  await fill(store, null, 40, 45);

  let done;
  const drained = new Promise((resolve) => { done = resolve; });
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
  await drained;
});


test("tells the torrent a dropped piece is gone", async () => {
  setCapacity(10 * CHUNK);
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  store.setWindow("r", 90, 99);
  await fill(store, torrent, 0, 99);
  expect(torrent.unverified.length).toBeGreaterThan(0);
  // Pinned pieces are never handed back to the picker.
  expect(torrent.unverified).not.toContain(0);
  expect(torrent.unverified).not.toContain(99);
});

test("splits the budget between concurrent streams", async () => {
  setCapacity(40 * CHUNK);
  const a = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  const b = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  a.setWindow("r", 90, 99);
  b.setWindow("r", 90, 99);
  await fill(a, null, 0, 99);
  await fill(b, null, 0, 99);
  expect(stats().bytes).toBeLessThanOrEqual(40 * CHUNK);
  a.close();
  b.close();
});

test("close frees the memory and leaves the registry", async () => {
  store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  await fill(store, null, 0, 20);
  const before = stats().stores;
  await new Promise((resolve) => store.close(resolve));
  expect(stats().stores).toBe(before - 1);
  expect(store.bytes).toBe(0);
});

// The incident: every held piece sat inside some reader's window, so eviction
// fell through to the in-window bucket and dropped the piece put() had just
// stored -- before WebTorrent's callback had marked it verified, so nothing
// marked it unverified either. The callback then set the bit for a piece the
// store no longer had, and every read of it ended the stream with no bytes.
test("never reports a piece verified that it has already evicted", async () => {
  setCapacity(10 * CHUNK);
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 60);
  await fill(store, torrent, 40, 49); // exactly at the budget, all in the window

  await fill(store, torrent, 50, 50); // the sequential frontier
  for (let i = 40; i <= 50; i++) {
    expect({ i, phantom: torrent.bitfield.get(i) && !store.chunks.has(i) }).toEqual({ i, phantom: false });
  }
  expect(store.chunks.has(50)).toBe(true);
});

test("keeps both pieces of two puts in the same tick until their callbacks run", async () => {
  setCapacity(10 * CHUNK);
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  store.setWindow("r", 40, 60);
  await fill(store, torrent, 40, 49);

  // Two pieces landing back to back: the second put's eviction must not take
  // the first while WebTorrent is still about to mark it verified.
  await Promise.all([50, 51].map((i) => new Promise((resolve) => {
    store.put(i, Buffer.alloc(CHUNK, i), () => {
      torrent._have.add(i);
      resolve();
    });
  })));
  expect(store.chunks.has(50)).toBe(true);
  expect(store.chunks.has(51)).toBe(true);
  for (let i = 40; i <= 51; i++) {
    expect({ i, phantom: torrent.bitfield.get(i) && !store.chunks.has(i) }).toEqual({ i, phantom: false });
  }
  await new Promise((r) => setImmediate(r));
  expect(store.pending.size).toBe(0);
});

// If the torrent ever does believe it holds a piece we do not, failing the read
// is not enough: WebTorrent will never refetch it, and the reader retries the
// same missing piece until it gives up. Hand it back to the picker as well.
test("get() of a missing piece the torrent believes it has marks it unverified", async () => {
  const torrent = fakeTorrent();
  store = new RingStore(CHUNK, { length: LENGTH, torrent, pinBytes: 2 * CHUNK });
  torrent._have.add(42);
  const err = await new Promise((resolve) => store.get(42, resolve));
  expect(err).toBeTruthy();
  expect(err.message).toMatch(/not in window/);
  expect(torrent.unverified).toContain(42);
  expect(torrent.bitfield.get(42)).toBe(false);
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
