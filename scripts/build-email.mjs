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
let recipError = "";
try { recipients = JSON.parse(fs.readFileSync(RECIP, "utf8")).filter(x => typeof x === "string" && x.includes("@")); }
catch (e) { recipError = e.message; }
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
// 신규 건이 있는데 수신자를 못 정하면 조용히 넘어가지 않는다.
// send=false 로 끝내면 워크플로우가 초록으로 끝나서, 아무도 메일을 못 받고 있다는 걸
// 알아챌 방법이 없다(recipients.json 이 깨지거나 비면 그렇게 된다).
if (recipients.length === 0) {
  console.error(
    `RECIPIENTS_ERROR: 신규 ${fresh.length}건이 있는데 수신자가 없습니다 — ${RECIP} 확인 필요.` +
      (recipError ? ` (읽기 실패: ${recipError})` : ""),
  );
  process.exit(1);
}

const withDef = fresh.filter(r => r.defCount > 0).length;
const items = fresh.reduce((a, r) => a + (r.defCount || 0), 0);
// 원문이 자동 판독되지 않아 아직 판정하지 못한 건. '적합'으로 보내면 안 된다(quarantine.json).
const review = fresh.filter(r => r.unresolved).length;
const today = (cur.map(r => r.regDate).filter(Boolean).sort().pop()) || "";

const rowsHtml = fresh.map(r => {
  const badge = r.unresolved
    ? `<span style="background:#e7f0fc;color:#1367d6;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">확인중</span>`
    : r.defCount > 0
    ? `<span style="background:#fdece2;color:#c2410c;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">지적 ${r.defCount}</span>`
    : `<span style="background:#e2f4ec;color:#0f8a5f;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700">적합</span>`;
  const hold = r.unresolved
    ? `<div style="background:#e7f0fc;border-left:3px solid #1367d6;padding:8px 10px;margin:6px 0 0;font-size:12.5px;color:#1a2733">
        <b>확인중 — 적합 판정이 아닙니다.</b> 식약처 원문이 자동으로 판독되지 않아 지적(보완)사항을
        아직 확인하지 못했습니다. 아래 원본 링크로 직접 확인해 주세요.</div>`
    : "";
  const defs = (r.deficiencies || []).map(d =>
    `<li style="margin:3px 0"><b>${esc(d.field)}</b>${d.gubun ? " · " + esc(d.gubun) : ""}${d.law ? ` <span style="color:#888">(${esc(d.law)})</span>` : ""}<br>${esc(d.summary)}${d.remark ? ` <span style="color:#0f8a5f">— ${esc(d.remark)}</span>` : ""}</li>`
  ).join("");
  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;color:#666">${esc(r.regDate)}<br>${esc(r.country)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top">
      <div style="font-weight:700">${esc(r.site)} ${badge}</div>
      <div style="color:#888;font-size:12px;margin:2px 0 6px">${esc(r.address)}</div>
      ${defs ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#333">${defs}</ul>` : ""}
      ${hold}
      <a href="${DOWN}${esc(r.docId)}" style="font-size:12px;color:#1367d6;text-decoration:none">⬇ 원본 실사결과서(PDF)</a>
    </td>
  </tr>`;
}).join("");

const subject = `${isSample ? "[테스트] " : ""}[GMP 실사결과] 신규 ${fresh.length}건 등록 (지적 ${withDef}곳 · ${items}항목${review ? ` · 확인중 ${review}곳` : ""})`;
const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  <h2 style="font-size:18px;margin:0 0 4px">의약품등 GMP 실사 결과공개 — 신규 갱신 알림</h2>
  <p style="color:#666;font-size:13px;margin:0 0 16px">최신 등록일 ${esc(today)} 기준 · 새로 추가된 <b>${fresh.length}건</b> (지적사항 있는 곳 ${withDef}, 총 지적항목 ${items}${review ? `, 원문 판독 불가로 확인중 ${review}곳` : ""})</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${rowsHtml}</table>
  <p style="margin:18px 0 0;font-size:13px"><a href="${SITE}" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">전체 대시보드 보기 →</a></p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">식약처 의약품안전나라 공개데이터를 자동 정리한 참고용 알림입니다. 정확한 내용은 원본 문서를 확인하세요.</p>
</div>`;

fs.writeFileSync(path.join(ROOT, "email-body.html"), html);
emitOutput({ send: "true", subject, to: recipients.join(",") });
console.log(`SEND=true N=${fresh.length} TO=${recipients.join(",")}`);
