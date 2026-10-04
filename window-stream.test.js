const { PassThrough } = require("stream");
// WebTorrent builds file.createReadStream() on streamx, not on Node's streams,
// and the two behave differently when destroyed mid-read: Node's throws a
// premature close, streamx's never settles a read that is still waiting. The
// fake has to be the real thing or these tests pass against code that hangs.
const { Readable } = require("streamx");
const {
  streamWindowed,
  isProbeRange,
  windowFor,
  parseRange,
  WINDOW_FRACTION,
  WINDOW_READER_DIVISOR,
  WINDOW_SHARE_FROM,
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
// iterator without an error event. A Readable is handed back as-is, so a test
// can script a read that never yields at all -- see hungRead().
function fakeTorrent(reads) {
  const store = newStore();
  const torrent = {
    pieceLength: CHUNK,
    store,
    _critical: [],
    // Matches WebTorrent's own: flag the range, never clear it -- clearing is
    // the reader's job.
    critical(from, to) {
      for (let i = from; i <= to; i++) this._critical[i] = true;
    },
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
      if (payload instanceof Readable) return payload;
      return Readable.from(payload === undefined ? [] : payload);
    },
  };
  torrent.files.push(file);
  return { torrent, file, store };
}

// A read waiting on a piece that never arrives: WebTorrent's FileIterator
// parks next() on a 'verified' event that does not come. `released` says
// whether we let go of it: return() is what makes the real FileIterator drop
// its torrent selection. streamx only flips `destroyed` once a pending read
// settles, which this one never does.
function hungRead() {
  const never = {
    released: false,
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => {
      never.released = true;
      return { done: true };
    },
  };
  const stream = Readable.from(never);
  stream.iterator = never;
  return stream;
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

  const { gaveUp } = await streamWindowed(torrent, file, 0, LENGTH - 1, res, null, {});

  expect(file.calls.length).toBe(0);
  expect(gaveUp).toBe(false); // the client left; we did not reset it
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

  // WINDOW_READER_DIVISOR windows of this size still fit the store's share. Sized
  // above the two-piece floors in windowFor(), which a cache this small would
  // otherwise dominate.
  const budget = Math.floor((shareFor(store) * WINDOW_FRACTION) / WINDOW_READER_DIVISOR);
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
  const { gaveUp } = await streamWindowed(torrent, file, 0, LENGTH - 1, res, null, {});

  expect(Date.now() - started).toBeLessThan(15000);
  // Reported as ours, so the caller's log does not blame the client for it.
  expect(gaveUp).toBe(true);
  expect(file.calls.length).toBeGreaterThan(1);
  // Reset, not a clean end: the body is short of the Content-Length we promised
  // and ending it cleanly would claim otherwise.
  expect(res.destroyed).toBe(true);
  expect(res.writableEnded).toBe(false);
  expect(store.readerCount()).toBe(0);
}, 30000);

// The refusal this replaces left the newest reader -- after a seek, the actual
// playhead -- running unprotected while abandoned duplicates held the windows.
// In production that was playback pinned at byte 0 with two peers while four
// duplicate requests at byte 0 owned every window. Windows overlap, so they do
// not cost what that quota assumed: everyone gets one.
test("a fifth reader still gets a window, and the incumbents keep theirs", async () => {
  setCapacity(1000 * CHUNK);
  const store = newStore();
  store.setWindow("r1", 0, 5);
  store.setWindow("r2", 10, 15);
  store.setWindow("r3", 20, 25);
  store.setWindow("r4", 30, 35);
  const before = new Map([...store.windows].map(([k, v]) => [k, { ...v }]));

  // Mid-file, well outside the pinned head and tail, so it is not a probe.
  const body = Buffer.alloc(CHUNK, 9);
  const start = 50 * CHUNK;
  const torrent = {
    pieceLength: CHUNK, store, _critical: [], files: [],
    critical(from, to) { for (let i = from; i <= to; i++) this._critical[i] = true; },
  };
  const file = {
    name: "film.mkv",
    offset: 0,
    length: LENGTH,
    createReadStream: () => Readable.from([body]),
  };
  const { res } = sink();

  const done = streamWindowed(torrent, file, start, start + body.length - 1, res, null, {});
  // The synchronous half of the first loop iteration -- including this reader's
  // own applyWindow() call -- has already run, since `for await` on the fake
  // read stream always suspends at its first tick.
  expect(store.readerCount()).toBe(5);
  for (const [token, w] of before) expect(store.windows.get(token)).toEqual(w);

  await done;
  expect(store.readerCount()).toBe(4); // its own window released on the way out
  store.close();
});

