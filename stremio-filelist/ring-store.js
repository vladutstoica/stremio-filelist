// Bounded in-memory chunk store for streaming torrents.
//
// Instead of writing every piece of a film to disk, we keep only a moving
// window of pieces around the playhead in RAM and drop the rest. Peak usage is
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

    // Pieces we still want, as an inclusive index range. Updated as the
    // playhead moves; eviction prefers everything outside it.
    this.windowFrom = 0;
    this.windowTo = this.lastChunkIndex;

    registry.add(this);
  }

  setWindow(from, to) {
    this.windowFrom = Math.max(0, from);
    this.windowTo = Math.min(this.lastChunkIndex, to);
  }

  isPinned(index) {
    return index <= this.pinLow || index >= this.pinHigh;
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

    if (!opts) return process.nextTick(cb, null, buf);

    const from = opts.offset || 0;
    const to = opts.length ? from + opts.length : buf.length;
    if (from < 0 || to > buf.length) {
      return process.nextTick(cb, new Error("Invalid offset and/or length"));
    }
    process.nextTick(cb, null, buf.slice(from, to));
  }

  // Drop pieces until we are back inside our share of the global budget.
  // Preference order: behind the window, then ahead of it, then oldest.
  evict() {
    const limit = shareFor(this);
    if (this.bytes <= limit) return;

    const behind = [];
    const ahead = [];
    const rest = [];
    for (const index of this.chunks.keys()) {
      if (this.isPinned(index)) continue;
      if (index < this.windowFrom) behind.push(index);
      else if (index > this.windowTo) ahead.push(index);
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
