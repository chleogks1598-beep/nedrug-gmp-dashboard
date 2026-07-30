// Watchdog: report GMP 실사결과 records that MFDS has published but the dashboard
// hasn't absorbed yet (i.e. sitting in ./pending). Two kinds of alert:
//
//   감지  – docIds that appeared in pending for the first time (informational)
//   경고  – docIds still unprocessed more than STALE_HOURS after first detection
//           → the daily extraction step is broken and would otherwise fail silently
//
// State lives in pending-state.json: { docs: {docId: {firstSeen, site, regDate}}, lastWarnAt }
// Recipients: recipients-ops.json (falls back to recipients.json).
// Writes ./gmp-pending-email.html and prints "SEND=true|false ...";
// emits send/subject/to to GITHUB_OUTPUT when running in Actions.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const MANIFEST = path.join(ROOT, "pending", "manifest.json");
const STATE = path.join(ROOT, "pending-state.json");
const SITE = "https://chleogks1598-beep.github.io/nedrug-gmp-dashboard/";
const DOWN = "https://nedrug.mfds.go.kr/cmn/edms/down/";
const STALE_HOURS = Number(process.env.STALE_HOURS || 26);
const WARN_EVERY_HOURS = 20; // at most one 경고 per daily run

const esc = s => (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } };

const emitOutput = obj => {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
};

let recipients = readJson(path.join(ROOT, "recipients-ops.json"), null)
  || readJson(path.join(ROOT, "recipients.json"), []);
recipients = (Array.isArray(recipients) ? recipients : []).filter(x => typeof x === "string" && x.includes("@"));

const pending = readJson(MANIFEST, []);
const state = readJson(STATE, { docs: {}, lastWarnAt: null });
state.docs = state.docs || {};
const now = new Date();
const nowIso = now.toISOString();

// drop entries that are no longer pending (they made it into the dashboard)
const pendingIds = new Set(pending.map(r => r.docId));
const resolved = Object.keys(state.docs).filter(id => !pendingIds.has(id));
for (const id of resolved) delete state.docs[id];

// record newcomers
const fresh = [];
for (const r of pending) {
  if (!state.docs[r.docId]) {
    state.docs[r.docId] = { firstSeen: nowIso, site: r.site, regDate: r.regDate };
    fresh.push(r);
  }
}

const hoursSince = iso => (now - new Date(iso)) / 36e5;
const stale = pending.filter(r => hoursSince(state.docs[r.docId].firstSeen) >= STALE_HOURS);
const warnDue = stale.length > 0
  && (!state.lastWarnAt || hoursSince(state.lastWarnAt) >= WARN_EVERY_HOURS);

const rows = list => list.map(r => {
  const seen = state.docs[r.docId];
  const age = seen ? Math.floor(hoursSince(seen.firstSeen)) : 0;
  return `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${esc(r.regDate)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee"><b>${esc(r.site)}</b>
      <div style="color:#888;font-size:12px">${esc(r.address || "")}</div>
      <a href="${DOWN}${esc(r.docId)}" style="font-size:12px;color:#1367d6;text-decoration:none">⬇ 원본 실사결과서</a></td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${age}시간 경과</td>
  </tr>`;
}).join("");

if (pending.length === 0 || recipients.length === 0 || (fresh.length === 0 && !warnDue)) {
  if (warnDue) state.lastWarnAt = nowIso;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  emitOutput({ send: "false" });
  console.log(`SEND=false PENDING=${pending.length} FRESH=${fresh.length} STALE=${stale.length}`
    + (recipients.length === 0 ? " (수신자 없음: recipients-ops.json 확인)" : ""));
  process.exit(0);
}

if (warnDue) state.lastWarnAt = nowIso;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

const subject = warnDue
  ? `⚠ [GMP 미반영 경고] 신규 ${pending.length}건이 대시보드에 반영되지 않았습니다`
  : `[GMP 감지] 신규 ${pending.length}건 — 지적사항 추출 대기`;

const warnBlock = warnDue ? `
  <div style="background:#fdece2;border-left:4px solid #c2410c;padding:12px 14px;margin:0 0 16px;font-size:13px;color:#7c2d12">
    <b>${stale.length}건이 ${STALE_HOURS}시간 넘게 처리되지 않았습니다.</b><br>
    매일 08시 지적사항 추출·반영 단계가 동작하지 않고 있을 가능성이 높습니다. 확인이 필요합니다.
  </div>` : "";

const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  <h2 style="font-size:18px;margin:0 0 4px">GMP 실사결과 — 신규 감지 ${warnDue ? "및 미반영 경고" : "알림"}</h2>
  <p style="color:#666;font-size:13px;margin:0 0 16px">식약처에 공개됐지만 대시보드에 아직 반영되지 않은 <b>${pending.length}건</b>${fresh.length ? ` (이번에 새로 감지 ${fresh.length}건)` : ""}</p>
  ${warnBlock}
  <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${rows(pending)}</table>
  <p style="margin:18px 0 0;font-size:13px"><a href="${SITE}" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">대시보드 열기 →</a></p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">이 메일은 수집 단계(GitHub Actions)가 보내는 운영용 알림입니다. 지적사항 상세가 포함된 정식 알림은 대시보드 반영 후 별도로 발송됩니다.</p>
</div>`;

fs.writeFileSync(path.join(ROOT, "gmp-pending-email.html"), html);
emitOutput({ send: "true", subject, to: recipients.join(",") });
console.log(`SEND=true PENDING=${pending.length} FRESH=${fresh.length} STALE=${stale.length} WARN=${warnDue} TO=${recipients.join(",")}`);