// Overlapping windows are free, but disjoint ones are not: past a handful of
// readers they have to share the budget or they stop fitting it together.
test("sizes windows against the real count once there are many readers", () => {
  setCapacity(4000 * CHUNK);
  const store = newStore();
  const few = windowFor(store, 95, 1);
  const many = windowFor(store, 95, WINDOW_SHARE_FROM + 5);

  expect(many.ahead).toBeLessThan(few.ahead);
  const budget = shareFor(store) * WINDOW_FRACTION;
  expect((many.ahead + many.behind) * (WINDOW_SHARE_FROM + 5)).toBeLessThanOrEqual(budget * 1.01);
  store.close();
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
  const torrent = {
    pieceLength: CHUNK, store, _critical: [], files: [],
    critical(from, to) { for (let i = from; i <= to; i++) this._critical[i] = true; },
  };
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

// A piece flagged critical can be hotswapped away from a peer that is sitting
// on it, but WebTorrent's own reader flags only the piece it is already stuck
// on -- and for pieces of 1MB or more its _criticalLength works out to zero, so
// the rescue only began once playback had already stopped on that piece. The
// band has to run ahead of the read head, and has to be let go behind it.
test("flags pieces ahead of the read head critical, and clears them behind", async () => {
  const body = Buffer.alloc(8 * CHUNK, 4);
  const { torrent, file, store } = fakeTorrent([[body], [body], [body], [body]]);
  const { res } = sink();
  const start = 60 * CHUNK;

  await streamWindowed(torrent, file, start, start + body.length * 3 - 1, res, null, {});

  const flagged = torrent._critical.reduce((n, v, i) => (v ? n.concat(i) : n), []);
  expect(flagged.length).toBeGreaterThan(0);

  // Nothing behind where the reader finished is still flagged: a piece already
  // played is never worth swapping a peer for.
  const head = Math.floor((file.offset + start) / CHUNK);
  expect(Math.min(...flagged)).toBeGreaterThanOrEqual(head);

  // And the band is short -- it covers the next few seconds, not the window.
  expect(flagged.length).toBeLessThanOrEqual(Math.ceil((32 * 1024 * 1024) / CHUNK) + 1);
  store.close();
});

// A read blocked on a piece that never arrives used to hold its window, its
// position and its torrent selection for as long as the process lived: nothing
// woke the loop when the player hung up, so the stats line kept reporting a
// playhead that was long gone and the stale window kept eviction under
// pressure for every live reader.
test("returns and clears its window when the client goes away while a read is blocked", async () => {
  const hung = hungRead();
  const { torrent, file, store } = fakeTorrent([hung]);
  const { res } = sink();
  const entry = { reapplyWindows: new Set(), positions: new Map() };

  const done = streamWindowed(torrent, file, 10 * CHUNK, LENGTH - 1, res, entry, { idleMs: 60000 });
  expect(store.readerCount()).toBe(1);
  await new Promise((r) => setImmediate(r));
  res.destroy();
  const { gone } = await done;

  expect(gone).toBe(true);
  expect(hung.iterator.released).toBe(true);
  expect(store.readerCount()).toBe(0);
  expect(entry.positions.size).toBe(0);
  expect(entry.reapplyWindows.size).toBe(0);
}, 3000);

// WebTorrent never re-requests a piece evicted behind a live read's selection,
// so that read can wait forever without failing. Tearing it down and reading
// the same byte again re-selects from where the player actually is -- and the
// premature close that teardown causes is ours, not a read error.
test("restarts a hung read at the same byte after the idle timeout", async () => {
  const body = Buffer.alloc(2 * CHUNK, 5);
  const hung = hungRead();
  const { torrent, file } = fakeTorrent([hung, [body]]);
  const { res, bytes } = sink();
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const start = 10 * CHUNK;

  try {
    const { served, gaveUp } = await streamWindowed(torrent, file, start, start + body.length - 1, res, null, { idleMs: 200 });

    expect(hung.iterator.released).toBe(true);
    expect(file.calls.length).toBe(2);
    expect(file.calls[1].start).toBe(start);
    expect(bytes()).toBe(body.length);
    expect(served).toBe(body.length);
    expect(gaveUp).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
}, 3000);
