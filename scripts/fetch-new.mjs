// Fetch the full CCBBD03 list, detect NEW docIds vs public/data.json,
// download only the new source files, and write working files for the extractor.
//
// Outputs (in ./newdocs, or ./pending with --pending):
//   list.json      – ALL current records with fresh metadata + seq (authoritative)
//   manifest.json  – only the NEW records (need deficiency extraction), incl. saved file path + extracted text
//   <docId>.txt    – extracted text for each new record (PDF via pdftotext if present, else raw; HWPX via fflate)
//
// --pending mode (run in GitHub Actions, which reliably reaches MFDS):
//   writes to ./pending/ (committed to the repo) and keeps ONLY text/json there —
//   the downloaded PDF/HWPX binaries go to a temp dir so the repo stays small.
//   The dir is rebuilt from scratch each run, so processed items disappear by themselves.
//
// Exit prints "NEW=<n>" so the caller/agent knows how many need extraction.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { unzipSync, strFromU8 } from "fflate";
import { extractFormInfo } from "./forms.mjs";
import { pdfToText } from "./pdftext.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DATA = path.join(ROOT, "public", "data.json");
const FORMS = path.join(ROOT, "forms.json");
const PENDING = process.argv.includes("--pending");
const OUT = path.join(ROOT, PENDING ? "pending" : "newdocs");
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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function fetchRetry(url, opts, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 3000 * (i + 1))); }
  }
  throw last;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // in pending mode the binaries are throwaway: keep them out of the repo
  const BIN = PENDING ? fs.mkdtempSync(path.join(os.tmpdir(), "gmp-src-")) : OUT;
  const res = await fetchRetry(LIST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "text/html,application/xhtml+xml", "accept-language": "ko-KR,ko;q=0.9",
    },
    body: "keyword=&page=1&limit=100000&sort=&sortOrder=&searchYn=&mnfctrName=&countryName=&startDate=&endDate=",
  });
  const html = await res.text();
  const list = parseList(html);
  if (list.length < 100) throw new Error("suspiciously few records: " + list.length);
  fs.writeFileSync(path.join(OUT, "list.json"), JSON.stringify(list, null, 2));

  const existing = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, "utf8")) : [];
  const known = new Set(existing.map(r => r.docId));
  const fresh = list.filter(r => !known.has(r.docId));

  const manifest = [];
  const formsMap = fs.existsSync(FORMS) ? JSON.parse(fs.readFileSync(FORMS, "utf8")) : {};
  for (const r of fresh) {
    let buf;
    try { const dres = await fetchRetry(DOWN + r.docId, {}); buf = Buffer.from(await dres.arrayBuffer()); }
    // 이 건만 빼고 진행한다. 목록엔 남아 있으므로 merge 가 '적합' 오표시를 막으려고
    // 중단시킨다(호출부는 이번 실행을 통째로 건너뛰고 다음에 재시도한다).
    catch (e) { console.error("DOWNLOAD_FAILED:", r.docId, r.site, e.message); continue; }
    const isZip = buf.slice(0, 2).toString() === "PK";
    const ext = isZip ? "hwpx" : "pdf";
    const file = path.join(BIN, r.docId + "." + ext);
    fs.writeFileSync(file, buf);
    let text = null;
    if (isZip) { try { text = hwpxToText(buf); } catch (e) { text = null; } }
    else { text = pdfToText(file); }
    if (text != null) fs.writeFileSync(path.join(OUT, r.docId + ".txt"), text);
    // 제형은 규칙 기반으로 바로 뽑아 forms.json 에 누적한다 (LLM 불필요)
    const info = text != null ? extractFormInfo(text) : { forms: [], sterile: "" };
    // 본문을 못 읽은 건은 forms.json 에 남기지 않는다.
    // 빈 값을 적어두면 "제형 없는 문서"로 굳어져, 나중에 본문을 읽을 수 있게 돼도
    // scan-forms 가 `docId in forms` 로 건너뛰어 영영 채워지지 않는다.
    if (text != null) formsMap[r.docId] = info;
    // pending mode: `file` is a temp path the consumer can't reach — give it the source URL instead
    manifest.push({ ...r, file: PENDING ? null : file, downUrl: DOWN + r.docId, ext, hasText: text != null, ...info });
    await new Promise(s => setTimeout(s, 150));
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (fresh.length) fs.writeFileSync(FORMS, JSON.stringify(formsMap, null, 1));
  // pending/ mirrors "not yet in the dashboard". Prune only AFTER a successful fetch —
  // clearing it up front would wipe the backlog whenever MFDS is unreachable.
  if (PENDING) {
    const keep = new Set(["list.json", "manifest.json", ...manifest.map(r => r.docId + ".txt")]);
    for (const f of fs.readdirSync(OUT)) {
      if (/\.(txt|json|pdf|hwpx)$/.test(f) && !keep.has(f)) fs.rmSync(path.join(OUT, f));
    }
  }
  console.log(`TOTAL=${list.length} KNOWN=${known.size} NEW=${fresh.length}`);
  if (fresh.length) console.log("NEW_DOCIDS=" + fresh.map(r => r.docId).join(","));
}
main().catch(e => { console.error("FETCH_ERROR:", e.message); process.exit(1); });
