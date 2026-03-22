const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  formatSize,
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
    });
    wtClient.on("error", (e) => console.error("WebTorrent error:", e.message));
  }
  return wtClient;
}

const manifest = {
  id: "org.filelist.stremio",
  version: "1.9.0",
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

    torrents.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    return torrents;
  } catch (e) {
    if (e.response && e.response.status === 404) return [];
    console.error("FileList API error:", e.message || e);
    return [];
  }
}

function buildStream(item, torrentId, fileIdx, episodeFileName) {
  const quality = getQualityTag(item.name || "");
  const size = formatSize(item.size);
  const seeders = item.seeders || 0;
  const packLabel = fileIdx !== null && fileIdx !== undefined ? " (Season Pack)" : "";

  let title = `${item.name}\n${size} | ${seeders} seeders`;
  if (episodeFileName) {
    title += `\nFile: ${episodeFileName}`;
  }

  const prefix = API_KEY ? `/${API_KEY}` : "";
  let url = `http://${LOCAL_IP}:${PORT}${prefix}/stream-video/${torrentId}`;
  if (fileIdx !== null && fileIdx !== undefined) {
    url += `/${fileIdx}`;
  }

  return {
    name: `FileList ${quality}${packLabel}`,
    title,
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
    // No one is watching — deselect all files to stop downloading
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
    client.add(torrentBuffer, { path: path.join(TORRENT_DIR, infoHash) }, (torrent) => {
      console.log(`Torrent started: ${torrent.name} (${torrent.files.length} files)`);

      // Deselect all files initially
      torrent.files.forEach((f) => f.deselect());

      // Stats logging — only log when actually transferring (> 10 KB/s)
      const statsInterval = setInterval(() => {
        const entry = activeTorrents.get(infoHash);
        if (!entry || entry.activeStreams === 0) return;

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

    // Select this file and track the stream
    file.select();
    onStreamStart(torrent.infoHash);

    const fileSize = file.length;
    const range = req.headers.range;

    console.log(`Streaming: ${file.name} (${formatSize(fileSize)})`);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });

      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      stream.on("error", () => res.end());
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      });

      const stream = file.createReadStream();
      stream.pipe(res);
      stream.on("error", () => res.end());
    }

    res.on("close", () => {
      onStreamEnd(torrent.infoHash);
    });
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
  res.json({ torrents });
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
  app.use(`/${API_KEY}`, validateApiKey, addonRouter);
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

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  for (const [hash] of activeTorrents) await removeTorrent(hash);
  if (wtClient) wtClient.destroy();
  process.exit();
});

