// Monitor MFDS 변경명령 list (CCBAR01F012). Detect NEW items and CHANGED items
// (진행단계/진행상태/허가반영일자) vs a stored snapshot, and build an email.
//
// Files (repo root):
//   change-orders.json            – committed baseline of last-alerted items
//   change-orders.current.json    – (written each run) current fetch; workflow promotes it to baseline
//   recipients-change-orders.json – ["a@x.com", ...]
// Output: writes ./co-email-body.html ; emits GITHUB_OUTPUT send/subject/to/promote ; prints status.
//
// 실행 모드 3가지 — 어느 모드든 diff·메일 본문 코드는 하나를 공유한다.
//   1) LOCAL=1 node change-orders.mjs
//      **수집 전용**(로컬 스케줄러). 식약처에서 받아 change-orders.current.json 만 쓰고
//      신규·변경 건수를 로그로 남긴다. 메일은 보내지 않는다 — 커밋·푸시는 러너
//      (scripts/run-change-orders-update.mjs)가, 메일은 푸시를 받은 change-orders-notify.yml 이.
//   2) node change-orders.mjs <prev.json>
//      **알림 전용**(change-orders-notify.yml). 식약처에 접속하지 않는다. 방금 푸시된
//      change-orders.json 을 현재값으로, 인수로 받은 직전 스냅샷을 기준선으로 diff 해서
//      메일 본문만 만든다. 클라우드에서 식약처가 막혀도(UND_ERR_CONNECT_TIMEOUT) 무관하다.
//   3) node change-orders.mjs
//      **직접 감시**(change-orders.yml, PC 가 꺼져 있을 때를 위한 안전망). 예전 방식 그대로
//      받아서 diff 하고 메일까지 보낸다. 식약처가 클라우드 IP 를 간헐 차단하므로 실패할 수 있다.
//
// promote=true  -> workflow may advance baseline (change-orders.json := current)
// promote=false -> keep baseline (changes detected but not emailed → re-alert next run)
// The workflow only reaches the promote step if the email step did not fail, so a failed
// send keeps the baseline and retries next run.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const SNAP = path.join(ROOT, "change-orders.json");
const CURFILE = path.join(ROOT, "change-orders.current.json");
const RECIP = path.join(ROOT, "recipients-change-orders.json");
const BODY = path.join(ROOT, "co-email-body.html");
const LIST_URL = "https://nedrug.mfds.go.kr/CCBAR01F012/getList";
const BASE = "https://nedrug.mfds.go.kr";

const clean = s => (s == null ? "" : String(s))
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const esc = s => (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };

function parseList(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const target = tables.find(t => t.includes("getItem")) || "";
  const trs = target.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const recs = [];
  for (const r of trs) {
    const m = r.match(/getItem\?infoNo=(\d+)&(?:amp;)?infoClassCode=(\d+)/);
    if (!m) continue;
    const tds = [...r.matchAll(/<td[\s\S]*?<\/td>/gi)].map(x => clean(x[0]));
    const infoNo = m[1], infoClassCode = m[2];
    recs.push({
      key: infoNo + "/" + infoClassCode, infoNo, infoClassCode,
      title: tds[1] || "", type: tds[2] || "", status: tds[3] || "",
      reflectDate: tds[4] || "", stage: tds[5] || "", regDate: tds[6] || "",
      url: `${BASE}/CCBAR01F012/getList/getItem?infoNo=${infoNo}&infoClassCode=${infoClassCode}`,
    });
  }
  return recs;
}

function emit(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

async function fetchRetry(url, opts, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) {
      last = e;
      const c = e && e.cause ? (e.cause.code || e.cause.message) : e.message;
      console.log(`  fetch 시도 ${i + 1}/${tries} 실패(${c}) — 재시도`);
      await new Promise(s => setTimeout(s, 3000 * (i + 1)));
    }
  }
  throw last;
}

async function fetchList() {
  const res = await fetchRetry(LIST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "ko-KR,ko;q=0.9",
    },
    body: "keyword=&page=1&limit=100000&title=&registDateStart=&registDateEnd=&searchYn=&sort=&sortOrder=",
  });
  const cur = parseList(await res.text());
  if (cur.length < 50) throw new Error("suspiciously few rows: " + cur.length);
  return cur;
}

// 기준선(prev) 대비 신규·변경 항목. 세 모드가 모두 이 함수를 쓴다.
function diffSnapshots(prev, cur) {
  const prevMap = new Map(prev.map(r => [r.key, r]));
  const fresh = cur.filter(r => !prevMap.has(r.key));
  const changed = [];
  for (const r of cur) {
    const p = prevMap.get(r.key);
    if (!p) continue;
    const diffs = [];
    if (r.stage !== p.stage) diffs.push(["진행단계", p.stage, r.stage]);
    if (r.status !== p.status) diffs.push(["진행상태", p.status, r.status]);
    if (r.reflectDate !== p.reflectDate) diffs.push(["허가반영일자", p.reflectDate || "(없음)", r.reflectDate || "(없음)"]);
    if (diffs.length) changed.push({ r, diffs });
  }
  return { fresh, changed };
}

