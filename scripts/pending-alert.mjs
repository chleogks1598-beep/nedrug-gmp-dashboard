// Watchdog for the GMP pipeline. Guards the two ways it can go quiet:
//
//   1) 추출 단계가 멈춤 — 식약처엔 공개됐는데 pending/ 에 그대로 남아 대시보드에 안 들어감
//   2) 수집 단계가 멈춤 — 식약처가 클라우드 IP를 계속 막아 목록 조회 자체가 안 됨
//
// Alerts (운영용 수신자 recipients-ops.json, 없으면 recipients.json):
//   감지  – pending 에 처음 나타난 docId (정보성, 1회)
//   경고  – STALE_HOURS 넘게 미반영, 또는 FETCH_STALE_HOURS 넘게 수집 성공 기록 없음
//
// State: pending-state.json { docs: {docId:{firstSeen,site,regDate}}, lastWarnAt, lastFetchOkAt }
// Env:   FETCH_OK=true|false (이번 실행의 식약처 접속 성공 여부)
// Out:   ./gmp-pending-email.html + "SEND=true|false ..." + GITHUB_OUTPUT(send/subject/to)
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
const FETCH_STALE_HOURS = Number(process.env.FETCH_STALE_HOURS || 24);
const WARN_EVERY_HOURS = Number(process.env.WARN_EVERY_HOURS || 20);
const FETCH_OK = process.env.FETCH_OK !== "false"; // 미지정이면 성공으로 간주(로컬 실행)

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
const state = readJson(STATE, {});
state.docs = state.docs || {};
const now = new Date();
const nowIso = now.toISOString();
const hoursSince = iso => (now - new Date(iso)) / 36e5;

// 수집 성공 시각 기록 (한 번도 없으면 이번 시각을 기준선으로 삼아 시계를 시작)
if (FETCH_OK || !state.lastFetchOkAt) state.lastFetchOkAt = nowIso;
const fetchStale = !FETCH_OK && hoursSince(state.lastFetchOkAt) >= FETCH_STALE_HOURS;

// 대시보드에 들어간 항목은 상태에서 제거
const pendingIds = new Set(pending.map(r => r.docId));
for (const id of Object.keys(state.docs)) if (!pendingIds.has(id)) delete state.docs[id];

// 새로 감지된 항목 기록
const fresh = [];
for (const r of pending) {
  if (!state.docs[r.docId]) {
    state.docs[r.docId] = { firstSeen: nowIso, site: r.site, regDate: r.regDate };
    fresh.push(r);
  }
}

const stale = pending.filter(r => hoursSince(state.docs[r.docId].firstSeen) >= STALE_HOURS);
const warnable = stale.length > 0 || fetchStale;
const warnDue = warnable && (!state.lastWarnAt || hoursSince(state.lastWarnAt) >= WARN_EVERY_HOURS);
const send = recipients.length > 0 && (fresh.length > 0 || warnDue);

if (warnDue) state.lastWarnAt = nowIso;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

const status = `PENDING=${pending.length} FRESH=${fresh.length} STALE=${stale.length} FETCH_OK=${FETCH_OK}`
  + ` FETCH_STALE=${fetchStale} WARN=${warnDue}`;

if (!send) {
  emitOutput({ send: "false" });
  console.log(`SEND=false ${status}` + (recipients.length === 0 ? " (수신자 없음: recipients-ops.json 확인)" : ""));
  process.exit(0);
}

const rows = pending.map(r => {
  const age = Math.floor(hoursSince(state.docs[r.docId].firstSeen));
  return `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${esc(r.regDate)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee"><b>${esc(r.site)}</b>
      <div style="color:#888;font-size:12px">${esc(r.address || "")}</div>
      <a href="${DOWN}${esc(r.docId)}" style="font-size:12px;color:#1367d6;text-decoration:none">⬇ 원본 실사결과서</a></td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${age}시간 경과</td>
  </tr>`;
}).join("");

const warnBox = msg => `<div style="background:#fdece2;border-left:4px solid #c2410c;padding:12px 14px;margin:0 0 14px;font-size:13px;color:#7c2d12">${msg}</div>`;
const blocks = [];
if (stale.length > 0 && warnDue) blocks.push(warnBox(
  `<b>${stale.length}건이 ${STALE_HOURS}시간 넘게 대시보드에 반영되지 않았습니다.</b><br>`
  + `매일 08시 지적사항 추출·반영 단계가 동작하지 않고 있을 가능성이 높습니다.`));
if (fetchStale && warnDue) blocks.push(warnBox(
  `<b>${Math.floor(hoursSince(state.lastFetchOkAt))}시간째 식약처 목록 조회에 성공하지 못했습니다.</b><br>`
  + `식약처가 클라우드 IP를 차단하고 있을 수 있습니다. 신규 공개 건을 놓치고 있을 수 있으니 확인이 필요합니다.`));

const subject = warnDue
  ? (fetchStale && stale.length === 0
      ? `⚠ [GMP 수집중단 경고] 식약처 목록 조회 실패가 계속되고 있습니다`
      : `⚠ [GMP 미반영 경고] 신규 ${pending.length}건이 대시보드에 반영되지 않았습니다`)
  : `[GMP 감지] 신규 ${pending.length}건 — 지적사항 추출 대기`;

const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  <h2 style="font-size:18px;margin:0 0 4px">GMP 파이프라인 알림</h2>
  <p style="color:#666;font-size:13px;margin:0 0 16px">식약처에 공개됐지만 대시보드에 아직 반영되지 않은 <b>${pending.length}건</b>${fresh.length ? ` (이번에 새로 감지 ${fresh.length}건)` : ""}</p>
  ${blocks.join("")}
  ${pending.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${rows}</table>` : ""}
  <p style="margin:18px 0 0;font-size:13px"><a href="${SITE}" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">대시보드 열기 →</a></p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">수집 단계(GitHub Actions)가 보내는 운영용 알림입니다. 지적사항 상세가 포함된 정식 알림은 대시보드 반영 후 별도로 발송됩니다.</p>
</div>`;

fs.writeFileSync(path.join(ROOT, "gmp-pending-email.html"), html);
emitOutput({ send: "true", subject, to: recipients.join(",") });
console.log(`SEND=true ${status} TO=${recipients.join(",")}`);
