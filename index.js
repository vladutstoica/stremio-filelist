const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { setCapacity, stats: cacheStats, PIN_BYTES, RingStore } = require("./ring-store");
const { streamWindowed } = require("./window-stream");
const {
  formatSize,
  qualityBadge,
  compareReleases,
  releaseFlags,
  releaseHeadline,
  releaseSpecs,
  parseRelease,
  getQualityTag,
  getSeasonFromName,
  getEpisodeFromName,
  isSeasonPack,
  findEpisodeFile,
} = require("./helpers");

// Load .env file if present
try { require("dotenv").config(); } catch (_) {}

// Load Home Assistant add-on options if available
const HA_OPTIONS_PATH = "/data/options.json";
try {
  if (fs.existsSync(HA_OPTIONS_PATH)) {
    const opts = JSON.parse(fs.readFileSync(HA_OPTIONS_PATH, "utf8"));
    if (opts.FILELIST_USER) process.env.FILELIST_USER = opts.FILELIST_USER;
    if (opts.FILELIST_PASSKEY) process.env.FILELIST_PASSKEY = opts.FILELIST_PASSKEY;
    if (opts.API_KEY) process.env.API_KEY = opts.API_KEY;
    if (opts.BASE_URL) process.env.BASE_URL = opts.BASE_URL;
    if (opts.CACHE_SIZE_MB) process.env.CACHE_SIZE_MB = String(opts.CACHE_SIZE_MB);
    if (opts.READ_AHEAD_PCT) process.env.READ_AHEAD_PCT = String(opts.READ_AHEAD_PCT);
    if (opts.DOWNLOAD_LIMIT_MBPS) process.env.DOWNLOAD_LIMIT_MBPS = String(opts.DOWNLOAD_LIMIT_MBPS);
    if (opts.MAX_CONNS) process.env.MAX_CONNS = String(opts.MAX_CONNS);
  }
} catch (_) {}

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

const FILELIST_USER = process.env.FILELIST_USER;
const FILELIST_PASSKEY = process.env.FILELIST_PASSKEY;
const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || "0.0.0.0";
const TORRENT_DIR = process.env.TORRENT_DIR || path.join(os.tmpdir(), "stremio-filelist");
const API_KEY = process.env.API_KEY || "";
const BASE_URL = process.env.BASE_URL || ""; // e.g. https://stremio.example.com

// Streaming window. We hold only a moving slice of the film in RAM and drop
// the rest, so peak usage is the window size rather than the file size.
const CACHE_SIZE_MB = Number(process.env.CACHE_SIZE_MB) || 500;
const READ_AHEAD_PCT = Math.min(99, Math.max(50, Number(process.env.READ_AHEAD_PCT) || 95));
const DOWNLOAD_LIMIT_MBPS = Number(process.env.DOWNLOAD_LIMIT_MBPS) || 8;
const MAX_CONNS = Number(process.env.MAX_CONNS) || 20;
setCapacity(CACHE_SIZE_MB * 1024 * 1024);

// Detect local network IP for stream URLs
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
const LOCAL_IP = process.env.LOCAL_IP || getLocalIP();

let parseTorrent;
let WebTorrent;
const modulesReady = Promise.all([
  import("parse-torrent").then((m) => { parseTorrent = m.default; }),
  import("webtorrent").then((m) => { WebTorrent = m.default; }),
]).catch((e) => { console.error("Failed to load modules:", e); });

// qBittorrent 5.1.0 peer ID (whitelisted on FileList)
function makeQBPeerId() {
  const prefix = Buffer.from("-qB5100-");
  const random = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) random[i] = Math.floor(Math.random() * 256);
  return Buffer.concat([prefix, random]);
}

let wtClient;
async function getClient() {
  await modulesReady;
  if (!wtClient) {
    wtClient = new WebTorrent({
      dht: false,
      lsd: false,
      peerId: makeQBPeerId(),
      maxConns: MAX_CONNS,
    });
    // Cap the fetch rate at a few times the video bitrate. Unthrottled, the
    // swarm delivers 25-39 MB/s, which the Green's eMMC cannot absorb: dirty
    // pages pile up until the kernel forces a synchronous flush that blocks
    // every other writer, including Home Assistant's recorder.
    wtClient.throttleDownload(DOWNLOAD_LIMIT_MBPS * 1024 * 1024);
    wtClient.on("error", (e) => console.error("WebTorrent error:", e.message));
  }
  return wtClient;
}

