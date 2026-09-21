const { once } = require("events");
const { RingStore, shareFor } = require("./ring-store");

const DEFAULT_READ_AHEAD_PCT = 95;
// Backoff between re-reads of a position that yielded nothing, and the ceiling
// on how long we keep that up. Truncating the body is worse than making the
// player wait, but retrying forever holds the socket, the response object and
// this reader's window open against a piece that may never arrive -- so give up
// comfortably inside the player's own 10s stall watchdog and let it reconnect.
// Both bounds are real: the clock is the one that matters, the attempt count is
// the backstop for a clock that jumps under load or in a test.
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2000;
const MAX_STALL_MS = 5000;
const MAX_STALLS = 20;
const STALL_LOG_EVERY = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Windowed streaming ----
//
// WebTorrent's own read stream selects every piece in the range it is given,
// and Stremio opens playback with `Range: bytes=0-`, so handing it the whole
// file downloads the whole file. Instead we walk the file in windows: select a
// slice, serve it, then re-select further along as the playhead advances.

function ringStoreOf(torrent) {
  let s = torrent.store;
  while (s && !(s instanceof RingStore)) s = s.store;
  return s instanceof RingStore ? s : null;
}

// The selected window must be meaningfully smaller than the cache it lives in.
// If they are equal, the store hits its limit exactly when the window fills and
// has to evict pieces that are still inside the window -- which are then
// re-fetched, evicted again, and so on: the download pins at the throttle while
// playback starves. This leaves roughly 45% of the budget as headroom for
// pieces in flight and for what sits behind the read head. It is the share of
// the budget available to all windows together, not to one: windowFor() divides
// it by MAX_WINDOW_READERS.
const WINDOW_FRACTION = 0.55;

// How many readers may hold a window at once: a playhead, a header probe, a
// tail probe and one spare, which is the traffic shape a player actually
// produces. This caps windows, not streams -- a reader past the cap still
// streams, it just runs without read-ahead, the way a probe does.
// The divisor is this constant rather than the live reader count on
// purpose. Sizing against readerCount() meant a request that turned up later
// retroactively narrowed the window of one already streaming, and the very next
// put() then evicted read-ahead that reader had already fetched and still
// wanted -- self-inflicted eviction, no second reader's window even had to
// overlap. A window sized once and never shrunk cannot do that. The cost is
// that a lone reader leaves three shares unused; that headroom is far cheaper
// than a reader evicting its own pieces mid-stream.
const MAX_WINDOW_READERS = 4;

// How far ahead of the playhead pieces are flagged critical. Critical is what
// lets WebTorrent hotswap a piece away from a slow peer and hand it to a fast
// one (see _request in webtorrent/lib/torrent.js), and its own reader flags
// only the piece it is already stuck on: _criticalLength is
// min((1MB / pieceLength) | 0, 2), which is 0 for any torrent with pieces of
// 1MB or more -- every large film. So the rescue only ever started after
// playback had already stalled on that piece. Flagging a short band ahead of
// the read head instead means the swap happens before the reader gets there.
// Kept short on purpose: it is the next few seconds that matter, and a wide
// band would have the swarm churning reservations across the whole window.
const CRITICAL_AHEAD_BYTES = 32 * 1024 * 1024;
const CRITICAL_AHEAD_MIN_PIECES = 3;

function windowFor(store, readAheadPct) {
  // Dividing by a fixed count is what guarantees any set of live windows fits
  // the store's share together, whatever order they registered in.
  const budget = (shareFor(store) * WINDOW_FRACTION) / MAX_WINDOW_READERS;
  return {
    ahead: Math.max(store.chunkLength * 2, Math.floor((budget * readAheadPct) / 100)),
    behind: Math.max(store.chunkLength, Math.floor((budget * (100 - readAheadPct)) / 100)),
  };
}

// Resolves when the socket drains, or immediately if the client goes away.
async function waitForDrain(res) {
  const ac = new AbortController();
  try {
    await Promise.race([
      once(res, "drain", { signal: ac.signal }),
      once(res, "close", { signal: ac.signal }),
    ]);
  } catch (_) {
    // aborted
  } finally {
    ac.abort();
  }
}

