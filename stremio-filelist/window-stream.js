const { once } = require("events");
const { RingStore, shareFor } = require("./ring-store");

const DEFAULT_READ_AHEAD_PCT = 95;

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

function windowFor(store, readAheadPct) {
  const share = shareFor(store);
  return {
    ahead: Math.max(store.chunkLength * 2, Math.floor((share * readAheadPct) / 100)),
    behind: Math.max(store.chunkLength, Math.floor((share * (100 - readAheadPct)) / 100)),
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

async function streamWindowed(torrent, file, start, end, res, entry, opts = {}) {
  const readAheadPct = opts.readAheadPct || DEFAULT_READ_AHEAD_PCT;
  const store = ringStoreOf(torrent);
  const pieceLength = torrent.pieceLength;
  let pos = start; // bytes handed to the socket, i.e. where the TV actually is

  const applyWindow = () => {
    if (!store) return null;
    const { ahead, behind } = windowFor(store, readAheadPct);
    const from = Math.floor((file.offset + Math.max(0, pos - behind)) / pieceLength);
    const to = Math.floor((file.offset + Math.min(end, pos + ahead)) / pieceLength);
    store.setWindow(from, to);
    // WebTorrent flags a piece critical when a read stream waits on it and
    // never clears the flag, so without this every piece we ever waited on
    // stays in duplicate-request mode for the life of the torrent.
    for (let i = 0; i < from; i++) {
      if (torrent._critical[i]) torrent._critical[i] = false;
    }
    return { ahead, behind };
  };

  // Re-assert the window from the stats interval too: if the selection is ever
  // lost while a reader is waiting, nothing downloads, no piece I/O happens,
  // and an event-driven-only design would never recover.
  if (entry) entry.reapplyWindow = applyWindow;

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
          advanced = true;
          if (pos > subEnd || pos >= refreshAt) break;
        }
      } finally {
        sub.destroy();
      }
      if (!advanced) break; // no progress: client gone or read failed
    }
  } catch (e) {
    if (!res.writableEnded && !res.destroyed) console.error("Stream read error:", e.message);
  } finally {
    if (entry) entry.reapplyWindow = null;
    if (!res.writableEnded) res.end();
  }
}

module.exports = { streamWindowed, ringStoreOf, windowFor };