const shell = inner => `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;color:#1a2733">
  ${inner}
  <p style="margin:18px 0 0;font-size:13px"><a href="${LIST_URL}" style="background:#1367d6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">변경명령 목록 열기 →</a></p>
  <p style="color:#aaa;font-size:11px;margin-top:20px">식약처 의약품안전나라 공개데이터 자동 모니터링 알림입니다.</p>
</div>`;

const stageRow = r => `<tr>
  <td style="padding:9px 12px;border-bottom:1px solid #eee;vertical-align:top">
    <a href="${esc(r.url)}" style="font-weight:700;color:#1367d6;text-decoration:none">${esc(r.title)}</a>
    <div style="color:#888;font-size:12px;margin-top:2px">${esc(r.type)} · 최초등록 ${esc(r.regDate)}</div>
  </td>
  <td style="padding:9px 12px;border-bottom:1px solid #eee;white-space:nowrap;color:#c2410c;font-weight:700">${esc(r.stage)}</td>
</tr>`;

function buildEmail(fresh, changed) {
  const changedRows = changed.map(({ r, diffs }) => `<tr>
    <td style="padding:9px 12px;border-bottom:1px solid #eee;vertical-align:top">
      <a href="${esc(r.url)}" style="font-weight:700;color:#1367d6;text-decoration:none">${esc(r.title)}</a>
      <div style="color:#888;font-size:12px;margin-top:2px">${esc(r.type)}</div>
    </td>
    <td style="padding:9px 12px;border-bottom:1px solid #eee;font-size:13px">
      ${diffs.map(d => `${esc(d[0])}: <span style="color:#888">${esc(d[1])}</span> → <b style="color:#0f8a5f">${esc(d[2])}</b>`).join("<br>")}
    </td>
  </tr>`).join("");

  const subject = `[의약품 변경명령] 신규 ${fresh.length}건 · 변경 ${changed.length}건`;
  const html = shell(`<h2 style="font-size:18px;margin:0 0 4px">의약품 허가·승인 변경명령 — 업데이트 알림</h2>
    <p style="color:#666;font-size:13px;margin:0 0 16px">식약처 의약품안전나라 기준 · 신규 <b>${fresh.length}건</b>, 진행 변경 <b>${changed.length}건</b> 감지</p>
    ${fresh.length ? `<h3 style="font-size:14px;margin:14px 0 6px">🆕 신규 변경명령</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${fresh.map(stageRow).join("")}</table>` : ""}
    ${changed.length ? `<h3 style="font-size:14px;margin:18px 0 6px">🔄 진행상황 변경</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${changedRows}</table>` : ""}`);
  return { subject, html };
}

// 변화를 감지했는데 수신자가 없으면 조용히 초록으로 끝나선 안 된다 — 아무도 못 받고 있다는
// 걸 알 수 없기 때문이다. 설정 오류로 드러나게 실패시킨다.
function recipientsOrDie(fresh, changed) {
  let recipients = [], recipError = "";
  try { recipients = JSON.parse(fs.readFileSync(RECIP, "utf8")).filter(x => typeof x === "string" && x.includes("@")); }
  catch (e) { recipError = e.message; }
  if (recipients.length === 0) {
    emit({ send: "false", promote: "false" });
    console.error(
      `RECIPIENTS_ERROR: 변화 감지(신규 ${fresh.length}, 변경 ${changed.length})했으나 수신자가 없습니다 — ${RECIP} 확인 필요.` +
        (recipError ? ` (읽기 실패: ${recipError})` : "") +
        " 고치고 다시 돌리면(보정 발송) 재알림됩니다.",
    );
    process.exit(1);
  }
  return recipients;
}

// 모드 2) 알림 전용 — 방금 푸시된 스냅샷 vs 직전 커밋의 스냅샷. 식약처 접속 없음.
function notifyFromSnapshots(prevFile) {
  const prev = readJson(prevFile, null);
  const cur = readJson(SNAP, null);
  if (!Array.isArray(cur)) throw new Error(`현재 스냅샷을 읽을 수 없습니다: ${SNAP}`);
  // 직전 커밋에 파일이 없던 첫 회차라면 전건이 '신규'로 쏟아진다 — 알림이 아니라 시딩이다.
  if (!Array.isArray(prev)) {
    emit({ send: "false" });
    console.log(`SEED: 직전 스냅샷 없음(${prevFile}) → 기준선 시딩으로 보고 메일 생략 (현재 ${cur.length}건).`);
    return;
  }

  const { fresh, changed } = diffSnapshots(prev, cur);
  if (fresh.length === 0 && changed.length === 0) {
    emit({ send: "false" });
    console.log(`SEND=false 변화 없음 (기준선 ${prev.length}건 → 현재 ${cur.length}건).`);
    return;
  }
  const recipients = recipientsOrDie(fresh, changed);
  const { subject, html } = buildEmail(fresh, changed);
  fs.writeFileSync(BODY, html);
  emit({ send: "true", subject, to: recipients.join(",") });
  console.log(`SEND=true 신규 ${fresh.length} 변경 ${changed.length} → ${recipients.join(",")}`);
}

