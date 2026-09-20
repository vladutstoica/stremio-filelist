const { PassThrough, Readable } = require("stream");
const {
  streamWindowed,
  isProbeRange,
  windowFor,
  parseRange,
  WINDOW_FRACTION,
  MAX_WINDOW_READERS,
} = require("./window-stream");
const { RingStore, setCapacity, shareFor, DEFAULT_CAPACITY } = require("./ring-store");

const CHUNK = 1024;
const CHUNKS = 100;
const LENGTH = CHUNK * CHUNKS;

// Every live store dilutes shareFor(), so one left open leaks into the window
// arithmetic of the next test. Track them and close them between tests.
const stores = [];

function newStore() {
  const store = new RingStore(CHUNK, { length: LENGTH, pinBytes: 2 * CHUNK });
  stores.push(store);
  return store;
}

// A torrent whose file reads are scripted: each entry in `reads` is the payload
// the next createReadStream() yields, and an empty array means "yielded
// nothing", which is how WebTorrent reports a failed store read -- it ends the
// iterator without an error event.
function fakeTorrent(reads) {
  const store = newStore();
  const torrent = {
    pieceLength: CHUNK,
    store,
    _critical: [],
    files: [],
  };
  const file = {
    name: "film.mkv",
    offset: 0,
    length: LENGTH,
    calls: [],
    createReadStream({ start, end }) {
      file.calls.push({ start, end });
      const payload = reads.shift();
      return Readable.from(payload === undefined ? [] : payload);
    },
  };
  torrent.files.push(file);
  return { torrent, file, store };
}

function sink() {
  const res = new PassThrough();
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  return { res, bytes: () => Buffer.concat(chunks).length };
}

afterEach(() => {
  setCapacity(DEFAULT_CAPACITY);
  while (stores.length) stores.pop().close();
});

// A piece can be evicted between WebTorrent marking it verified and our read of
// it, and that read then ends silently. Ending the response there would send a
// zero-byte body under a full Content-Length: the player retries the same range
// forever and a proxy in front turns it into a 5xx.
test("retries a read that yields nothing instead of ending the response empty", async () => {
  const body = Buffer.alloc(4 * CHUNK, 1);
  const { torrent, file, store } = fakeTorrent([[], [body], []]);
  const { res, bytes } = sink();

  await streamWindowed(torrent, file, 0, body.length - 1, res, null, {});

  expect(bytes()).toBe(body.length);
  expect(file.calls.length).toBeGreaterThan(1); // the empty read was re-issued
  expect(file.calls[1].start).toBe(0); // from the same position
  expect(store.readerCount()).toBe(0); // window released on the way out
}, 15000);

test("gives up once the client is gone rather than retrying into the void", async () => {
  const { torrent, file } = fakeTorrent([]);
  const { res } = sink();
  res.destroy();

  await streamWindowed(torrent, file, 0, LENGTH - 1, res, null, {});

  expect(file.calls.length).toBe(0);
});

test("registers one window per reader and drops it when the read ends", async () => {
  const body = Buffer.alloc(2 * CHUNK, 2);
  const { torrent, file, store } = fakeTorrent([[body]]);
  const { res } = sink();

  const live = [];
  const entry = { reapplyWindows: new Set() };
  const done = streamWindowed(torrent, file, 10 * CHUNK, 10 * CHUNK + body.length - 1, res, entry, {});
  live.push(store.readerCount(), entry.reapplyWindows.size);
  await done;

  expect(live).toEqual([1, 1]);
  expect(store.readerCount()).toBe(0);
  expect(entry.reapplyWindows.size).toBe(0);
});

// Players open a header or tail request constantly. Those ranges sit in the
// pinned region, which is never evicted, so they must not claim a window --
// doing so shrinks the playhead's share and drags the eviction bounds around.
test("a header or tail probe claims no window", async () => {
  const body = Buffer.alloc(CHUNK, 3);
  const { torrent, file, store } = fakeTorrent([[body]]);
  const { res } = sink();

  expect(isProbeRange(store, file, CHUNK, 0, CHUNK - 1)).toBe(true);
  expect(isProbeRange(store, file, CHUNK, CHUNKS * CHUNK - CHUNK, CHUNKS * CHUNK - 1)).toBe(true);
  expect(isProbeRange(store, file, CHUNK, 50 * CHUNK, 60 * CHUNK)).toBe(false);
  // A whole-file request starts in the pinned head and ends in the pinned tail.
  // It is the playhead, not a probe, and it needs a window.
  expect(isProbeRange(store, file, CHUNK, 0, CHUNKS * CHUNK - 1)).toBe(false);

  const done = streamWindowed(torrent, file, 0, CHUNK - 1, res, null, {});
  expect(store.readerCount()).toBe(0);
  await done;
});

