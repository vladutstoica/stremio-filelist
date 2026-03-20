const {
  formatSize,
  getQualityTag,
  getSeasonFromName,
  getEpisodeFromName,
  isSeasonPack,
  findEpisodeFile,
} = require("./helpers");

describe("formatSize", () => {
  test("returns ? for falsy input", () => {
    expect(formatSize(0)).toBe("?");
    expect(formatSize(null)).toBe("?");
    expect(formatSize(undefined)).toBe("?");
  });

  test("formats bytes as MB", () => {
    expect(formatSize(500 * 1024 * 1024)).toBe("500 MB");
  });

  test("formats bytes as GB", () => {
    expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  test("shows GB at exactly 1 GB", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("getQualityTag", () => {
  test("detects 4K variants", () => {
    expect(getQualityTag("Movie.2160p.BluRay")).toBe("4K");
    expect(getQualityTag("Movie.4K.HDR")).toBe("4K");
    expect(getQualityTag("Movie.UHD.Remux")).toBe("4K");
  });

  test("detects 1080p variants", () => {
    expect(getQualityTag("Movie.1080p.WEB-DL")).toBe("1080p");
    expect(getQualityTag("Movie.BluRay.x264")).toBe("1080p");
    expect(getQualityTag("Movie.Blu-Ray.Remux")).toBe("1080p");
  });

  test("detects 720p", () => {
    expect(getQualityTag("Movie.720p.HDTV")).toBe("720p");
  });

  test("detects HD", () => {
    expect(getQualityTag("Movie.HDTV.x264")).toBe("HD");
    expect(getQualityTag("Movie.WEBRip")).toBe("HD");
    expect(getQualityTag("Movie.WEB-DL")).toBe("HD");
  });

  test("defaults to SD", () => {
    expect(getQualityTag("Movie.DVDRip")).toBe("SD");
    expect(getQualityTag("")).toBe("SD");
  });
});

describe("getSeasonFromName", () => {
  test("extracts season from S01 format", () => {
    expect(getSeasonFromName("Show.S01.720p")).toBe(1);
    expect(getSeasonFromName("Show.S12.1080p")).toBe(12);
  });

  test("extracts season from Season format", () => {
    expect(getSeasonFromName("Show Season 3 Complete")).toBe(3);
    expect(getSeasonFromName("Show.Season.10")).toBe(10);
  });

  test("returns null when no season found", () => {
    expect(getSeasonFromName("Movie.2024.1080p")).toBeNull();
  });
});

describe("getEpisodeFromName", () => {
  test("extracts season and episode from S01E03", () => {
    expect(getEpisodeFromName("Show.S01E03.720p")).toEqual({
      season: 1,
      episode: 3,
    });
  });

  test("is case insensitive", () => {
    expect(getEpisodeFromName("show.s02e15.hdtv")).toEqual({
      season: 2,
      episode: 15,
    });
  });

  test("returns null for season packs", () => {
    expect(getEpisodeFromName("Show.S01.720p")).toBeNull();
  });

  test("returns null for movies", () => {
    expect(getEpisodeFromName("Movie.2024.1080p")).toBeNull();
  });
});

describe("isSeasonPack", () => {
  test("returns true for season packs", () => {
    expect(isSeasonPack("Show.S01.720p.WEB-DL")).toBe(true);
    expect(isSeasonPack("Show Season 2 Complete")).toBe(true);
  });

  test("returns false for individual episodes", () => {
    expect(isSeasonPack("Show.S01E03.720p")).toBe(false);
  });

  test("returns false for movies", () => {
    expect(isSeasonPack("Movie.2024.1080p")).toBe(false);
  });
});

describe("findEpisodeFile", () => {
  const files = [
    { name: "Show/Show.S01E01.720p.mkv" },
    { name: "Show/Show.S01E02.720p.mkv" },
    { name: "Show/Show.S01E03.720p.mkv" },
    { name: "Show/sample.mkv" },
    { name: "Show/subs.srt" },
  ];

  test("finds episode by S01E03 pattern", () => {
    const result = findEpisodeFile(files, 1, 3);
    expect(result).toEqual({ idx: 2, name: "Show.S01E03.720p.mkv" });
  });

  test("finds first episode", () => {
    const result = findEpisodeFile(files, 1, 1);
    expect(result).toEqual({ idx: 0, name: "Show.S01E01.720p.mkv" });
  });

  test("returns null for missing episode", () => {
    expect(findEpisodeFile(files, 1, 10)).toBeNull();
  });

  test("skips non-video files", () => {
    const srtFiles = [{ name: "Show.S01E01.srt" }];
    expect(findEpisodeFile(srtFiles, 1, 1)).toBeNull();
  });

  test("returns null for empty/null files", () => {
    expect(findEpisodeFile([], 1, 1)).toBeNull();
    expect(findEpisodeFile(null, 1, 1)).toBeNull();
  });

  test("matches 1x03 format", () => {
    const altFiles = [{ name: "Show.1x03.720p.mp4" }];
    expect(findEpisodeFile(altFiles, 1, 3)).toEqual({
      idx: 0,
      name: "Show.1x03.720p.mp4",
    });
  });

  test("matches Episode format", () => {
    const altFiles = [{ name: "Show.Episode.5.mp4" }];
    expect(findEpisodeFile(altFiles, 1, 5)).toEqual({
      idx: 0,
      name: "Show.Episode.5.mp4",
    });
  });

  test("uses path field as fallback", () => {
    const pathFiles = [{ path: "Show/Show.S02E01.mkv" }];
    expect(findEpisodeFile(pathFiles, 2, 1)).toEqual({
      idx: 0,
      name: "Show.S02E01.mkv",
    });
  });
});
