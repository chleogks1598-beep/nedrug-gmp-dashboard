// 식약처 본청 공지사항(m_74) + 대전지방식약청 공지사항(m_891) 감시.
// 계기: 협회 공문(제약바이오정책팀-1835, 2026-09-02) — 완제의약품 위·수탁 시 위탁자의 제조 지시
// (중단 포함)·수탁자 지시 수행 절차를 2026-12-31 까지 기준서에 반영하라는 식약처 지시.
// 관련 설명회·안내가 올라오면 바로 알기 위해 만들었다(2026-10-19 사용자 요청).
//
// 실행 모드 2가지 (change-orders.mjs 와 같은 구조):
//   1) LOCAL=1 node notice-watch.mjs
//      수집 전용(로컬 스케줄러, run-change-orders-update.mjs 가 매시간 호출). 두 게시판 1~3쪽을
//      받아, 기준선(notices.json)에 없는 글만 본문까지 열어 키워드 판정 → notices.current.json.
//   2) node notice-watch.mjs <prev.json>
//      알림 전용(notices-notify.yml). 식약처에 접속하지 않는다. 푸시된 notices.json 과 직전
//      스냅샷을 비교해 **새로 들어온 관련 글**만 메일 본문으로 만든다.
//
// 기준선은 "본 적 있는 글" 누적 목록이다(1쪽에서 밀려나도 재알림되지 않게).
// 기준선이 비어 있는 첫 실행은 현재 글 전부를 '본 것'으로 등록만 하고 알림은 보내지 않는다.
//
// 종료코드: 0 정상 / 1 접속 실패(기준선 유지 → 다음 회차 재시도) / 2 목록 구조 변경 의심
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "notices.json");
const CURFILE = path.join(ROOT, "notices.current.json");
const RECIP = path.join(ROOT, "recipients-notices.json");
const BODY = path.join(ROOT, "notice-email-body.html");
const BASE = "https://www.mfds.go.kr";
const BOARDS = [
  { id: "m_74", name: "식약처 공지사항" },
  { id: "m_891", name: "대전청 공지사항" },
];
const PAGES = 3;          // PC 가 며칠 꺼져 있어도 놓치지 않도록 1쪽(10건)보다 넉넉히
const KEEP = 1500;        // 기준선 최대 보관 건수
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };

// 관련 글 판정. 제목+본문+첨부파일명에서 본다.
//  A) 위탁·수탁이 나오고 의약품 제조 맥락이 함께 있을 것
//     ("개인정보 처리 업무 위탁 알림" 같은 행정 공지를 거르기 위해 맥락 단어를 같이 요구)
//  B) 제목이 설명회·간담회·워크숍이고 제목·본문에 의약품 분야 단어가 있을 것 — 위·수탁이 안건 중
//     하나로 묻혀 있을 수 있다. 대전청은 '의료제품 사전사후관리 정책설명회'처럼 제목에 '의약품'을
//     안 쓰기도 하고 '정책설명회 자료'처럼 제목만으론 분야를 알 수 없기도 해서 본문까지 본다.
//     ('제조'는 식품 제조업 설명회도 걸어서 B 에선 뺐다)
const RE_CONSIGN = /위\s*[·ㆍ・.]?\s*수탁|위탁|수탁/;
const RE_DRUG = /의약품|제조|GMP|기준서|제약/;
const RE_EVENT = /설명회|간담회|워크숍|워크샵/;
const RE_FIELD = /의약품|의료제품|GMP|제약/;
// 기관명 속 '의약품'(식품의약품안전처 등)이 모든 글에 걸리므로 판정 전에 지운다.
// 이걸 안 지우면 '개인정보 처리 업무 위탁 알림' 같은 글이 위·수탁으로 오탐된다(2026-10-19 확인).
const RE_ORG = /(?:지방)?식품의약품안전(?:처|청|평가원)|의약품안전나라|식품의약품/g;
function classify(title, text) {
  title = title.replace(RE_ORG, " ");
  const all = title + " " + text.replace(RE_ORG, " ");
  const kw = [];
  if (RE_CONSIGN.test(all) && RE_DRUG.test(all)) kw.push("위·수탁");
  if (RE_EVENT.test(title) && RE_FIELD.test(all)) kw.push("의약품 설명회");
  if (/제조\s*(지시|중단)/.test(all)) kw.push("제조 지시·중단");
  return kw;
}

const clean = s => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function emit(o) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

async function get(url) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw new Error(`접속 실패 ${url}: ${last?.cause?.code || last?.message}`);
}

