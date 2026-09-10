const {
  compareReleases,
  releaseFlags,
  releaseHeadline,
  releaseSpecs,
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

describe("releaseHeadline", () => {
  test("turns a movie release into title and year", () => {
    expect(releaseHeadline("Moana.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo")).toBe("Moana (2026)");
  });

  test("keeps a year that is part of the title", () => {
    // "2049" must not be mistaken for the release year.
    expect(
      releaseHeadline("Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1.Atmos-EPSiLON"),
    ).toBe("Blade Runner 2049 (2017)");
  });

  test("keeps punctuation and numbers in titles", () => {
    expect(releaseHeadline("Fast.&.Furious.7.2015.Extended.2160p.MA.WEB-DL.DDP5.1.H.265-CHORTLE")).toBe(
      "Fast & Furious 7 (2015)",
    );
  });

  test("formats a series episode", () => {
    expect(releaseHeadline("Insula.Iubirii.S10E01.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB")).toBe(
      "Insula Iubirii S10E01",
    );
  });

  test("keeps multi-episode ranges", () => {
    expect(
      releaseHeadline("Destine.cu.parfum.de.lavanda.S01E31-E33.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB"),
    ).toBe("Destine cu parfum de lavanda S01E31-E33");
  });

  test("includes an episode title when the release carries one", () => {
    expect(
      releaseHeadline("Las.Fierbinti.S30E02.Fantoma.Partea.2.1080p.VOYO.WEB-DL.AAC2.0.H.264-playWEB"),
    ).toBe("Las Fierbinti S30E02 - Fantoma Partea 2");
  });

  test("does not mistake technical tokens for an episode title", () => {
    const out = releaseHeadline("Insula.Iubirii.S10E01.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB");
    expect(out).not.toMatch(/1080p|ANTP/);
  });

  test("falls back to the raw name for unparseable input", () => {
    expect(releaseHeadline("")).toBe("");
    expect(releaseHeadline(null)).toBe("");
    expect(releaseHeadline("some random upload")).toBe("some random upload");
  });
});

describe("releaseSpecs", () => {
  test("summarises resolution, source, codec and audio", () => {
    expect(releaseSpecs("Moana.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo")).toBe(
      "1080p · WEB-DL · H.264 · DDP5.1",
    );
  });

  test("renders stereo channels as 2.0 rather than 2", () => {
    expect(releaseSpecs("Insula.Iubirii.S10E01.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB")).toContain("AAC2.0");
  });

  test("includes Atmos and HDR flags", () => {
    const out = releaseSpecs("Mayday.2026.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DoVi.HDR.H.265-FLUX");
    expect(out).toContain("Atmos");
    expect(out).toContain("HDR");
    expect(out).toContain("DV");
  });

  test("marks remuxes and editions", () => {
    expect(
      releaseSpecs("Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1.Atmos-EPSiLON"),
    ).toContain("BluRay REMUX");
    expect(releaseSpecs("Fast.&.Furious.7.2015.Extended.2160p.MA.WEB-DL.DDP5.1.H.265-CHORTLE")).toContain(
      "Extended",
    );
  });

  test("separates the service from a same-named audio codec", () => {
    // Real FileList release: MA is both the service (Movies Anywhere) and part
    // of DTS-HD MA (Master Audio).
    const raw = "Inception.2010.2160p.MA.WEB-DL.DTS-HD.MA.5.1.DoVi.HDR.H.265-FLUX";
    expect(releaseHeadline(raw)).toBe("Inception (2010)");
    expect(releaseSpecs(raw)).toBe("2160p · WEB-DL · H.265 · DTS-HD MA 5.1 · HDR DV");
  });

  test("spaces channels off long codec names but not short ones", () => {
    expect(releaseSpecs("Moana.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo")).toContain("DDP5.1");
    expect(releaseSpecs("Inception.2010.1080p.BluRay.DTS-HD.MA.7.1.x264-DON")).toContain("DTS-HD MA 7.1");
  });

  test("returns an empty string when nothing is recognisable", () => {
    expect(releaseSpecs("")).toBe("");
    expect(releaseSpecs("some random upload")).toBe("");
  });
});

describe("releaseFlags", () => {
  test("marks freeleech, doubleup and internal releases", () => {
    expect(releaseFlags({ freeleech: 1 })).toEqual(["🆓"]);
    expect(releaseFlags({ doubleup: 1 })).toEqual(["2×UP"]);
    expect(releaseFlags({ internal: 1 })).toEqual(["INTERNAL"]);
    expect(releaseFlags({ freeleech: 1, doubleup: 1, internal: 1 })).toEqual(["🆓", "2×UP", "INTERNAL"]);
  });

  test("accepts the string form the API also returns", () => {
    expect(releaseFlags({ freeleech: "1" })).toEqual(["🆓"]);
  });

  test("returns nothing for unset, zero or missing flags", () => {
    expect(releaseFlags({ freeleech: 0, doubleup: "0", internal: null })).toEqual([]);
    expect(releaseFlags({})).toEqual([]);
    expect(releaseFlags(null)).toEqual([]);
  });

  test("ignores unrelated tracker fields", () => {
    expect(releaseFlags({ moderated: 1, seeders: 40, category: "Filme HD" })).toEqual([]);
  });
});

describe("releaseHeadline season packs", () => {
  test("keeps the season when there is no episode", () => {
    // Without this every season of a show renders identically.
    expect(releaseHeadline("Insula.Iubirii.S03.720p.ANTP.WEB-DL.AAC2.0.H.264-playWEB")).toBe(
      "Insula Iubirii S03",
    );
  });

  test("includes a season pack sub-title", () => {
    expect(
      releaseHeadline("Insula.Iubirii.S09.Casa.Baietilor.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB"),
    ).toBe("Insula Iubirii S09 - Casa Baietilor");
  });

  test("does not treat a technical tag as a sub-title", () => {
    expect(releaseHeadline("Insula.Iubirii.S09.REPACK.1080p.ANTP.WEB-DL.AAC2.0.H.264-playWEB")).toBe(
      "Insula Iubirii S09",
    );
  });

  test("handles a season pack with no resolution token", () => {
    expect(releaseHeadline("Insula.Iubirii.S01.ANTP.WEB-DL.AAC2.0.H.264-playWEB")).toBe(
      "Insula Iubirii S01",
    );
  });
});

describe("compareReleases", () => {
  const rel = (name, seeders, freeleech) => ({ name, seeders, freeleech: freeleech ? 1 : 0 });

  test("puts poorly seeded releases last however good they are", () => {
    const list = [rel("X.2024.2160p.REMUX.H.265-D", 2, true), rel("X.2024.720p.WEB-DL.H.264-A", 99, false)];
    list.sort(compareReleases);
    expect(list[0].name).toContain("720p");
  });

  test("prefers higher quality among playable releases", () => {
    const list = [rel("X.2024.1080p.WEB-DL.H.264-F", 80, false), rel("X.2024.2160p.WEB-DL.H.265-B", 40, false)];
    list.sort(compareReleases);
    expect(list[0].name).toContain("2160p");
  });

  test("uses freeleech to break ties at the same quality", () => {
    const list = [rel("X.2024.2160p.WEB-DL.H.265-B", 40, false), rel("X.2024.2160p.WEB-DL.H.265-C", 12, true)];
    list.sort(compareReleases);
    expect(list[0].name).toContain("-C");
  });

  test("falls back to seeders when quality and freeleech match", () => {
    const list = [rel("X.2024.1080p.WEB-DL.H.264-A", 10, true), rel("X.2024.1080p.WEB-DL.H.264-B", 50, true)];
    list.sort(compareReleases);
    expect(list[0].seeders).toBe(50);
  });

  test("orders a realistic mixed list", () => {
    const list = [
      rel("X.2024.720p.WEB-DL.H.264-A", 99, false),
      rel("X.2024.2160p.WEB-DL.H.265-B", 40, false),
      rel("X.2024.2160p.WEB-DL.H.265-C", 12, true),
      rel("X.2024.2160p.REMUX.H.265-D", 2, true),
      rel("X.2024.1080p.WEB-DL.H.264-E", 60, true),
    ];
    list.sort(compareReleases);
    expect(list.map((r) => r.name.slice(-1))).toEqual(["C", "B", "E", "A", "D"]);
  });
});
