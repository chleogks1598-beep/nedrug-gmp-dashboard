// 회수·폐기 / 행정처분 신규·변경 알림 메일 본문 생성.
//
//   node scripts/build-safety-email.mjs <prev-recall.json> <prev-admin.json>
//
// 직전 스냅샷과 비교해 신규(키가 없던 건)와 변경(목록 필드가 바뀐 건)을 뽑는다.
// 결과: ./safety-email-body.html + stdout "SEND=true|false" (+ Actions output)
// 수신자: recipients-safety.json
import fs from "fs";
import path from "path";
import { ROOT, SOURCES } from "./safety-common.mjs";

const RECIP = path.join(ROOT, "recipients-safety.json");
const SITE = "https://chleogks1598-beep.github.io/nedrug-gmp-dashboard";

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

let recipients = [];
let recipError = "";
try {
  recipients = JSON.parse(fs.readFileSync(RECIP, "utf8")).filter(x => typeof x === "string" && x.includes("@"));
} catch (e) { recipError = e.message; }
if (recipients.length === 0 && process.env.RECIPIENT) recipients = [process.env.RECIPIENT];

const readJson = p => {
  try { return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; }
  catch { return []; }
};

const SAMPLE = parseInt(process.env.SAMPLE || "0", 10);
const prevPaths = { recall: process.argv[2], admin: process.argv[3] };

const diff = {};
for (const id of ["recall", "admin"]) {
  const src = SOURCES[id];
  const cur = readJson(path.join(ROOT, "public", src.dataFile));
  const prev = readJson(prevPaths[id]);
  const prevByKey = new Map(prev.map(r => [r.key, r]));
  if (SAMPLE > 0) {
    diff[id] = { fresh: cur.filter(r => !r.delisted).slice(0, SAMPLE), changed: [], total: cur.length };
    continue;
  }
  const fresh = cur.filter(r => !prevByKey.has(r.key));
  const changed = cur.filter(r => {
    const p = prevByKey.get(r.key);
    return p && p.listSig !== r.listSig;
  });
  diff[id] = { fresh, changed, total: cur.length };
}

const nFresh = diff.recall.fresh.length + diff.admin.fresh.length;
const nChanged = diff.recall.changed.length + diff.admin.changed.length;

function emitOutput(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

if (nFresh + nChanged === 0) {
  emitOutput({ send: "false" });
  console.log("SEND=false NEW=0 CHANGED=0");
  process.exit(0);
}
// 보낼 게 있는데 수신자가 없으면 조용히 넘어가지 않는다(아무도 못 받는 걸 알 방법이 없어진다).
if (recipients.length === 0) {
  console.error(`RECIPIENTS_ERROR: 알릴 내용 ${nFresh + nChanged}건이 있는데 수신자가 없습니다 — ${RECIP} 확인 필요.` +
    (recipError ? ` (읽기 실패: ${recipError})` : ""));
  process.exit(1);
}

const cell = "padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top";
const chip = (t, bg, fg) =>
  `<span style="background:${bg};color:${fg};border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">${esc(t)}</span>`;

const recallRow = r => {
  const d = r.detail || {};
  const name = d.itemName || r.itemName || "";
  const lots = (d.makeNo || r.makeNo || "").split(",").map(s => s.trim()).filter(Boolean);
  return `<tr>
    <td style="${cell};white-space:nowrap;color:#666">${esc(r.recallDate || "")}</td>
    <td style="${cell}">
      <div style="font-weight:700">${esc(name)}</div>
      <div style="color:#888;font-size:12px;margin:2px 0 6px">${esc(r.entpName || "")}${d.entpAddr ? " · " + esc(d.entpAddr) : ""}</div>
      <div style="font-size:13px;color:#333">${esc(r.reason || "")}</div>
      ${lots.length ? `<div style="color:#888;font-size:11.5px;margin-top:5px">제조번호 ${esc(lots.slice(0, 4).join(", "))}${lots.length > 4 ? ` 외 ${lots.length - 4}건` : ""}</div>` : ""}
    </td>
  </tr>`;
};

const adminRow = r => {
  const d = r.detail || {};
  return `<tr>
    <td style="${cell};white-space:nowrap;color:#666">${esc(r.dispsDate || "")}</td>
    <td style="${cell}">
      <div style="font-weight:700">${esc(r.entpName || "")}${r.itemName ? ` <span style="font-weight:400;color:#555">— ${esc(r.itemName)}</span>` : ""}</div>
      <div style="color:#888;font-size:12px;margin:2px 0 6px">${esc(d.bizType || "")}${d.addr ? " · " + esc(d.addr) : ""}</div>
      <div style="font-size:13px;color:#333">${esc(r.dispsName || "")}</div>
      ${d.violation ? `<div style="color:#c2410c;font-size:12.5px;margin-top:5px">위반: ${esc(d.violation).replace(/\n/g, "<br>")}</div>` : ""}
    </td>
  </tr>`;
};

const section = (title, rows, rowFn, link) => rows.length
  ? `<h3 style="font-size:15px;margin:22px 0 8px">${esc(title)} <span style="color:#888;font-weight:400;font-size:13px">${rows.length}건</span></h3>
     <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${rows.map(rowFn).join("")}</table>
     <div style="margin-top:8px"><a href="${link}" style="font-size:12px;color:#1367d6;text-decoration:none">대시보드에서 보기 →</a></div>`
  : "";

const parts = [
  section("🔴 회수·폐기 신규", diff.recall.fresh, recallRow, `${SITE}/recall/`),
  section("🟠 행정처분 신규", diff.admin.fresh, adminRow, `${SITE}/admin/`),
  section("✏️ 회수·폐기 내용 변경", diff.recall.changed, recallRow, `${SITE}/recall/`),
  section("✏️ 행정처분 내용 변경", diff.admin.changed, adminRow, `${SITE}/admin/`),
].join("");

const bits = [];
if (diff.recall.fresh.length) bits.push(`회수·폐기 ${diff.recall.fresh.length}건`);
if (diff.admin.fresh.length) bits.push(`행정처분 ${diff.admin.fresh.length}건`);
const subject = `${SAMPLE > 0 ? "[테스트] " : ""}[의약품 안전성정보] ${bits.join(" · ") || "내용 변경"}${nChanged && bits.length ? ` (변경 ${nChanged}건)` : ""}`;

const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  <h2 style="font-size:18px;margin:0 0 4px">의약품 안전성정보 — 신규 갱신 알림</h2>
  <p style="color:#666;font-size:13px;margin:0 0 4px">
    식약처 의약품안전나라 <b>회수·폐기</b> / <b>행정처분정보</b> 자동 수집 결과입니다.
    신규 ${nFresh}건${nChanged ? ` · 변경 ${nChanged}건` : ""}
    (보유 누계 회수 ${diff.recall.total.toLocaleString()}건 · 행정처분 ${diff.admin.total.toLocaleString()}건)
  </p>
  ${parts}
  <p style="margin:22px 0 0;font-size:13px">
    <a href="${SITE}/recall/" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">회수·폐기 대시보드</a>
    &nbsp;
    <a href="${SITE}/admin/" style="background:#1a2733;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">행정처분 대시보드</a>
  </p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">식약처 공개데이터를 자동 정리한 참고용 알림입니다. 정확한 내용은 원문을 확인하세요.</p>
</div>`;

fs.writeFileSync(path.join(ROOT, "safety-email-body.html"), html);
emitOutput({ send: "true", subject, to: recipients.join(",") });
console.log(`SEND=true NEW=${nFresh} CHANGED=${nChanged} TO=${recipients.join(",")}`);