function parseList(html) {
  return [...html.matchAll(/href="\.\/view\.do\?seq=(\d+)[^"]*"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="right_column">([^<]*)</g)]
    .map(m => ({ seq: m[1], title: clean(m[2]), date: m[3].trim() }));
}
function parseBody(html) {
  const i = html.indexOf('class="bv_contents"');
  if (i < 0) return "";
  const j = html.indexOf("bbs_satisfaction", i);
  return clean(html.slice(i, j > 0 ? j : i + 60000)).slice(0, 20000);
}

async function collect() {
  const prev = readJson(SNAP, null);
  const seen = new Map((prev?.items || []).map(x => [x.key, x]));
  const fresh = [];
  for (const b of BOARDS) {
    let total = 0;
    for (let p = 1; p <= PAGES; p++) {
      const rows = parseList(await get(`${BASE}/brd/${b.id}/list.do?page=${p}`));
      if (p === 1 && rows.length === 0) {
        console.error(`STRUCTURE_CHANGED ${b.id}: 목록에서 글을 하나도 못 찾았습니다`);
        process.exit(2);
      }
      total += rows.length;
      for (const r of rows) {
        const key = `${b.id}/${r.seq}`;
        if (seen.has(key) || fresh.some(x => x.key === key)) continue;
        const url = `${BASE}/brd/${b.id}/view.do?seq=${r.seq}`;
        // 첫 실행(기준선 없음)은 등록만 하므로 본문을 열지 않는다
        const text = prev ? parseBody(await get(url)) : "";
        fresh.push({ key, board: b.id, boardName: b.name, seq: r.seq, title: r.title, date: r.date, url,
          kw: prev ? classify(r.title, text) : [], firstSeen: new Date().toISOString() });
      }
    }
    console.log(`${b.name}: 목록 ${total}행 확인`);
  }
  const items = [...fresh, ...seen.values()].slice(0, KEEP);
  fs.writeFileSync(CURFILE, JSON.stringify({ items }, null, 1) + "\n");
  const hits = fresh.filter(x => x.kw.length);
  console.log(prev ? `신규 글 ${fresh.length}건 / 관련 ${hits.length}건${hits.map(h => ` · [${h.boardName}] ${h.title}`).join("")}`
                   : `기준선 초기화 — ${fresh.length}건 등록(알림 없음)`);
}

function notify(prevFile) {
  const prev = readJson(prevFile, null);
  const cur = readJson(SNAP, { items: [] });
  if (!prev) { console.log("직전 스냅샷 없음(첫 등록) — 알림 생략"); emit({ send: "false" }); return; }
  const old = new Set((prev.items || []).map(x => x.key));
  let hits = cur.items.filter(x => !old.has(x.key) && x.kw?.length);
  if (Number(process.env.SAMPLE) > 0) hits = cur.items.slice(0, Number(process.env.SAMPLE)).map(x => ({ ...x, kw: x.kw?.length ? x.kw : ["테스트"] }));
  if (!hits.length) { console.log("관련 신규 글 없음"); emit({ send: "false" }); return; }

  const to = readJson(RECIP, null);
  if (!Array.isArray(to) || !to.length) { console.error("RECIPIENTS_ERROR recipients-notices.json"); process.exit(1); }

  const rows = hits.map(h => `<tr><td style="border:1px solid #ccc;padding:4px 6px">${esc(h.boardName)}</td>`
    + `<td style="border:1px solid #ccc;padding:4px 6px">${esc(h.date)}</td>`
    + `<td style="border:1px solid #ccc;padding:4px 6px"><a href="${esc(h.url)}">${esc(h.title)}</a></td>`
    + `<td style="border:1px solid #ccc;padding:4px 6px">${esc(h.kw.join(", "))}</td></tr>`).join("");
  const html = `<div style="font-family:'Malgun Gothic',sans-serif;font-size:13px">
<p>식약처·대전청 공지사항에 <b>위·수탁 / 의약품 설명회</b> 관련 글이 새로 올라왔습니다.</p>
<table style="border-collapse:collapse;font-size:13px" border="1" cellpadding="4">
<tr style="background:#f0f0f0"><th>게시판</th><th>등록일</th><th>제목</th><th>걸린 키워드</th></tr>${rows}</table>
<p style="color:#666;font-size:12px">감시 배경: 한국제약바이오협회 제약바이오정책팀-1835(2026.09.02) — 완제의약품 위·수탁 업무 관련 기준서 반영(기한 ’26.12.31.).<br>
키워드로 자동 판정한 것이라 관련 없는 글이 섞일 수 있습니다.</p></div>`;
  fs.writeFileSync(BODY, html);
  const subject = `[식약처 공지 알림] ${hits[0].title}${hits.length > 1 ? ` 외 ${hits.length - 1}건` : ""}`.replace(/[\r\n]/g, " ");
  emit({ send: "true", to: to.join(","), subject });
  console.log(`발송 대상 ${hits.length}건 → ${to.join(", ")}`);
}

try {
  if (process.argv[2]) notify(process.argv[2]);
  else await collect();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
