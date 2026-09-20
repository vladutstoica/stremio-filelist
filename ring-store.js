// Bounded in-memory chunk store for streaming torrents.
//
// Instead of writing every piece of a film to disk, we keep only a moving
// window of pieces around each reader's position in RAM and drop the rest. Peak usage is
// the window size, not the file size, so a 4K remux costs the same as an
// episode and nothing ever touches the Home Assistant Green's eMMC.
//
// Implements the abstract-chunk-store API so it can be passed to WebTorrent as
// `opts.store`. See node_modules/fs-chunk-store/index.js for the reference
// implementation of the same contract.

const DEFAULT_CAPACITY = 500 * 1024 * 1024; // total across all active torrents
const PIN_BYTES = 8 * 1024 * 1024; // never evict this much at file head/tail

// Every live store shares one global budget: two people streaming different
// films get half a window each rather than two full windows. TorrServer keeps
// its cache per-torrent, which on a 4 GB box would let N streams claim N times
// the memory.
const registry = new Set();
let totalCapacity = DEFAULT_CAPACITY;

function setCapacity(bytes) {
  // No floor here on purpose: shareFor() already guarantees each store enough
  // room for a few pieces, and a global floor would silently ignore the
  // configured value.
  totalCapacity = Math.max(1, Math.floor(bytes));
}

function shareFor(store) {
  const n = registry.size || 1;
  return Math.max(store.chunkLength * 4, Math.floor(totalCapacity / n));
}

function stats() {
  let bytes = 0;
  for (const s of registry) bytes += s.bytes;
  return { stores: registry.size, bytes, capacity: totalCapacity };
}

class RingStore {
  constructor(chunkLength, opts = {}) {
    this.chunkLength = Number(chunkLength);
    if (!this.chunkLength) throw new Error("First argument must be a chunk length");

    this.length = Number(opts.length) || 0;
    this.torrent = opts.torrent || null;
    this.closed = false;

    this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
    this.lastChunkLength = this.length % this.chunkLength || this.chunkLength;

    this.chunks = new Map(); // index -> Buffer, in insertion order
    this.bytes = 0;

    // Pin the start and end of the file. Players read the container header and
    // (for MP4s with a trailing moov atom, or MKV cues) the tail before and
    // during playback; evicting either turns a working stream unplayable.
    const totalChunks = this.lastChunkIndex + 1;
    const pinBytes = opts.pinBytes !== undefined ? opts.pinBytes : PIN_BYTES;
    const pinCount = Math.min(
      Math.max(1, Math.ceil(pinBytes / this.chunkLength)),
      Math.max(1, Math.floor(totalChunks / 4)),
    );
    this.pinLow = pinCount - 1;
    this.pinHigh = this.lastChunkIndex - pinCount + 1;

    // Pieces we still want, as one inclusive index range per reader. Players
    // keep several requests open at once (a header probe, a tail probe, the
    // playhead), and a single shared range would mean the newest request
    // decides what the playhead is allowed to keep -- which evicts the
    // read-ahead it is about to need.
    this.windows = new Map(); // reader token -> { from, to }

    // Pieces a read is in flight on, index -> readers waiting. Defence in
    // depth, not the cure: the read that matters most -- the one WebTorrent
    // issues after its bitfield said the piece is verified -- races eviction
    // before it ever reaches get(), and nothing here can see that coming; the
    // reader's retry is what covers it. What this does buy is that a piece
    // stays in the map for as long as a read is outstanding on it, so a second
    // reader landing on the same piece in the same tick still finds it.
    this.pending = new Map();

    registry.add(this);
  }

  setWindow(token, from, to) {
    this.windows.set(token, {
      from: Math.max(0, from),
      to: Math.min(this.lastChunkIndex, to),
    });
  }

  clearWindow(token) {
    this.windows.delete(token);
  }

  readerCount() {
    return this.windows.size;
  }

  // A piece is wanted if any reader's window covers it. With no reader
  // registered nothing is outside the window, which keeps eviction falling
  // back to insertion order.
  inWindow(index) {
    if (this.windows.size === 0) return true;
    for (const { from, to } of this.windows.values()) {
      if (index >= from && index <= to) return true;
    }
    return false;
  }

  isPinned(index) {
    return index <= this.pinLow || index >= this.pinHigh;
  }

  // Counted rather than a plain set: two readers can wait on the same piece,
  // and the first one finishing must not unpin it for the second.
  acquirePending(index) {
    this.pending.set(index, (this.pending.get(index) || 0) + 1);
  }

  releasePending(index) {
    const n = this.pending.get(index);
    if (n === undefined) return;
    if (n > 1) this.pending.set(index, n - 1);
    else this.pending.delete(index);
  }

  put(index, buf, cb = () => {}) {
    if (this.closed) return process.nextTick(cb, new Error("Storage is closed"));

    const expected = index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength;
    if (buf.length !== expected) {
      return process.nextTick(cb, new Error(`Chunk length must be ${expected}`));
    }

    if (this.chunks.has(index)) this.bytes -= this.chunks.get(index).length;
    // Re-inserting moves the key to the end of the Map, which is what gives us
    // insertion order as a last-resort eviction tiebreak.
    this.chunks.delete(index);
    this.chunks.set(index, buf);
    this.bytes += buf.length;

    this.evict();
    process.nextTick(cb, null);
  }

