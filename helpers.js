const ptt = require("parse-torrent-title");

// FileList carries standard scene/P2P release names, which parse-torrent-title
// already understands. Two things it does not cover, both common on the
// Romanian TV releases FileList hosts:

// 1. Episode ranges. "S01E31-E33" parses as episode 31 with the range dropped.
ptt.addHandler(({ title, result }) => {
  const m = title.match(/S\d{1,3}E\d{1,3}[-.\s]?E(\d{1,3})/i);
  if (m) result.episodeEnd = parseInt(m[1], 10);
});

// 2. Episode titles sitting between the episode marker and the first technical
//    token, e.g. Las.Fierbinti.S30E02.Fantoma.Partea.2.1080p.VOYO.WEB-DL...
//    Walk tokens and stop at the first technical one: a lazy regex happily
//    swallows "1080p ANTP" when there is no episode title at all.
const TECHNICAL = /^(\d{3,4}p|4k|uhd|web-?dl|webrip|bluray|blu-ray|hdtv|bdrip|brrip|remux|dvdrip|hdrip|x26[45]|h\.?26[45]|hevc|avc|av1|xvid|ddp?\d?|aac\d?|dts|truehd|ac3|eac3|flac|opus|atmos|hdr\d*\+?|dovi|dv|hlg|sdr|amzn|atvp|nf|dsnp|hmax|max|ma|hulu|antp|voyo|proper|repack|extended|unrated|remastered|internal|multi|ro|rom(anian)?)$/i;

ptt.addHandler(({ title, result }) => {
  if (result.season === undefined || result.episodeName) return;
  const marker = title.match(
    /(?:^|[.\s_])(S\d{1,3}(?:E\d{1,3}(?:[-.\s]?E\d{1,3})?)?)(?=[.\s_]|$)/i,
  );
  if (!marker) return;
  const rest = title.slice(marker.index + marker[0].length).replace(/^[.\s_-]+/, "");
  const words = [];
  for (const token of rest.split(/[.\s_]+/)) {
    if (!token || TECHNICAL.test(token)) break;
    words.push(token);
  }
  if (words.length) result.episodeName = words.join(" ");
});

const SOURCE_LABELS = {
  "web-dl": "WEB-DL", webdl: "WEB-DL", webrip: "WEBRip", bluray: "BluRay",
  bdrip: "BDRip", brrip: "BRRip", hdtv: "HDTV", dvdrip: "DVDRip", hdrip: "HDRip",
};
const CODEC_LABELS = {
  h264: "H.264", h265: "H.265", x264: "x264", x265: "x265",
  avc: "AVC", hevc: "HEVC", av1: "AV1", xvid: "XviD",
};
const AUDIO_LABELS = {
  ddp: "DDP", dd: "DD", "dd+": "DD+", aac: "AAC", ac3: "AC3", eac3: "EAC3",
  dts: "DTS", "dts-hd": "DTS-HD", "dts-hd-ma": "DTS-HD MA", "dts-x": "DTS:X",
  truehd: "TrueHD", flac: "FLAC", opus: "Opus", atmos: "Atmos",
};

// Release names are convention, not a standard, so every one of these falls
// back to the raw name rather than showing something wrong or empty.
function parseRelease(name) {
  if (!name) return null;
  try {
    return ptt.parse(name);
  } catch (_) {
    return null;
  }
}

// "Moana (2026)" / "Las Fierbinti S30E02 - Fantoma Partea 2"
function releaseHeadline(name) {
  const p = parseRelease(name);
  if (!p || !p.title) return name || "";

  if (p.season !== undefined) {
    const se = String(p.season).padStart(2, "0");
    // A season with no episode is a season pack (Insula.Iubirii.S03.720p...).
    // Dropping the season made every season of a show look identical.
    let out =
      p.episode === undefined
        ? `${p.title} S${se}`
        : `${p.title} S${se}E${String(p.episode).padStart(2, "0")}` +
          (p.episodeEnd ? `-E${String(p.episodeEnd).padStart(2, "0")}` : "");
    if (p.episodeName) out += ` - ${p.episodeName}`;
    return out;
  }
  return p.year ? `${p.title} (${p.year})` : p.title;
}