const manifest = {
  id: "org.filelist.stremio",
  version: "1.12.3",
  name: "FileList",
  description: "Stream torrents from FileList.io",
  types: ["movie", "series"],
  resources: ["stream"],
  catalogs: [],
  idPrefixes: ["tt"],
};

const builder = new addonBuilder(manifest);

const MOVIE_CATEGORIES = [1, 4, 19, 6, 2];
const SERIES_CATEGORIES = [21, 23];

// Parse .torrent file from FileList
async function fetchTorrentMeta(downloadLink) {
  try {
    await modulesReady;
    const res = await axios.get(downloadLink, { responseType: "arraybuffer" });
    const buf = Buffer.from(res.data);
    const torrent = await parseTorrent(buf);
    return { files: torrent.files || [], buffer: buf };
  } catch (e) {
    console.error("Failed to fetch/parse .torrent:", e.message);
    return null;
  }
}

async function searchFileList(imdbId, categories) {
  if (!FILELIST_USER || !FILELIST_PASSKEY) {
    console.error("Missing FILELIST_USER or FILELIST_PASSKEY in env.");
    return [];
  }

  try {
    const res = await axios.get("https://filelist.io/api.php", {
      params: {
        username: FILELIST_USER,
        passkey: FILELIST_PASSKEY,
        action: "search-torrents",
        type: "imdb",
        query: imdbId,
        category: categories.join(","),
      },
    });

    const torrents = res.data;
    if (!Array.isArray(torrents)) return [];

    torrents.sort(compareReleases);
    return torrents;
  } catch (e) {
    if (e.response && e.response.status === 404) return [];
    console.error("FileList API error:", e.message || e);
    return [];
  }
}

function buildStream(item, torrentId, fileIdx, episodeFileName) {
  const raw = item.name || "";
  const quality = qualityBadge(raw);
  const size = formatSize(item.size);
  const seeders = item.seeders || 0;
  const isPack = fileIdx !== null && fileIdx !== undefined;
  const parsed = parseRelease(raw);

  // Scene names like Moana.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo are what
  // Stremio would otherwise show verbatim. Split them into a readable headline,
  // a specs line, and a stats line.
  const flags = releaseFlags(item);
  const headline =
    releaseHeadline(raw) +
    (isPack ? " · Season Pack" : "") +
    (flags.length ? `  ${flags.join(" ")}` : "");
  const specs = releaseSpecs(raw);

  const stats = [size, `\u{1F464} ${seeders}`];
  if (parsed && parsed.service) stats.push(parsed.service);
  if (parsed && parsed.group) stats.push(parsed.group);

  const lines = [headline];
  if (specs) lines.push(specs);
  lines.push(stats.join(" \u00B7 "));
  if (episodeFileName) lines.push(`File: ${episodeFileName}`);
  const description = lines.join("\n");

  const prefix = API_KEY ? `/${API_KEY}` : "";
  const base = BASE_URL ? BASE_URL.replace(/\/$/, "") : `http://${LOCAL_IP}:${PORT}`;
  let url = `${base}${prefix}/stream-video/${torrentId}`;
  if (fileIdx !== null && fileIdx !== undefined) {
    url += `/${fileIdx}`;
  }

  return {
    name: `FileList\n${quality}`,
    // Exactly one of `title` / `description` may be sent. Stremio's client
    // declares `description` with `alias = "title"`, and serde rejects a
    // duplicate field when both appear -- the stream then fails to
    // deserialize and the whole list comes back empty. `title` is the older
    // name and is accepted by both old and current clients via that alias.
    title: description,
    url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `filelist-${item.id}`,
    },
  };
}

// ---- Torrent streaming ----
const torrentCache = new Map(); // torrentId -> Buffer
const activeTorrents = new Map(); // infoHash -> { torrent, timeout, statsInterval, activeStreams }
const IS_HA = fs.existsSync("/data/options.json");
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes after last stream closes

// Clean up leftover downloads on startup
try {
  if (fs.existsSync(TORRENT_DIR)) {
    fs.rmSync(TORRENT_DIR, { recursive: true, force: true });
    console.log(`Cleaned up old downloads: ${TORRENT_DIR}`);
  }
  fs.mkdirSync(TORRENT_DIR, { recursive: true });
} catch (e) {
  console.error("Cleanup error:", e.message);
}

