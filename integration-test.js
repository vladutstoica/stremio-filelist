// End-to-end: seed a torrent locally, download it through RingStore, serve it
// with the windowed reader, and check the bytes survive a cache far smaller
// than the file.
const crypto = require("crypto");
const { Writable } = require("stream");
const { RingStore, setCapacity, shareFor, stats } = require("./ring-store");
const { streamWindowed, ringStoreOf } = require("./window-stream");

const FILE_SIZE = 2 * 1024 * 1024;
const PIECE_LENGTH = 16384;
const CAPACITY = 24 * PIECE_LENGTH; // ~393 KB for a 2 MB file

class FakeRes extends Writable {
  constructor() { super({ highWaterMark: 64 * 1024 }); this.chunks = []; }
  _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb(); }
  writeHead() {}
  get body() { return Buffer.concat(this.chunks); }
}

(async () => {
  const WebTorrent = (await import("webtorrent")).default;
  const data = crypto.randomBytes(FILE_SIZE);

  // Deliberately left with alwaysChokeSeeders at its default (true): after a
  // full pass we have announced HAVE for every piece, so without lt_donthave
  // the seeder classifies us as a seed, chokes us, and refetch never completes.
  const seeder = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false });
  const leecher = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false });
  setCapacity(CAPACITY);

  let peakBytes = 0;
  let evicted = 0;
  const origDrop = RingStore.prototype.drop;
  RingStore.prototype.drop = function (i) { evicted++; return origDrop.call(this, i); };
  let puts = 0;
  const origPut = RingStore.prototype.put;
  RingStore.prototype.put = function (i, buf, cb) {
    puts++;
    const r = origPut.call(this, i, buf, cb);
    peakBytes = Math.max(peakBytes, this.bytes);
    return r;
  };

  const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
  const timer = setTimeout(() => fail("timed out after 90s"), 90000);

  seeder.seed(data, { name: "test.bin", pieceLength: PIECE_LENGTH, announce: [] }, (st) => {
    console.log(`seeding: ${st.pieces.length} pieces of ${st.pieceLength} B`);

    leecher.add(st.torrentFile, {
      deselect: true,
      strategy: "sequential",
      store: RingStore,
      storeOpts: { pinBytes: 2 * PIECE_LENGTH },
      storeCacheSlots: 0,
      destroyStoreOnDestroy: true,
      path: "/tmp/ignored-by-ringstore",
    }, async (lt) => {
      lt.addPeer(`127.0.0.1:${seeder.torrentPort}`);
      const store = ringStoreOf(lt);
      if (!store) fail("RingStore was not installed as the chunk store");
      console.log(`share per stream: ${Math.round(shareFor(store) / 1024)} KB, file ${FILE_SIZE / 1024} KB`);

      const file = lt.files[0];
      const res = new FakeRes();
      const t0 = Date.now();
      await streamWindowed(lt, file, 0, file.length - 1, res, null, { readAheadPct: 95 });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      clearTimeout(timer);
      const body = res.body;
      console.log(`\nserved ${body.length} / ${FILE_SIZE} bytes in ${secs}s`);
      console.log(`peak store: ${Math.round(peakBytes / 1024)} KB (cap ${Math.round(CAPACITY / 1024)} KB)`);
      console.log(`pieces evicted: ${evicted}`);
      console.log(`selections left open: ${lt._selections.length}`);

      if (body.length !== FILE_SIZE) fail(`served ${body.length}, expected ${FILE_SIZE}`);
      if (!body.equals(data)) fail("served bytes do not match the original file");
      if (peakBytes > CAPACITY * 1.5) fail(`peak ${peakBytes} exceeded cap ${CAPACITY}`);
      if (evicted === 0) fail("nothing was evicted - the cache never filled, test is not meaningful");

      // Thrash guard. If the selected window is as large as the cache, the
      // store evicts pieces that are still inside the window, they get
      // refetched, and the download spins at the throttle while playback
      // starves. That shows up here as writing the file many times over.
      const pieces = Math.ceil(FILE_SIZE / PIECE_LENGTH);
      console.log(`piece writes: ${puts} for ${pieces} pieces (${(puts / pieces).toFixed(2)}x)`);
      if (puts > pieces * 1.5) {
        fail(`refetch thrash: wrote ${puts} pieces for a ${pieces}-piece file`);
      }

      // The real test: seek back into a region we evicted. RingStore.drop()
      // called torrent._markUnverified(), so WebTorrent should no longer think
      // it has these pieces and should refetch them from the seeder.
      const SEEK_FROM = 900000, SEEK_TO = 1000000;
      const seekPiece = Math.floor(SEEK_FROM / PIECE_LENGTH);
      const hadBefore = lt.bitfield.get(seekPiece);
      const inStore = store.chunks.has(seekPiece);
      console.log(`\nseek-back: piece ${seekPiece} in store=${inStore} bitfield=${hadBefore}`);
      if (inStore) fail("test is not meaningful: seek target was never evicted");
      if (hadBefore) fail("bitfield still claims a piece we evicted - refetch would never happen");

      const res2 = new FakeRes();
      const t1 = Date.now();
      await streamWindowed(lt, file, SEEK_FROM, SEEK_TO, res2, null, { readAheadPct: 95 });
      const body2 = res2.body;
      console.log(`refetched ${body2.length} bytes in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
      if (body2.length !== SEEK_TO - SEEK_FROM + 1) fail(`seek served ${body2.length} bytes`);
      if (!body2.equals(data.slice(SEEK_FROM, SEEK_TO + 1))) fail("refetched bytes are wrong");

      console.log("\nPASS: byte-exact stream, bounded memory, eviction and seek-back refetch");
      seeder.destroy(); leecher.destroy();
      process.exit(0);
    });
  });
})();
