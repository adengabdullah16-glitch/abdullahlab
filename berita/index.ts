// Supabase Edge Function: berita
// Mengambil judul berita terbaru dari RSS (Google News Indonesia, cadangan: Antara)
// untuk Asisten Berwajah. Dilindungi kode rahasia yang sama dengan asisten
// (tabel public.asisten_kunci), dikirim lewat header "x-asisten-kode".
//
// Pemasangan: Edge Functions → Deploy a new function → nama "berita" → tempel kode ini → Deploy.
// Lalu di pengaturan fungsi, MATIKAN "Verify JWT / Enforce JWT verification"
// (fungsi ini memeriksa kode rahasia sendiri). SUPABASE_DB_URL tersedia otomatis.

import postgres from "npm:postgres@3.4.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-asisten-kode, x-client-info",
};

const GN = "hl=id&gl=ID&ceid=ID:id";
const topik = (t) => `https://news.google.com/rss/headlines/section/topic/${t}?${GN}`;
const cariGN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&${GN}`;

const KATEGORI = {
  umum: `https://news.google.com/rss?${GN}`,
  nasional: topik("NATION"),
  dunia: topik("WORLD"),
  bisnis: topik("BUSINESS"),
  teknologi: topik("TECHNOLOGY"),
  hiburan: topik("ENTERTAINMENT"),
  olahraga: topik("SPORTS"),
  sains: topik("SCIENCE"),
  kesehatan: topik("HEALTH"),
  pendidikan: cariGN("pendidikan OR sekolah OR guru OR kurikulum"),
};
const CADANGAN = "https://www.antaranews.com/rss/terkini.xml";

// ---------- Pengurai RSS sederhana (tanpa pustaka) ----------
function dekode(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function ambilTag(blok, tag) {
  const m = blok.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? dekode(m[1]) : "";
}
export function uraiRSS(xml, maks = 10, sumberDefault = "") {
  const hasil = [];
  const items = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const it of items) {
    let judul = ambilTag(it, "title");
    const link = ambilTag(it, "link");
    let sumber = ambilTag(it, "source") || sumberDefault;
    const tgl = ambilTag(it, "pubDate");
    if (!judul || !/^https?:\/\//.test(link)) continue;
    if (sumber && judul.endsWith(" - " + sumber)) judul = judul.slice(0, -(sumber.length + 3));
    else if (!sumber) { const m = judul.match(/^(.*) - ([^-]{2,40})$/); if (m) { judul = m[1]; sumber = m[2]; } }
    const t = Date.parse(tgl);
    hasil.push({ judul: judul.slice(0, 200), sumber: sumber.slice(0, 60), link, terbit: Number.isFinite(t) ? new Date(t).toISOString() : null });
    if (hasil.length >= maks) break;
  }
  return hasil;
}

// ---------- Kode rahasia ----------
let sql = null;
let kodeSah = { kode: "", sampai: 0 };
async function cekKode(kode) {
  if (!kode || kode.length < 8 || kode.length > 200) return false;
  if (kodeSah.kode === kode && Date.now() < kodeSah.sampai) return true;
  if (!sql) sql = postgres(Deno.env.get("SUPABASE_DB_URL"), { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  const r = await sql`select exists(select 1 from public.asisten_kunci k where k.id = 1 and k.hash = extensions.crypt(${kode}, k.hash)) as ok`;
  if (r[0]?.ok) { kodeSah = { kode, sampai: Date.now() + 10 * 60 * 1000 }; return true; }
  return false;
}

// ---------- Ambil RSS dengan cache 10 menit ----------
const cache = new Map();
async function ambil(url, maks, sumberDefault = "") {
  const c = cache.get(url);
  if (c && Date.now() - c.t < 10 * 60 * 1000) return c.item.slice(0, maks);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (asisten-berwajah RSS)", "Accept": "application/rss+xml, application/xml, text/xml" } });
    if (!res.ok) throw new Error("RSS " + res.status);
    const item = uraiRSS(await res.text(), 15, sumberDefault);
    if (!item.length) throw new Error("RSS kosong");
    cache.set(url, { t: Date.now(), item });
    return item.slice(0, maks);
  } finally {
    clearTimeout(timer);
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Gunakan POST" }, 405);

  try {
    if (!(await cekKode(req.headers.get("x-asisten-kode") ?? ""))) return json({ error: "kode salah" }, 401);
  } catch (e) {
    console.error("cek kode:", e.message);
    return json({ error: "Gagal memeriksa kode" }, 500);
  }

  let b = {};
  try { b = await req.json(); } catch { /* badan kosong = umum */ }
  const jumlah = Math.min(10, Math.max(3, Number(b.jumlah) || 8));
  const q = typeof b.q === "string" ? b.q.replace(/[^\p{L}\p{N}\s.\-'"]/gu, "").trim().slice(0, 80) : "";
  const kategori = q ? "cari" : (Object.hasOwn(KATEGORI, String(b.kategori)) ? b.kategori : "umum");
  const url = q ? cariGN(q) : KATEGORI[kategori];

  try {
    const item = await ambil(url, jumlah);
    return json({ kategori, q: q || null, sumber: "Google News", diambil: new Date().toISOString(), item });
  } catch (e) {
    console.error("google news:", e.message);
    if (q) return json({ kategori, q, sumber: "Google News", diambil: new Date().toISOString(), item: [], catatan: "Pencarian gagal: " + e.message });
    try {
      const item = await ambil(CADANGAN, jumlah, "Antara");
      return json({ kategori, q: null, sumber: "Antara (cadangan)", diambil: new Date().toISOString(), item });
    } catch (e2) {
      console.error("antara:", e2.message);
      return json({ error: "Sumber berita tidak bisa diambil sekarang" }, 502);
    }
  }
});
