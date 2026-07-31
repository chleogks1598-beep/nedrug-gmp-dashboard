// 전체 실사결과서를 다시 내려받아 "제형"을 추출하고 forms.json 으로 저장한다.
// (초기 구축 때는 제형을 뽑지 않았기 때문에 소급 적용이 필요하다.)
//
// 식약처는 클라우드 IP를 자주 막으므로 이 스크립트는 국내 IP(로컬 PC)에서 돌린다.
// 결과: forms.json = { "<docId>": {forms:["비무균-일반제제-합성",...], sterile:"비무균"} }
// 이미 forms.json 에 있는 docId 는 건너뛰므로 중단 후 재실행해도 이어서 진행된다.
//
// 사용: node scripts/scan-forms.mjs [--limit N] [--only docId,docId]
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { unzipSync, strFromU8 } from "fflate";
import { extractFormInfo } from "./forms.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DATA = path.join(ROOT, "public", "data.json");
const OUTF = path.join(ROOT, "forms.json");
const DOWN = "https://nedrug.mfds.go.kr/cmn/edms/down/";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gmp-forms-"));
// 추출한 본문 텍스트를 캐시해 둔다 — 파서를 고칠 때 재다운로드 없이 --reparse 로 다시 돌린다
const CACHE = path.join(os.tmpdir(), "gmp-doc-cache");
fs.mkdirSync(CACHE, { recursive: true });
const REPARSE = argv0().includes("--reparse");
function argv0() { return process.argv.slice(2); }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = Number(arg("--limit") || 0);
const ONLY = (arg("--only") || "").split(",").filter(Boolean);

async function fetchRetry(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 2000 * (i + 1))); }
  }
  throw last;
}

function hwpxToText(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).filter(n => /^Contents\/section\d+\.xml$/.test(n)).sort();
  let out = "";
  for (const n of names) {
    out += strFromU8(files[n])
      .replace(/<\/hp:p>/g, "\n")
      .replace(/<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g, (_, g) => g.replace(/<[^>]+>/g, ""))
      .replace(/<[^>]+>/g, "") + "\n";
  }
  return out;
}

const pdfToText = file => {
  try {
    return execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", file, "-"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
};

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
const forms = fs.existsSync(OUTF) ? JSON.parse(fs.readFileSync(OUTF, "utf8")) : {};
let targets = REPARSE ? data.slice() : data.filter(r => !(r.docId in forms));
if (ONLY.length) targets = data.filter(r => ONLY.includes(r.docId));
if (LIMIT) targets = targets.slice(0, LIMIT);

console.log(`대상 ${targets.length}건 (이미 처리 ${Object.keys(forms).length}건)`);
let ok = 0, empty = 0, fail = 0, n = 0;
for (const r of targets) {
  n++;
  const cached = path.join(CACHE, r.docId + ".txt");
  let text = null;
  if (fs.existsSync(cached)) {
    text = fs.readFileSync(cached, "utf8");
  } else if (REPARSE) {
    continue; // 캐시에 없으면 재파싱 대상이 아님
  } else {
    let buf;
    try { buf = Buffer.from(await (await fetchRetry(DOWN + r.docId)).arrayBuffer()); }
    catch (e) { console.log(`  [다운실패] ${r.docId} ${r.site} — ${e.message}`); fail++; continue; }
    const isZip = buf.slice(0, 2).toString() === "PK";
    if (isZip) { try { text = hwpxToText(buf); } catch { text = null; } }
    else {
      const f = path.join(TMP, r.docId + ".pdf");
      fs.writeFileSync(f, buf);
      text = pdfToText(f);
      fs.rmSync(f, { force: true });
    }
    if (text != null) fs.writeFileSync(cached, text);
    await new Promise(s => setTimeout(s, 120));
  }
  if (text == null) { console.log(`  [텍스트실패] ${r.docId} ${r.site}`); fail++; continue; }
  const info = extractFormInfo(text);
  forms[r.docId] = info;
  if (info.forms.length) ok++; else { empty++; console.log(`  [제형없음] ${r.docId} ${r.site} (무균표기:${info.sterile||"-"})`); }
  if (n % 25 === 0) {
    fs.writeFileSync(OUTF, JSON.stringify(forms, null, 1));
    console.log(`  ...${n}/${targets.length} (추출 ${ok} / 없음 ${empty} / 실패 ${fail})`);
  }
}
fs.writeFileSync(OUTF, JSON.stringify(forms, null, 1));
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`완료: 추출 ${ok} / 제형없음 ${empty} / 실패 ${fail} / forms.json 총 ${Object.keys(forms).length}건`);