// A request that only wants the container header, or only the tail -- players
// open those constantly -- sits inside the pinned region, which is never
// evicted. Such a reader needs no window, and registering one would shrink
// every other reader's share and drag the eviction bounds across the file. It
// has to be inside *one* of the two pinned regions: a whole-file request starts
// in the head and ends in the tail, and that one very much needs a window.
function isProbeRange(store, file, pieceLength, start, end) {
  if (!store) return false;
  const from = Math.floor((file.offset + start) / pieceLength);
  const to = Math.floor((file.offset + end) / pieceLength);
  return to <= store.pinLow || from >= store.pinHigh;
}

let nextToken = 1;

async function streamWindowed(torrent, file, start, end, res, entry, opts = {}) {
  const readAheadPct = opts.readAheadPct || DEFAULT_READ_AHEAD_PCT;
  const store = ringStoreOf(torrent);
  const pieceLength = torrent.pieceLength;
  const token = `reader-${nextToken++}`;
  const probe = isProbeRange(store, file, pieceLength, start, end);
  let refused = false; // logged once if this reader never gets a window
  let pos = start; // bytes handed to the socket, i.e. where the TV actually is

  const applyWindow = () => {
    if (!store || probe) return null;
    // Past MAX_WINDOW_READERS the windows would no longer fit the share
    // together, and shrinking the readers that got here first is the thrash the
    // fixed divisor exists to prevent. An excess reader runs without a window,
    // like a probe does, rather than costing everyone else their read-ahead.
    if (!store.windows.has(token) && store.readerCount() >= MAX_WINDOW_READERS) {
      // Once per reader, not once per loop: a reader running unwindowed is the
      // one state in here that looks exactly like healthy playback until it
      // stalls, so it has to leave a trace in the log.
      if (!refused) {
        refused = true;
        console.log(`No window free for ${file.name} at byte ${pos} (${store.readerCount()} readers)`);
      }
      return null;
    }
    const { ahead, behind } = windowFor(store, readAheadPct);
    const from = Math.floor((file.offset + Math.max(0, pos - behind)) / pieceLength);
    const to = Math.floor((file.offset + Math.min(end, pos + ahead)) / pieceLength);
    store.setWindow(token, from, to);

    // Flag the pieces immediately ahead of the read head, so a slow peer
    // holding one of them is swapped out before playback reaches it.
    const head = Math.floor((file.offset + pos) / pieceLength);
    const span = Math.max(CRITICAL_AHEAD_MIN_PIECES, Math.ceil(CRITICAL_AHEAD_BYTES / pieceLength));
    const criticalTo = Math.min(
      Math.floor((file.offset + end) / pieceLength),
      head + span,
    );
    if (criticalTo >= head) torrent.critical(head, criticalTo);

    // WebTorrent never clears the flag once set, so without this every piece we
    // have passed stays in hotswap mode for the life of the torrent. Clear
    // behind the read head rather than behind the window: pieces already played
    // are never worth swapping a peer for.
    for (let i = 0; i < head; i++) {
      if (torrent._critical[i]) torrent._critical[i] = false;
    }
    return { ahead, behind };
  };

  // Re-assert the window from the stats interval too: if the selection is ever
  // lost while a reader is waiting, nothing downloads, no piece I/O happens,
  // and an event-driven-only design would never recover. Every reader
  // registers: a single slot would only ever re-assert the newest request's
  // window, which is usually a probe rather than the playhead.
  if (entry && entry.reapplyWindows) entry.reapplyWindows.add(applyWindow);
  // Report where this reader actually is, so the stats line can say how far
  // through the film playback has got. torrent.progress cannot answer that: it
  // is the share of the file held in RAM, which sits at cache/filesize forever.
  const reportPos = () => {
    if (entry && entry.positions) entry.positions.set(token, { pos, end, name: file.name });
  };
  reportPos();

  let stalls = 0;
  let stalledSince = 0;
  try {
    while (pos <= end && !res.writableEnded && !res.destroyed) {
      const win = applyWindow();
      const ahead = win ? win.ahead : 64 * 1024 * 1024;
      const subEnd = Math.min(end, pos + ahead - 1);
      // Start the next window once we are halfway through this one, so the
      // selection always runs at least half a window ahead of the playhead and
      // there is no gap to stall on at the boundary.
      const refreshAt = pos + Math.max(1, Math.floor(ahead / 2));

      const sub = file.createReadStream({ start: pos, end: subEnd });
      let advanced = false;
      try {
        for await (const chunk of sub) {
          if (!res.write(chunk)) await waitForDrain(res);
          if (res.writableEnded || res.destroyed) break;
          pos += chunk.length;
          reportPos();
          advanced = true;
          if (pos > subEnd || pos >= refreshAt) break;
        }
      } finally {
        sub.destroy();
      }

      if (advanced) {
        stalls = 0;
        stalledSince = 0;
        continue;
      }
      // No bytes. WebTorrent answers a failed store read by ending the
      // iterator without an error event (see webtorrent/lib/file-iterator.js),
      // so a piece evicted between "verified" and the read looks exactly like
      // a finished stream. Breaking here would end the response with zero
      // bytes and a full Content-Length, which the player retries forever and
      // a proxy in front reports as a 5xx. Re-read the same position instead;
      // the piece is back in the picker and will be refetched.
      if (res.writableEnded || res.destroyed) break;
      stalls++;
      if (stalledSince === 0) stalledSince = Date.now();
      if (stalls % STALL_LOG_EVERY === 0) {
        console.log(`Waiting on ${file.name} at byte ${pos} (${stalls} retries)`);
      }
      if (stalls >= MAX_STALLS || Date.now() - stalledSince >= MAX_STALL_MS) {
        // Out of budget. Ending the response here would claim a body that is
        // short of the Content-Length we promised is complete; reset the
        // connection instead. A player retries a reset quickly, where a proxy
        // in front turns a truncated body into a 5xx of its own.
        console.log(`Giving up on ${file.name} at byte ${pos} after ${stalls} retries`);
        res.destroy();
        break;
      }
      await sleep(Math.min(RETRY_DELAY_MS * stalls, MAX_RETRY_DELAY_MS));
    }
  } catch (e) {
    if (!res.writableEnded && !res.destroyed) console.error("Stream read error:", e.message);
  } finally {
    if (entry && entry.reapplyWindows) entry.reapplyWindows.delete(applyWindow);
    if (entry && entry.positions) entry.positions.delete(token);
    if (store) store.clearWindow(token);
    // Not after a destroy: ending a socket we just reset would either throw or
    // signal a clean finish, and the reset is the signal we meant to send.
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

// Resolve a Range header against a known file size. A suffix range means the
// last N bytes: for `bytes=-500` the part before the dash is empty, and the
// `parseInt("") || 0` this replaces turned that into byte 0 -- serving the head
// of the file to a demuxer that asked for its tail. Single ranges only; players
// do not send multi-range asks for video.
function parseRange(range, fileSize) {
  if (!range) return { start: 0, end: fileSize - 1 };

  // Anything we cannot read is unsatisfiable: a start past the end of the file
  // makes the caller's own 416 check reject it. Handing back NaN instead would
  // slip through that check -- every comparison against NaN is false -- and end
  // up in `Content-Length: NaN` on the wire, which is not a response a proxy
  // can make sense of.
  const unsatisfiable = { start: fileSize, end: fileSize - 1 };

  const parts = String(range).replace(/bytes=/, "").split("-");
  if (parts[0].trim() === "") {
    const suffix = parseInt(parts[1], 10);
    // A zero-length or unreadable suffix asks for nothing.
    if (!Number.isFinite(suffix) || suffix <= 0) return unsatisfiable;
    return { start: Math.max(0, fileSize - suffix), end: fileSize - 1 };
  }

  const start = parseInt(parts[0], 10);
  if (!Number.isFinite(start) || start < 0) return unsatisfiable;
  // An absent second bound means "to the end"; an unreadable one is a
  // malformed ask, not an open-ended one.
  if (parts[1] === undefined || parts[1].trim() === "") {
    return { start, end: fileSize - 1 };
  }
  const end = parseInt(parts[1], 10);
  if (!Number.isFinite(end)) return unsatisfiable;
  return { start, end };
}

module.exports = {
  streamWindowed,
  ringStoreOf,
  windowFor,
  isProbeRange,
  parseRange,
  WINDOW_FRACTION,
  MAX_WINDOW_READERS,
};