// "2160p · WEB-DL · H.265 · DDP5.1 Atmos · DV HDR · Extended"
function releaseSpecs(name) {
  const p = parseRelease(name);
  if (!p) return "";
  const parts = [];

  if (p.resolution) parts.push(p.resolution);
  if (p.source) {
    const src = SOURCE_LABELS[p.source.toLowerCase()] || p.source.toUpperCase();
    parts.push(p.remux ? `${src} REMUX` : src);
  } else if (p.remux) {
    parts.push("REMUX");
  }
  if (p.codec) parts.push(CODEC_LABELS[p.codec.toLowerCase()] || p.codec.toUpperCase());

  const audioList = p.audiolist || (p.audio ? [p.audio] : []);
  const primary = audioList.filter((a) => a.toLowerCase() !== "atmos");
  let audio = primary.map((a) => AUDIO_LABELS[a.toLowerCase()] || a.toUpperCase()).join("/");
  // ptt gives 2.0 as the number 2; "AAC2" reads wrong where "AAC2.0" does not.
  if (audio && p.channels) {
    const ch = Number.isInteger(p.channels) ? `${p.channels}.0` : String(p.channels);
    // Short codes read fine run together (DDP5.1), longer ones do not
    // (DTS-HD MA 5.1, TrueHD 7.1).
    audio += audio.length > 4 || audio.includes(" ") ? ` ${ch}` : ch;
  }
  if (audioList.some((a) => a.toLowerCase() === "atmos")) audio = `${audio} Atmos`.trim();
  if (audio) parts.push(audio);

  const color = p.colorlist || (p.color ? [p.color] : []);
  if (color.length) parts.push(color.join(" "));

  const editions = [];
  if (p.extended) editions.push("Extended");
  if (p.unrated) editions.push("Unrated");
  if (p.directorsCut) editions.push("Director's Cut");
  if (p.remastered) editions.push("Remastered");
  if (p.proper) editions.push("PROPER");
  if (p.repack) editions.push("REPACK");
  if (editions.length) parts.push(editions.join(" "));

  return parts.join(" · ");
}

// Tracker flags from the FileList API. Values arrive as 0/1 and have been seen
// as both numbers and strings, so test loosely.
function isSet(v) {
  return v === 1 || v === "1" || v === true;
}

// Badges worth showing next to a release. Freeleech matters most: it does not
// count against your ratio.
function releaseFlags(item) {
  if (!item) return [];
  const flags = [];
  if (isSet(item.freeleech)) flags.push("\u{1F193}");
  if (isSet(item.doubleup)) flags.push("2\u00D7UP");
  if (isSet(item.internal)) flags.push("INTERNAL");
  return flags;
}

// Ranking for the stream list. The RAM window changed what "best" means: file
// size no longer costs anything, but the buffer is capped, so a release whose
// swarm cannot sustain its bitrate stutters where a smaller one would not.
// Playability therefore outranks quality.
const SEEDER_FLOOR = 5;
const RESOLUTION_RANK = {
  "2160p": 5, "4k": 5, uhd: 5, "1440p": 4,
  "1080p": 3, "1080i": 3, "720p": 2, "576p": 1, "480p": 1,
};
const TAG_RANK = { "4K": 5, "1080p": 3, "720p": 2, HD: 2, SD: 1 };

function qualityRank(item) {
  const name = (item && item.name) || "";
  const p = parseRelease(name);
  const res = p && p.resolution ? String(p.resolution).toLowerCase() : null;
  if (res && RESOLUTION_RANK[res]) return RESOLUTION_RANK[res];
  return TAG_RANK[getQualityTag(name)] || 0;
}

