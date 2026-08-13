// 회수·폐기(CCBAI01) / 행정처분(CCBAO01) 수집 → public/<src>-data.json 갱신.
//
//   node scripts/safety-fetch.mjs                # 두 소스 모두
//   node scripts/safety-fetch.mjs --source=admin # 하나만
//
// 설계 원칙(GMP 파이프라인에서 데인 것들):
//  1) 부분 반영 금지 — 상세 한 건이라도 못 받으면 그 소스는 통째로 건너뛴다.
//     (반쪽 데이터를 커밋하면 그 건은 이후 'known' 이 돼서 영영 재수집되지 않는다)
//  2) 누적 보존 — 목록에서 내려간 건은 지우지 않고 delisted 표시만 한다.
//     행정처분은 공개종료가 4개월 남짓이라 안 하면 금방 사라진다.
//  3) 실패는 조용히 넘어가지 않는다 — exit 1 로 알린다.
//
// 상세 응답은 %TEMP%\nedrug-safety-cache 에 캐시해서 중단/재시도 시 이어받는다.
import fs from "fs";
import os from "os";
import path from "path";
import {
  ROOT, SOURCES, fetchRetry, listUrl, itemUrl, parseList, parseDetail, parseTotal,
} from "./safety-common.mjs";

const CACHE = path.join(os.tmpdir(), "nedrug-safety-cache");
const CONC = Number(process.env.CONC || 4);
const NO_CACHE = process.env.NO_CACHE === "1";

const arg = process.argv.find(a => a.startsWith("--source="));
const wanted = arg ? arg.split("=")[1].split(",") : Object.keys(SOURCES);

const today = () => new Date().toISOString().slice(0, 10);

// 목록 필드가 바뀌면(처분사항 정정 등) 상세를 다시 받는다.
const listSig = (src, r) =>
  src.id === "recall"
    ? [r.entpName, r.reason, r.makeNo, r.recallDate, r.openEndDate].join("|")
    : [r.entpName, r.itemName, r.dispsName, r.dispsDate, r.openEndDate].join("|");

async function getDetail(src, key) {
  const dir = path.join(CACHE, src.id);
  const file = path.join(dir, `${key}.json`);
  if (!NO_CACHE && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 캐시 깨짐 → 다시 받는다 */ }
  }
  const html = await fetchRetry(itemUrl(src, key));
  let detail;
  try {
    detail = parseDetail(html, src);
  } catch (e) {
    // 식약처가 상세를 못 주는 건은 수집 실패가 아니라 데이터 결함이다.
    // 목록 정보만으로 계속 가되, 표시해 두고 매 회차 다시 시도한다(캐시하지 않는다).
    if (e.message === "DETAIL_UNAVAILABLE") return { unavailable: true };
    throw new Error(`${e.message} (key=${key})`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(detail));
  return detail;
}

async function pool(items, worker, conc = CONC) {
  const out = new Array(items.length);
  let i = 0, active = 0, done = 0, failed = null;
  return await new Promise(resolve => {
    const next = () => {
      if (failed) { if (active === 0) resolve({ out, failed }); return; }
      if (done === items.length) return resolve({ out, failed: null });
      while (active < conc && i < items.length) {
        const idx = i++;
        active++;
        worker(items[idx], idx)
          .then(v => { out[idx] = v; })
          .catch(e => { failed = failed || e; })
          .finally(() => { active--; done++; next(); });
      }
    };
    next();
  });
}

async function run(src) {
  const dataPath = path.join(ROOT, "public", src.dataFile);
  let prev = [];
  if (fs.existsSync(dataPath)) {
    try { prev = JSON.parse(fs.readFileSync(dataPath, "utf8")); }
    catch (e) { console.error(`DATA_READ_ERROR ${src.dataFile}: ${e.message}`); return 1; }
  }
  const prevByKey = new Map(prev.map(r => [r.key, r]));

  const html = await fetchRetry(listUrl(src));
  const list = parseList(html, src);
  const total = parseTotal(html);
  if (list.length === 0) { console.error(`${src.id}: LIST_EMPTY — 파싱 0건, 표 구조 변경 의심`); return 1; }
  if (total != null && total !== list.length) {
    // 페이지 상단 "총 N건"과 실제 행 수가 다르면 limit 이 모자란 것 → 통째로 중단
    console.error(`${src.id}: LIST_INCOMPLETE 총 ${total}건인데 ${list.length}행만 파싱됨`);
    return 1;
  }

  const need = list.filter(r => {
    const p = prevByKey.get(r.key);
    return !p || !p.detail || p.detail.unavailable || p.listSig !== listSig(src, r);
  });
  console.log(`${src.id}: TOTAL=${list.length} KNOWN=${prev.length} FETCH_DETAIL=${need.length}`);

  const { failed } = await pool(need, async r => { r.detail = await getDetail(src, r.key); });
  if (failed) {
    // 이번 회차 통째로 포기. 이미 받은 건은 캐시에 남아 다음 회차에서 이어받는다.
    console.error(`${src.id}: DETAIL_FETCH_FAILED — ${failed.message} (이번 회차 반영 안 함)`);
    return 1;
  }

  const stamp = today();
  const nowKeys = new Set(list.map(r => r.key));
  const merged = [];
  let added = 0, changed = 0;

  for (const r of list) {
    const p = prevByKey.get(r.key);
    const rec = {
      ...r,
      listSig: listSig(src, r),
      detail: r.detail || p?.detail,
      firstSeen: p?.firstSeen || stamp,
      delisted: false,
    };
    if (!p) added++;
    else if (p.listSig !== rec.listSig) { rec.updatedAt = stamp; changed++; }
    else if (p.updatedAt) rec.updatedAt = p.updatedAt;
    merged.push(rec);
  }
  // 목록에서 내려간 건 — 지우지 않는다.
  let delisted = 0;
  for (const p of prev) {
    if (nowKeys.has(p.key)) continue;
    merged.push({ ...p, delisted: true, delistedAt: p.delistedAt || stamp });
    delisted++;
  }

  merged.sort((a, b) => String(b[src.dateField] || "").localeCompare(String(a[src.dateField] || "")) || String(b.key).localeCompare(String(a.key)));
  fs.writeFileSync(dataPath, JSON.stringify(merged, null, 1) + "\n");
  const noDetail = merged.filter(r => !r.detail || r.detail.unavailable).length;
  console.log(`${src.id}: WROTE=${merged.length} NEW=${added} CHANGED=${changed} DELISTED_TOTAL=${merged.filter(r => r.delisted).length} (이번 회차 신규 미공개 ${delisted}) NO_DETAIL=${noDetail}`);
  return 0;
}

let code = 0;
for (const id of wanted) {
  const src = SOURCES[id];
  if (!src) { console.error(`unknown source: ${id}`); code = 1; continue; }
  try {
    code = (await run(src)) || code;
  } catch (e) {
    console.error(`${id}: ERROR ${e.message}`);
    code = 1;
  }
}
process.exit(code);
