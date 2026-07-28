// Fetch the full CCBBD03 list, detect NEW docIds vs public/data.json,
// download only the new source files, and write working files for the extractor.
//
// Outputs (in ./newdocs):
//   list.json      – ALL current records with fresh metadata + seq (authoritative)
//   manifest.json  – only the NEW records (need deficiency extraction), incl. saved file path + extracted text
//   <docId>.txt    – extracted text for each new record (PDF via pdftotext if present, else raw; HWPX via fflate)
//
// Exit prints "NEW=<n>" so the caller/agent knows how many need extraction.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { unzipSync, strFromU8 } from "fflate";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DATA = path.join(ROOT, "public", "data.json");
const OUT = path.join(ROOT, "newdocs");
const LIST_URL = "https://nedrug.mfds.go.kr/pbp/CCBBD03/getList";
const DOWN = "https://nedrug.mfds.go.kr/cmn/edms/down/";

const clean = s => (s == null ? "" : String(s))
  .replace(/<[^>]*>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

function parseList(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const target = tables.find(t => t.includes("downFile(&#39;"));
  if (!target) throw new Error("list table not found");
  const trs = target.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const recs = [];
  for (const r of trs) {
    const idm = r.match(/downFile\(&#39;([^&]+)&#39;\)/);
    if (!idm) continue;
    const c = [...r.matchAll(/<td[\s\S]*?<\/td>/gi)].map(m => clean(m[0]));
    recs.push({
      docId: idm[1], seq: Number(c[0]) || 0, prePost: c[1] || "", type: c[2] || "",
      country: c[3] || "", site: c[4] || "", address: c[5] || "",
      inspStart: c[6] || "", inspEnd: c[7] || "", regDate: (c[c.length - 1] || "").trim(),
    });
  }
  return recs;
}

function hwpxToText(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).filter(n => /^Contents\/section\d+\.xml$/.test(n)).sort();
  let out = "";
  for (const n of names) {
    const xml = strFromU8(files[n]);
    out += xml.replace(/<\/hp:p>/g, "\n")
      .replace(/<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g, (_, g) => g.replace(/<[^>]+>/g, ""))
      .replace(/<[^>]+>/g, "") + "\n";
  }
  return out;
}

function pdfToText(file) {
  try {
    return execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", file, "-"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // pdftotext unavailable — caller/agent should Read the PDF directly
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const res = await fetch(LIST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA, "accept": "text/html,application/xhtml+xml", "accept-language": "ko-KR,ko;q=0.9",
    },
    body: "keyword=&page=1&limit=100000&sort=&sortOrder=&searchYn=&mnfctrName=&countryName=&startDate=&endDate=",
  });
  if (!res.ok) throw new Error("getList HTTP " + res.status);
  const html = await res.text();
  const list = parseList(html);
  if (list.length < 100) throw new Error("suspiciously few records: " + list.length);
  fs.writeFileSync(path.join(OUT, "list.json"), JSON.stringify(list, null, 2));

  const existing = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, "utf8")) : [];
  const known = new Set(existing.map(r => r.docId));
  const fresh = list.filter(r => !known.has(r.docId));

  const manifest = [];
  for (const r of fresh) {
    const dres = await fetch(DOWN + r.docId, { headers: { "user-agent": UA } });
    const buf = Buffer.from(await dres.arrayBuffer());
    const isZip = buf.slice(0, 2).toString() === "PK";
    const ext = isZip ? "hwpx" : "pdf";
    const file = path.join(OUT, r.docId + "." + ext);
    fs.writeFileSync(file, buf);
    let text = null;
    if (isZip) { try { text = hwpxToText(buf); } catch (e) { text = null; } }
    else { text = pdfToText(file); }
    if (text != null) fs.writeFileSync(path.join(OUT, r.docId + ".txt"), text);
    manifest.push({ ...r, file, ext, hasText: text != null });
    await new Promise(s => setTimeout(s, 150));
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`TOTAL=${list.length} KNOWN=${known.size} NEW=${fresh.length}`);
  if (fresh.length) console.log("NEW_DOCIDS=" + fresh.map(r => r.docId).join(","));
}
main().catch(e => { console.error("FETCH_ERROR:", e.message); process.exit(1); });