// Sort comparator: playable first, then quality, then freeleech, then seeders.
function compareReleases(a, b) {
  const aUp = (a.seeders || 0) >= SEEDER_FLOOR;
  const bUp = (b.seeders || 0) >= SEEDER_FLOOR;
  if (aUp !== bUp) return aUp ? -1 : 1;

  const quality = qualityRank(b) - qualityRank(a);
  if (quality !== 0) return quality;

  const free = (isSet(b.freeleech) ? 1 : 0) - (isSet(a.freeleech) ? 1 : 0);
  if (free !== 0) return free;

  return (b.seeders || 0) - (a.seeders || 0);
}

// The badge shown beside the stream. getQualityTag substring-matches the whole
// name, so "1080p.UHD.BluRay" (a 1080p encode of a UHD source) came out as 4K
// while the specs line said 1080p. Trust the parsed resolution instead, and
// fall back to the tag only when the name carries no resolution at all.
const BADGE_BY_RESOLUTION = {
  "2160p": "4K", "4k": "4K", uhd: "4K", "1440p": "1440p",
  "1080p": "1080p", "1080i": "1080p", "720p": "720p", "576p": "SD", "480p": "SD",
};

function qualityBadge(name) {
  const p = parseRelease(name);
  const res = p && p.resolution ? String(p.resolution).toLowerCase() : null;
  return (res && BADGE_BY_RESOLUTION[res]) || getQualityTag(name || "");
}

function formatSize(bytes) {
  if (!bytes) return "?";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function getQualityTag(name) {
  const n = name.toUpperCase();
  if (n.includes("2160P") || n.includes("4K") || n.includes("UHD")) return "4K";
  if (n.includes("1080P") || n.includes("BLURAY") || n.includes("BLU-RAY")) return "1080p";
  if (n.includes("720P")) return "720p";
  if (n.includes("HDTV") || n.includes("WEBRIP") || n.includes("WEB-DL")) return "HD";
  return "SD";
}

function getSeasonFromName(name) {
  const match = name.match(/[\.\s]S(\d{2})[\.\s]/i) || name.match(/Season[\s.]?(\d{1,2})/i);
  return match ? parseInt(match[1], 10) : null;
}

function getEpisodeFromName(name) {
  const match = name.match(/S(\d{2})E(\d{2})/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  return null;
}

function isSeasonPack(name) {
  return getSeasonFromName(name) !== null && getEpisodeFromName(name) === null;
}

function findEpisodeFile(files, season, episode) {
  if (!files || !files.length) return null;

  const padEp = String(episode).padStart(2, "0");
  const padSe = String(season).padStart(2, "0");
  const patterns = [
    new RegExp(`S${padSe}E${padEp}`, "i"),
    new RegExp(`${season}x${padEp}`, "i"),
    new RegExp(`[\\.\\ _-]E${padEp}[\\.\\ _-]`, "i"),
    new RegExp(`Episode[\\.\\ _-]?${episode}([\\.\\ _-]|$)`, "i"),
  ];

  const videoExts = [".mkv", ".mp4", ".avi", ".m4v"];

  for (let i = 0; i < files.length; i++) {
    const name = files[i].name || files[i].path || "";
    const isVideo = videoExts.some((ext) => name.toLowerCase().endsWith(ext));
    if (!isVideo) continue;

    for (const pattern of patterns) {
      if (pattern.test(name)) {
        const shortName = name.split("/").pop();
        return { idx: i, name: shortName };
      }
    }
  }
  return null;
}

module.exports = {
  parseRelease,
  qualityBadge,
  compareReleases,
  qualityRank,
  SEEDER_FLOOR,
  releaseFlags,
  releaseHeadline,
  releaseSpecs,
  formatSize,
  getQualityTag,
  getSeasonFromName,
  getEpisodeFromName,
  isSeasonPack,
  findEpisodeFile,
};