// Every reader is sized against the same fixed share rather than against the
// live reader count, so a request that turns up later cannot narrow the window
// of one already streaming. The trade is that a lone reader leaves the other
// shares unused.
test("sizes every reader's window against the same fixed share", () => {
  setCapacity(1000 * CHUNK);
  const store = newStore();
  const alone = windowFor(store, 95);

  store.setWindow("playhead", 0, 10);
  store.setWindow("reopen", 40, 50);
  expect(windowFor(store, 95)).toEqual(alone);

  // MAX_WINDOW_READERS windows of this size still fit the store's share. Sized
  // above the two-piece floors in windowFor(), which a cache this small would
  // otherwise dominate.
  const budget = Math.floor((shareFor(store) * WINDOW_FRACTION) / MAX_WINDOW_READERS);
  expect(alone.ahead + alone.behind).toBeLessThanOrEqual(budget);
});

// The ordering that caused the incident: the playhead is already streaming when
// a whole-file re-open registers its own window. isProbeRange() does not exempt
// that request, and sizing against the live reader count used to halve the
// playhead's window the moment it appeared -- dropping read-ahead the playhead
// had already fetched.
test("a reader registering later does not shrink the window of one already streaming", async () => {
  setCapacity(150 * CHUNK);
  const body = Buffer.alloc(CHUNK, 4);
  const { torrent, file, store } = fakeTorrent([[body], [body], [body], []]);
  const { res } = sink();
  const read = file.createReadStream;
  const tops = [];

  file.createReadStream = (opts) => {
    for (const [token, w] of store.windows) if (token !== "reopen") tops.push(w.to);
    store.setWindow("reopen", 80, 90);
    if (tops.length >= 4) res.destroy(); // end the run without writing to a dead socket
    return read(opts);
  };

  await streamWindowed(torrent, file, 0, LENGTH - 1, res, null, {});

  expect(tops.length).toBe(4);
  // The playhead's window only ever moves forward with it.
  for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1]);
});

// Retrying forever traded a truncated body for a connection that never lets go:
// it held the socket, the response and this reader's window open against a
// piece that may never arrive.
test("gives up on a read that never yields and resets the connection", async () => {
  const { torrent, file, store } = fakeTorrent([]); // every read yields nothing
  const { res } = sink();

  const started = Date.now();
  await streamWindowed(torrent, file, 0, LENGTH - 1, res, null, {});

  expect(Date.now() - started).toBeLessThan(15000);
  expect(file.calls.length).toBeGreaterThan(1);
  // Reset, not a clean end: the body is short of the Content-Length we promised
  // and ending it cleanly would claim otherwise.
  expect(res.destroyed).toBe(true);
  expect(res.writableEnded).toBe(false);
  expect(store.readerCount()).toBe(0);
}, 30000);

// Past MAX_WINDOW_READERS, registering another window would no longer let
// them all fit the share together -- the thrash the fixed divisor exists to
// prevent. A fifth reader must run unwindowed instead of costing the other
// four their read-ahead.
test("a fifth reader gets no window while four incumbents keep theirs", async () => {
  setCapacity(1000 * CHUNK);
  const store = newStore();
  store.setWindow("r1", 0, 5);
  store.setWindow("r2", 10, 15);
  store.setWindow("r3", 20, 25);
  store.setWindow("r4", 30, 35);
  const before = new Map(store.windows);

  // Mid-file, well outside the pinned head/tail, so this isn't classified as
  // a probe -- it has to be the MAX_WINDOW_READERS check that refuses it.
  const body = Buffer.alloc(CHUNK, 9);
  const start = 50 * CHUNK;
  const torrent = { pieceLength: CHUNK, store, _critical: [], files: [] };
  const file = {
    name: "film.mkv",
    offset: 0,
    length: LENGTH,
    createReadStream: () => Readable.from([body]),
  };
  const { res } = sink();

  const done = streamWindowed(torrent, file, start, start + body.length - 1, res, null, {});
  // The synchronous half of the first loop iteration -- including the fifth
  // reader's own applyWindow() call -- has already run by this point, since
  // `for await` on the fake read stream always suspends at its first tick.
  expect(store.readerCount()).toBe(4);
  for (const [token, w] of before) expect(store.windows.get(token)).toEqual(w);

  await done;
  expect(store.readerCount()).toBe(4); // the fifth still never registered
});

