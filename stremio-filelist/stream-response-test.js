// Checks the shape of the stream objects the addon actually returns over HTTP,
// with the FileList API stubbed. Guards a regression that silently emptied the
// stream list in Stremio: sending both `title` and `description` makes the
// client's deserializer reject every stream, because `description` is declared
// with `alias = "title"` and serde refuses duplicate fields.
const assert = require("assert");
const Module = require("module");
const path = require("path");

const sample = [
  { id: 949669, name: "Inception.2010.2160p.MA.WEB-DL.DTS-HD.MA.5.1.DoVi.HDR.H.265-FLUX",
    freeleech: 1, doubleup: 0, internal: 0, size: 31518555822, seeders: 73 },
  { id: 776901, name: "Inception.2010.720p.BluRay.DD5.1.x264-playHD",
    freeleech: 1, doubleup: 0, internal: 1, size: 9663676416, seeders: 49 },
];

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "axios") {
    return { get: async (url) => {
      if (url.includes("api.php")) return { data: sample };
      throw new Error("not stubbed");
    } };
  }
  return orig.apply(this, arguments);
};

process.env.FILELIST_USER = "u";
process.env.FILELIST_PASSKEY = "p";
process.env.PORT = process.env.PORT || "7802";
delete process.env.API_KEY;
require(path.join(__dirname, "index.js"));

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

setTimeout(async () => {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/stream/movie/tt1375666.json`);
  if (res.status !== 200) fail(`HTTP ${res.status}`);
  const body = await res.json();

  if (!Array.isArray(body.streams) || body.streams.length !== sample.length) {
    fail(`expected ${sample.length} streams, got ${JSON.stringify(body).slice(0, 200)}`);
  }

  for (const s of body.streams) {
    const hasTitle = "title" in s;
    const hasDescription = "description" in s;
    if (hasTitle && hasDescription) {
      fail("stream sets both title and description; Stremio's deserializer rejects the duplicate");
    }
    if (!hasTitle && !hasDescription) fail("stream has neither title nor description");
    if (!s.name || !s.url) fail("stream missing name or url");
    assert.ok(/Inception \(2010\)/.test(s.title || s.description), "headline not rendered");
  }

  // Ranking: 720p with fewer seeders must not outrank 2160p.
  assert.ok(/2160p/.test(body.streams[0].title || body.streams[0].description), "ranking wrong");

  console.log(`PASS: ${body.streams.length} streams, exactly one of title/description, ranked correctly`);
  process.exit(0);
}, 1500);