  get(index, opts, cb) {
    if (typeof opts === "function") return this.get(index, null, opts);
    if (!cb) cb = () => {};
    if (this.closed) return process.nextTick(cb, new Error("Storage is closed"));

    const buf = this.chunks.get(index);
    if (!buf) {
      // Evicted. We call torrent._markUnverified() on eviction so WebTorrent
      // knows it no longer has the piece and refetches it, which means we
      // should rarely land here.
      return process.nextTick(cb, new Error(`Chunk ${index} not in window`));
    }

    // Hold the piece until the reader has actually taken it. This read itself is
    // safe either way -- `buf` above is a live reference and survives eviction
    // -- but keeping the index out of evict()'s reach means a concurrent reader
    // asking for the same piece this tick is not told it is gone. The release
    // has to happen in a finally: a throwing callback that left the index
    // pinned would cost us that piece's worth of budget for the life of the
    // torrent.
    this.acquirePending(index);
    process.nextTick(() => {
      try {
        if (!opts) return cb(null, buf);

        const from = opts.offset || 0;
        const to = opts.length ? from + opts.length : buf.length;
        if (from < 0 || to > buf.length) {
          return cb(new Error("Invalid offset and/or length"));
        }
        cb(null, buf.slice(from, to));
      } finally {
        this.releasePending(index);
      }
    });
  }

  // Drop pieces until we are back inside our share of the global budget.
  // Preference order: behind every window, then ahead of every window (a piece
  // sitting in a gap between two windows counts as ahead), then inside one,
  // furthest from the reader first. A piece with a read in flight is never
  // dropped, whichever bucket it would have fallen into.
  evict() {
    const limit = shareFor(this);
    if (this.bytes <= limit) return;

    // Behind means behind every reader; ahead means ahead of every reader. With
    // no reader registered the whole file counts as wanted, as it did when the
    // window was a single range defaulting to the entire file.
    let low = 0;
    let high = this.lastChunkIndex;
    if (this.windows.size > 0) {
      low = Infinity;
      high = -Infinity;
      for (const { from, to } of this.windows.values()) {
        if (from < low) low = from;
        if (to > high) high = to;
      }
    }

    const behind = [];
    const ahead = [];
    const rest = [];
    for (const index of this.chunks.keys()) {
      if (this.isPinned(index)) continue;
      // A read is already queued against this piece; dropping it now is exactly
      // the race the pending map exists for. If skipping them all leaves us
      // over the limit we stay over it until those reads finish -- a few pieces
      // of overshoot for one tick, rather than pulling a buffer out from under
      // a reader. The loop below is a single pass either way, so eviction
      // always terminates having freed whatever it could.
      if (this.pending.has(index)) continue;
      if (index < low) behind.push(index);
      else if (index > high) ahead.push(index);
      else if (!this.inWindow(index)) ahead.push(index); // between two windows
      else rest.push(index);
    }
    behind.sort((a, b) => a - b); // furthest behind the playhead first
    ahead.sort((a, b) => b - a); // furthest ahead of the window first
    // If we must drop something still inside the window, drop the piece the
    // reader will reach last. Map order is insertion order, which is *nearest*
    // the playhead -- exactly what is about to be read.
    rest.sort((a, b) => b - a);

    for (const index of behind.concat(ahead, rest)) {
      if (this.bytes <= limit) break;
      this.drop(index);
    }
  }

  drop(index) {
    const buf = this.chunks.get(index);
    if (!buf) return;
    this.chunks.delete(index);
    this.bytes -= buf.length;

    // Tell WebTorrent the piece is gone so it re-enters the picker and a
    // backward seek refetches it instead of erroring. This only behaves if the
    // torrent was added with `deselect: true` — otherwise _markUnverified
    // re-selects the piece we just dropped and we download/evict forever.
    const t = this.torrent;
    if (!t || typeof t._markUnverified !== "function") return;
    try {
      if (t.bitfield && t.bitfield.get(index)) t._markUnverified(index);
      // Tell peers we no longer hold the piece. Without this they still count
      // it against us: once we have announced HAVE for every piece they treat
      // us as a seed and choke us, and we can never refetch anything. The
      // extension no-ops against peers that do not support it.
      for (const wire of t.wires || []) {
        if (wire.lt_donthave) wire.lt_donthave.donthave(index);
      }
    } catch (e) {
      // A torrent torn down mid-eviction is expected; anything else is not.
      if (!t.destroyed) console.error(`RingStore: markUnverified(${index}) failed:`, e.message);
    }
  }

  close(cb = () => {}) {
    if (this.closed) return process.nextTick(cb, new Error("Storage is closed"));
    this.closed = true;
    registry.delete(this);
    this.windows.clear();
    this.pending.clear();
    this.chunks.clear();
    this.bytes = 0;
    this.torrent = null;
    process.nextTick(cb, null);
  }

  destroy(cb) {
    this.close(cb);
  }
}

module.exports = { RingStore, setCapacity, shareFor, stats, DEFAULT_CAPACITY, PIN_BYTES };
