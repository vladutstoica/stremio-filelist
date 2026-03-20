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
  formatSize,
  getQualityTag,
  getSeasonFromName,
  getEpisodeFromName,
  isSeasonPack,
  findEpisodeFile,
};