async function main() {
  // 테스트 발송 모드: SAMPLE=N → 저장된 기준선 스냅샷에서 N건으로 샘플 메일 (MFDS 접속 불필요, 기준선 미변경)
  const SAMPLE = parseInt(process.env.SAMPLE || "0", 10);
  if (SAMPLE > 0) {
    let rcpt = [];
    try { rcpt = JSON.parse(fs.readFileSync(RECIP, "utf8")).filter(x => typeof x === "string" && x.includes("@")); } catch {}
    if (rcpt.length === 0) { emit({ send: "false", promote: "false" }); console.log("SAMPLE: 수신자 없음"); return; }
    const items = readJson(SNAP, []).slice(0, SAMPLE);
    const subject = `[테스트] [의약품 변경명령] 발송 확인 (샘플 ${items.length}건)`;
    const html = shell(`<h2 style="font-size:18px;margin:0 0 4px">✅ 변경명령 알림 — 테스트 메일</h2>
      <p style="color:#666;font-size:13px;margin:0 0 16px">이 메일은 <b>발송 동작 확인용 테스트</b>입니다. 앞으로 실제로 신규 변경명령이 등록되거나 진행단계가 바뀌면 이런 형식으로 자동 발송됩니다. (아래는 현재 목록 예시 ${items.length}건)</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border-top:2px solid #1a2733">${items.map(stageRow).join("")}</table>`);
    fs.writeFileSync(BODY, html);
    emit({ send: "true", subject, to: rcpt.join(","), promote: "false" });
    console.log(`SAMPLE SEND=true ${items.length}건 → ${rcpt.join(",")}`);
    return;
  }

  // 모드 2) 알림 전용: 인수로 직전 스냅샷 파일을 받으면 식약처에 접속하지 않는다.
  const prevFile = process.argv[2];
  if (prevFile) return notifyFromSnapshots(prevFile);

  const cur = await fetchList();
  fs.writeFileSync(CURFILE, JSON.stringify(cur, null, 2));

  // 모드 1) 수집 전용(로컬 스케줄러): 건수만 로그로 남기고 끝. 커밋·푸시는 러너, 메일은 워크플로우.
  if (process.env.LOCAL) {
    const prev = readJson(SNAP, null);
    if (!Array.isArray(prev)) { console.log(`FETCHED ${cur.length}건 — 기준선 없음(첫 회차).`); return; }
    const { fresh, changed } = diffSnapshots(prev, cur);
    console.log(`FETCHED ${cur.length}건 (기준선 ${prev.length}건) 신규 ${fresh.length} 변경 ${changed.length}`);
    for (const r of fresh.slice(0, 10)) console.log(`  [신규] ${r.title} — ${r.stage}`);
    for (const { r, diffs } of changed.slice(0, 10)) console.log(`  [변경] ${r.title} — ${diffs.map(d => `${d[0]} ${d[1]}→${d[2]}`).join(", ")}`);
    return;
  }

  // 모드 3) 직접 감시(안전망): 받아서 diff 하고 메일까지.
  if (!fs.existsSync(SNAP)) {
    emit({ send: "false", promote: "true" });
    console.log(`SEED: 기준선 없음 → 이번 실행에서 baseline 설정 (${cur.length}건). 메일 없음.`);
    return;
  }

  const { fresh, changed } = diffSnapshots(readJson(SNAP, []), cur);
  if (fresh.length === 0 && changed.length === 0) {
    emit({ send: "false", promote: "true" });
    console.log("변화 없음 (신규 0, 변경 0).");
    return;
  }

  const recipients = recipientsOrDie(fresh, changed);
  const { subject, html } = buildEmail(fresh, changed);
  fs.writeFileSync(BODY, html);
  emit({ send: "true", subject, to: recipients.join(","), promote: "true" });
  console.log(`SEND=true 신규 ${fresh.length} 변경 ${changed.length} → ${recipients.join(",")}`);
}
main().catch(e => {
  const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
  console.error("CO_ERROR:", e.message, cause ? "| cause: " + cause : "");
  process.exit(1);
});