// The fixed-divisor guarantee has to hold for real buffers, not just algebra:
// four readers each holding a full-budget window must not evict each other's
// pieces, and their combined bytes must stay inside the store's share.
test("four full-budget windows together fit the store's share without evicting each other", () => {
  setCapacity(80 * CHUNK);
  const store = newStore();
  const { ahead, behind } = windowFor(store, 95);
  const aheadPieces = Math.ceil(ahead / CHUNK);
  const behindPieces = Math.ceil(behind / CHUNK);
  const gap = aheadPieces + behindPieces + 2; // keep the four windows apart

  const windows = [0, 1, 2, 3].map((i) => {
    const center = 10 + behindPieces + i * gap;
    return { token: `r${i}`, from: center - behindPieces, to: center + aheadPieces };
  });

  for (const w of windows) store.setWindow(w.token, w.from, w.to);
  for (const w of windows) {
    for (let i = w.from; i <= w.to; i++) store.put(i, Buffer.alloc(CHUNK, i % 256));
  }

  for (const w of windows) {
    for (let i = w.from; i <= w.to; i++) expect(store.chunks.has(i)).toBe(true);
  }
  expect(store.bytes).toBeLessThanOrEqual(shareFor(store));
});

// Regression check for a slow leak: hundreds of short-lived readers must each
// clean up their own window and reapply-listener on the way out, not just
// eventually via GC.
test("leaves no window or listener behind after many short-lived readers", async () => {
  setCapacity(1000 * CHUNK);
  const store = newStore();
  const entry = { reapplyWindows: new Set() };
  const torrent = { pieceLength: CHUNK, store, _critical: [], files: [] };
  const runs = [];
  for (let i = 0; i < 300; i++) {
    const body = Buffer.alloc(CHUNK, i % 256);
    const pos = (10 + (i % 50)) * CHUNK;
    const file = {
      name: "film.mkv",
      offset: 0,
      length: LENGTH,
      createReadStream: () => Readable.from([body]),
    };
    const { res } = sink();
    runs.push(streamWindowed(torrent, file, pos, pos + body.length - 1, res, entry, {}));
  }
  await Promise.all(runs);
  expect(store.readerCount()).toBe(0);
  expect(entry.reapplyWindows.size).toBe(0);
});

// `bytes=-500` asks for the last 500 bytes. parseInt("") is NaN, and the `|| 0`
// standing in for it served the first 501 bytes instead -- the head of the file
// to a demuxer looking for cues in its tail.
test("reads a suffix range as the tail of the file", () => {
  expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
  expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
  expect(parseRange(undefined, 1000)).toEqual({ start: 0, end: 999 });
  // A suffix longer than the file is the whole file.
  expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  // Nothing to satisfy: start past the end, so the caller answers 416 rather
  // than serving everything.
  expect(parseRange("bytes=-0", 1000)).toEqual({ start: 1000, end: 999 });
});

// A bound that does not parse used to become NaN, and every comparison in the
// handler's 416 check is false against NaN -- so the request was served, with
// `Content-Length: NaN` on the wire. A proxy cannot make sense of that response
// and reports it as an upstream error: the same 520 the stall itself produced.
// Anything unreadable has to come back unsatisfiable instead.
test("treats an unparseable range as unsatisfiable rather than NaN", () => {
  const SIZE = 1000;
  const rejected = (r) => r.start >= SIZE || r.end >= SIZE || r.start > r.end;

  for (const header of [
    "bytes=abc-def",
    "bytes=5-abc",
    "bytes=NaN-NaN",
    "bytes=-abc",
    "bytes=",
    "bytes=--5",
  ]) {
    const range = parseRange(header, SIZE);
    expect(Number.isFinite(range.start)).toBe(true);
    expect(Number.isFinite(range.end)).toBe(true);
    expect(rejected(range)).toBe(true);
  }

  // Still lenient where leniency is harmless: a trailing junk bound is read as
  // the range before it, and only the first range of a multi-range ask is
  // honoured. Players do not send either for video.
  expect(parseRange("bytes=1-2-3", SIZE)).toEqual({ start: 1, end: 2 });
  expect(parseRange("bytes=0-1,2-3", SIZE)).toEqual({ start: 0, end: 1 });
});