async function getTorrentBuffer(torrentId) {
  if (torrentCache.has(torrentId)) return torrentCache.get(torrentId);

  const url = `https://filelist.io/download.php?id=${torrentId}&passkey=${FILELIST_PASSKEY}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const buf = Buffer.from(res.data);
  torrentCache.set(torrentId, buf);
  return buf;
}

function onStreamStart(infoHash) {
  const entry = activeTorrents.get(infoHash);
  if (!entry) return;
  entry.activeStreams++;
  clearTimeout(entry.timeout); // Cancel any pending cleanup
}

function onStreamEnd(infoHash) {
  const entry = activeTorrents.get(infoHash);
  if (!entry) return;
  entry.activeStreams = Math.max(0, entry.activeStreams - 1);

  if (entry.activeStreams === 0) {
    // No one is watching. The reader's own selections are dropped when its
    // stream is destroyed; this just catches anything that leaked.
    entry.torrent.files.forEach((f) => f.deselect());
    console.log(`Paused: ${entry.torrent.name} (no active streams)`);

    // Schedule cleanup
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => removeTorrent(infoHash), IDLE_TIMEOUT);
  }
}

async function removeTorrent(infoHash) {
  const entry = activeTorrents.get(infoHash);
  if (entry) {
    clearTimeout(entry.timeout);
    clearInterval(entry.statsInterval);
    const client = await getClient();
    client.remove(infoHash, { destroyStore: true });
    activeTorrents.delete(infoHash);
    console.log(`Removed and cleaned up: ${entry.torrent.name}`);
  }
}

async function startTorrent(torrentBuffer) {
  const client = await getClient();
  await modulesReady;
  const meta = await parseTorrent(torrentBuffer);
  const infoHash = meta.infoHash;

  // Already active?
  if (activeTorrents.has(infoHash)) {
    clearTimeout(activeTorrents.get(infoHash).timeout);
    const existing = client.get(infoHash);
    if (existing) return existing;
  }

  return new Promise((resolve, reject) => {
    const addOpts = {
      path: path.join(TORRENT_DIR, infoHash),
      // Nothing is selected until a stream asks for it. This is also what makes
      // eviction safe: RingStore calls torrent._markUnverified() on drop, and
      // that re-selects the piece unless the torrent started deselected --
      // which would download and evict the same piece forever.
      deselect: true,
      strategy: "sequential",
      store: RingStore,
      storeOpts: { pinBytes: PIN_BYTES },
      // Our store is already in RAM; WebTorrent's read cache would just hold a
      // second copy of 20 pieces on top of our budget.
      storeCacheSlots: 0,
      destroyStoreOnDestroy: true,
    };
    client.add(torrentBuffer, addOpts, (torrent) => {
      console.log(`Torrent started: ${torrent.name} (${torrent.files.length} files)`);

      // Stats logging — only log when actually transferring (> 10 KB/s)
      const statsInterval = setInterval(() => {
        const entry = activeTorrents.get(infoHash);
        if (!entry || entry.activeStreams === 0) return;

        // Watchdog: re-assert the piece window. Eviction is driven by piece
        // I/O, so a lost selection would mean no downloads, no I/O, no
        // cleanup, and a stall that never recovers on its own.
        if (entry.reapplyWindow) entry.reapplyWindow();

        if (torrent.downloadSpeed > 10240 || torrent.uploadSpeed > 10240) {
          const peers = torrent.numPeers;
          const down = (torrent.downloadSpeed / 1024 / 1024).toFixed(1);
          const up = (torrent.uploadSpeed / 1024 / 1024).toFixed(1);
          const progress = (torrent.progress * 100).toFixed(1);
          console.log(`[${torrent.name.substring(0, 40)}] Peers: ${peers} | Down: ${down} MB/s | Up: ${up} MB/s | Progress: ${progress}%`);
        }
      }, 5000);

      activeTorrents.set(infoHash, {
        torrent,
        timeout: null,
        statsInterval,
        activeStreams: 0,
        reapplyWindow: null,
      });

      resolve(torrent);
    });

    setTimeout(() => reject(new Error("Torrent add timeout")), 30000);
  });
}

// API key validation middleware
function validateApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.params.apiKey === API_KEY) return next();
  res.status(403).json({ error: "Forbidden" });
}

// HTTP streaming endpoint (with optional API key prefix)
const streamPath = API_KEY ? "/:apiKey/stream-video/:torrentId/:fileIdx?" : "/stream-video/:torrentId/:fileIdx?";
app.get(streamPath, validateApiKey, async (req, res) => {
  const { torrentId } = req.params;
  const fileIdx = req.params.fileIdx ? parseInt(req.params.fileIdx, 10) : null;

  try {
    const torrentBuffer = await getTorrentBuffer(torrentId);
    const torrent = await startTorrent(torrentBuffer);

    let file;
    if (fileIdx !== null && fileIdx < torrent.files.length) {
      file = torrent.files[fileIdx];
    } else {
      // Pick largest file
      file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    }

    // No file.select() here: selecting the file downloads all of it. The
    // windowed reader below selects only the slice around the playhead.
    onStreamStart(torrent.infoHash);

    const fileSize = file.length;
    const range = req.headers.range;

    let start = 0;
    let end = fileSize - 1;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      onStreamEnd(torrent.infoHash);
      return;
    }

    console.log(`Streaming: ${file.name} (${formatSize(fileSize)}) bytes ${start}-${end}`);

    if (range) {
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
      });
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      });
    }

    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      onStreamEnd(torrent.infoHash);
    };
    res.on("close", finish);

    await streamWindowed(torrent, file, start, end, res, activeTorrents.get(torrent.infoHash), {
      readAheadPct: READ_AHEAD_PCT,
    });
    finish();
  } catch (e) {
    console.error("Stream error:", e.message);
    res.status(500).send("Failed to stream");
  }
});

// ---- Status endpoint ----
const statusPath = API_KEY ? "/:apiKey/status" : "/status";
app.get(statusPath, validateApiKey, (req, res) => {
  const torrents = [];
  for (const [infoHash, entry] of activeTorrents) {
    const t = entry.torrent;
    let state = "downloading";
    if (entry.activeStreams === 0 && entry.timeout) state = "paused";
    else if (entry.activeStreams === 0) state = "idle";

    torrents.push({
      name: t.name,
      infoHash,
      state,
      progress: Math.round(t.progress * 1000) / 10,
      downloadSpeed: Math.round(t.downloadSpeed / 1024),
      uploadSpeed: Math.round(t.uploadSpeed / 1024),
      peers: t.numPeers,
      activeStreams: entry.activeStreams,
    });
  }
  const c = cacheStats();
  res.json({
    torrents,
    cache: {
      streams: c.stores,
      usedMB: Math.round((c.bytes / 1048576) * 10) / 10,
      capacityMB: Math.round(c.capacity / 1048576),
    },
  });
});

// ---- Stremio handler ----
builder.defineStreamHandler(async ({ type, id }) => {
  const parts = id.split(":");
  const imdbId = parts[0];
  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  const categories = type === "series" ? SERIES_CATEGORIES : MOVIE_CATEGORIES;

  const torrents = await searchFileList(imdbId, categories);
  const streams = [];

  for (const torrent of torrents) {
    const name = torrent.name || "";
    const torrentId = String(torrent.id);

    if (type === "series" && season && episode) {
      const ep = getEpisodeFromName(name);

      if (ep) {
        if (ep.season === season && ep.episode === episode) {
          try { await getTorrentBuffer(torrentId); } catch (_) {}
          streams.push(buildStream(torrent, torrentId));
        }
        continue;
      }

      const torrentSeason = getSeasonFromName(name);
      if (torrentSeason !== null && torrentSeason !== season) continue;

      if (isSeasonPack(name)) {
        const meta = await fetchTorrentMeta(torrent.download_link);
        if (meta) {
          torrentCache.set(torrentId, meta.buffer);
          const match = findEpisodeFile(meta.files, season, episode);
          if (match) {
            streams.push(buildStream(torrent, torrentId, match.idx, match.name));
          }
        }
      }
    } else {
      try { await getTorrentBuffer(torrentId); } catch (_) {}
      streams.push(buildStream(torrent, torrentId));
    }
  }

  return { streams };
});

const addonRouter = getRouter(builder.getInterface());
if (API_KEY) {
  app.use(`/${API_KEY}`, addonRouter);
} else {
  app.use(addonRouter);
}

app.listen(PORT, HOST, () => {
  const prefix = API_KEY ? `/${API_KEY}` : "";
  console.log(`FileList addon running on ${HOST}:${PORT}`);
  console.log(`Install in Stremio (this PC):   http://127.0.0.1:${PORT}${prefix}/manifest.json`);
  console.log(`Install in Stremio (network):   http://${LOCAL_IP}:${PORT}${prefix}/manifest.json`);
  if (API_KEY) console.log(`API key auth enabled`);
  console.log(`Downloads: ${TORRENT_DIR}`);
});

// Prevent crash from tracker abort errors during cleanup
process.on("uncaughtException", (err) => {
  if (err.name === "AbortError") {
    console.log("Tracker request aborted (expected during cleanup)");
    return;
  }
  console.error("Uncaught exception:", err);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  for (const [hash] of activeTorrents) await removeTorrent(hash);
  if (wtClient) wtClient.destroy();
  process.exit();
});

