// Compare current public/data.json against a previous snapshot and build the
// email (subject + HTML body + recipient list) summarizing NEWLY ADDED records.
//
// Usage: node scripts/build-email.mjs <prevJsonPath>
// Env:   SAMPLE=<n>  -> test mode: force a sample email from the first n records
//        GITHUB_OUTPUT -> when set (in Actions), writes send/subject/to outputs
// Files: recipients.json (repo root) = ["a@x.com", ...]
// Output: writes ./email-body.html ; prints "SEND=true|false N=<n>"
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const CUR = path.join(ROOT, "public", "data.json");
const RECIP = path.join(ROOT, "recipients.json");
const prevPath = process.argv[2];
const SITE = "https://chleogks1598-beep.github.io/nedrug-gmp-dashboard/";
const DOWN = "https://nedrug.mfds.go.kr/cmn/edms/down/";

const esc = s => (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// recipients
let recipients = [];
try { recipients = JSON.parse(fs.readFileSync(RECIP, "utf8")).filter(x => typeof x === "string" && x.includes("@")); } catch {}
if (recipients.length === 0 && process.env.RECIPIENT) recipients = [process.env.RECIPIENT];

const cur = JSON.parse(fs.readFileSync(CUR, "utf8"));
let prev = [];
try { if (prevPath && fs.existsSync(prevPath)) prev = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch {}
const prevIds = new Set(prev.map(r => r.docId));
let fresh = cur.filter(r => !prevIds.has(r.docId));

// test mode
const SAMPLE = parseInt(process.env.SAMPLE || "0", 10);
let isSample = false;
if (SAMPLE > 0) { fresh = cur.slice(0, SAMPLE); isSample = true; }

function emitOutput(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

if (fresh.length === 0) {
  emitOutput({ send: "false" });
  console.log("SEND=false N=0");
  process.exit(0);
}
if (recipients.length === 0) {
  emitOutput({ send: "false" });
  console.log("SEND=false N=" + fresh.length + " (수신자 없음: recipients.json 확인)");
  process.exit(0);
}

const withDef = fresh.filter(r => r.defCount > 0).length;
const items = fresh.reduce((a, r) => a + (r.defCount || 0), 0);
const today = (cur.map(r => r.regDate).filter(Boolean).sort().pop()) || "";

const rowsHtml = fresh.map(r => {
  const badge = r.defCount > 0
    ? `<span style="background:#fdece2;color:#c2410c;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">지적 ${r.defCount}</span>`
    : `<span style="background:#e2f4ec;color:#0f8a5f;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700">적합</span>`;
  const defs = (r.deficiencies || []).map(d =>
    `<li style="margin:3px 0"><b>${esc(d.field)}</b>${d.gubun ? " · " + esc(d.gubun) : ""}${d.law ? ` <span style="color:#888">(${esc(d.law)})</span>` : ""}<br>${esc(d.summary)}${d.remark ? ` <span style="color:#0f8a5f">— ${esc(d.remark)}</span>` : ""}</li>`
  ).join("");
  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;color:#666">${esc(r.regDate)}<br>${esc(r.country)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top">
      <div style="font-weight:700">${esc(r.site)} ${badge}</div>
      <div style="color:#888;font-size:12px;margin:2px 0 6px">${esc(r.address)}</div>
      ${defs ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#333">${defs}</ul>` : ""}
      <a href="${DOWN}${esc(r.docId)}" style="font-size:12px;color:#1367d6;text-decoration:none">⬇ 원본 실사결과서(PDF)</a>
    </td>
  </tr>`;
}).join("");

const subject = `${isSample ? "[테스트] " : ""}[GMP 실사결과] 신규 ${fresh.length}건 등록 (지적 ${withDef}곳 · ${items}항목)`;
const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  <h2 style="font-size:18px;margin:0 0 4px">의약품등 GMP 실사 결과공개 — 신규 갱신 알림</h2>
  <p style="color:#666;font-size:13px;margin:0 0 16px">최신 등록일 ${esc(today)} 기준 · 새로 추가된 <b>${fresh.length}건</b> (지적사항 있는 곳 ${withDef}, 총 지적항목 ${items})</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${rowsHtml}</table>
  <p style="margin:18px 0 0;font-size:13px"><a href="${SITE}" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">전체 대시보드 보기 →</a></p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">식약처 의약품안전나라 공개데이터를 자동 정리한 참고용 알림입니다. 정확한 내용은 원본 문서를 확인하세요.</p>
</div>`;

fs.writeFileSync(path.join(ROOT, "email-body.html"), html);
emitOutput({ send: "true", subject, to: recipients.join(",") });
console.log(`SEND=true N=${fresh.length} TO=${recipients.join(",")}`);
