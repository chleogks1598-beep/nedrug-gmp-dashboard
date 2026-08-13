// 의약품안전나라 "안전성정보" 두 게시판 공통 수집 유틸.
//
//   recall : 회수·폐기       https://nedrug.mfds.go.kr/pbp/CCBAI01
//   admin  : 행정처분정보    https://nedrug.mfds.go.kr/pbp/CCBAO01
//
// GMP(CCBBD03)와 달리 이쪽은 첨부 PDF 가 없고 목록/상세가 전부 HTML 표라서
// LLM 추출이 필요 없다. 대신 두 게시판 모두 "공개마감(종료)일자"가 있어
// 기간이 지나면 목록에서 사라진다 — 그래서 누적 보존(delisted)이 필수다.
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dir, "..");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 식약처 WAF 는 User-Agent 없는 요청을 거부하고, 클라우드 IP 에는 간헐적으로
// 연결 타임아웃을 준다. 실패는 던져서 호출자가 "이번 회차 통째로 건너뛰기"를
// 하도록 한다(부분 반영 금지).
export async function fetchRetry(url, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`fetch failed: ${url} — ${last?.message || last}`);
}

export const decodeEntities = s =>
  String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// 태그 제거 + 공백 정리. <br>·</p> 는 줄바꿈으로 살린다(위반내용·근거법령이 여러 줄).
export const clean = html =>
  decodeEntities(
    String(html ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
};

export const SOURCES = {
  recall: {
    id: "recall",
    code: "CCBAI01",
    title: "의약품 회수·폐기",
    short: "회수·폐기",
    keyParam: "targetItemSeq",
    dataFile: "recall-data.json",
    page: "recall",
    dateField: "recallDate",
    endField: "openEndDate",
  },
  admin: {
    id: "admin",
    code: "CCBAO01",
    title: "의약품 행정처분정보",
    short: "행정처분",
    keyParam: "dispsApplySeq",
    dataFile: "admin-data.json",
    page: "admin",
    dateField: "dispsDate",
    endField: "openEndDate",
  },
};

export const listUrl = (src, limit = 3000) =>
  `https://nedrug.mfds.go.kr/pbp/${src.code}/getList?page=1&limit=${limit}&searchYn=true`;

// 상세는 목록 파라미터가 같이 없으면 302 로 튕긴다(세션 아님, 파라미터 검증).
export const itemUrl = (src, key) =>
  `https://nedrug.mfds.go.kr/pbp/${src.code}/getItem?limit=10&searchYn=true&page=1&${src.keyParam}=${encodeURIComponent(key)}`;

export const drugUrl = itemSeq =>
  `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${encodeURIComponent(itemSeq)}`;

// ★ 주석 먼저 제거할 것. 회수·폐기 목록에는 주석 처리된 <td>(구 "제조번호[제조일자]" 컬럼)가
//   행마다 남아 있어서, 그냥 <td> 를 세면 그 뒤 컬럼이 통째로 한 칸씩 밀린다.
const stripComments = html => String(html ?? "").replace(/<!--[\s\S]*?-->/g, "");

function listTable(html) {
  const tables = html.match(/<table[^>]*class="tb_list"[\s\S]*?<\/table>/gi) || [];
  if (!tables.length) throw new Error("LIST_TABLE_NOT_FOUND");
  return tables[0];
}

export function parseTotal(html) {
  const m = html.match(/총\s*([\d,]+)\s*건/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// "조회 결과가 없습니다" 한 줄짜리 표를 진짜 데이터로 착각하지 않도록,
// 행마다 항목키(href 의 targetItemSeq/dispsApplySeq)가 있는 것만 받는다.
export function parseList(html, src) {
  const trs = listTable(stripComments(html)).match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const keyRe = new RegExp(`${src.keyParam}=([^"&]+)`);
  const out = [];
  for (const tr of trs) {
    const km = tr.match(keyRe);
    if (!km) continue;
    const tds = [...tr.matchAll(/<td[\s\S]*?<\/td>/gi)].map(m => m[0]);
    // 모바일 대응 라벨(<span class="s-th">제품명</span>)은 값이 아니므로 제거한다.
    const val = i =>
      clean((tds[i] || "").replace(/<span class="s-th"[\s\S]*?<\/span>/gi, "")).replace(/\n+/g, " ");
    const key = decodeURIComponent(km[1]);
    if (src.id === "recall") {
      const itemSeq = (tds[1] || "").match(/itemSeq=(\d+)/);
      out.push({
        key,
        seq: Number(val(0)) || 0,
        itemName: val(1),
        itemSeq: itemSeq ? itemSeq[1] : "",
        entpName: val(2),
        reason: val(3),
        // 목록 표시는 잘려 있고(…) title 속성에 전체 값이 들어 있다.
        makeNo: attr(tds[4] || "", "title") || val(4),
        recallDate: val(5),
        openEndDate: val(6),
      });
    } else {
      out.push({
        key,
        seq: Number(val(0)) || 0,
        entpName: val(1),
        itemName: val(2),
        dispsName: val(3),
        dispsDate: val(4),
        openEndDate: val(5),
      });
    }
  }
  return out;
}

// 상세 표는 <tr> 안에 <th>라벨</th><td>값</td> 이 반복되고,
// 같은 내용이 pc-tr / mobile-tr 로 두 번 나온다 → mobile-tr 을 버리고 첫 값만 취한다.
function labelMap(html) {
  const map = new Map();
  const tables = stripComments(html).match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    if (!/class="tb_base|class="tb_view/.test(t)) continue;
    for (const m of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (/class="[^"]*mobile-tr/.test(m[0])) continue;
      const cells = [...m[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)];
      for (let i = 0; i < cells.length - 1; i++) {
        if (cells[i][1].toLowerCase() !== "th") continue;
        if (cells[i + 1][1].toLowerCase() !== "td") continue;
        const label = clean(cells[i][2]).replace(/\s+/g, "");
        if (!label || map.has(label)) continue;
        map.set(label, { text: clean(cells[i + 1][2]), html: cells[i + 1][2] });
      }
    }
  }
  return map;
}

const pick = (map, ...labels) => {
  for (const l of labels) if (map.has(l)) return map.get(l).text;
  return "";
};

// 행정처분 상세의 "위반품목" 표 (품목이 없는 건도 많다 → 빈 배열)
function parseViolationItems(html) {
  const tables = stripComments(html).match(/<table[\s\S]*?<\/table>/gi) || [];
  const t = tables.find(x => /위반품목/.test(x));
  if (!t || /조회 결과가 없습니다/.test(t)) return [];
  const out = [];
  for (const m of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/<th/i.test(m[1])) continue;
    const tds = [...m[1].matchAll(/<td[\s\S]*?<\/td>/gi)].map(x =>
      clean(x[0].replace(/<span class="s-th"[\s\S]*?<\/span>/gi, "")).replace(/\n+/g, " "),
    );
    if (tds.length < 4) continue;
    const seqm = m[1].match(/itemSeq=(\d+)/);
    out.push({
      code: tds[1] || "",
      dmf: tds[2] || "",
      name: tds[3] || "",
      gubun: tds[4] || "",
      etcOtc: tds[5] || "",
      itemSeq: seqm ? seqm[1] : "",
    });
  }
  return out;
}

// 식약처가 일부 건에 대해 "오류가 발생하였습니다 / 해당 화면 혹은 기능을 찾을 수 없습니다"
// 페이지를 준다(목록엔 있는데 상세가 없는 데이터 결함). 우리 수집 실패와 구분해야 한다.
// ★ 이 마커는 정상 페이지 안에도 들어 있다(공통 레이아웃) — 그래서 단독으로 쓰면 안 되고,
//   "표 파싱이 실패했을 때"에 한해 오류페이지인지 가르는 용도로만 쓴다.
export const isErrorPage = html =>
  /mpage_errwrap|오류가 발생하였습니다/.test(html) && !/class="tb_base|class="tb_view/.test(html);

const REQUIRED = { recall: ["업체명", "제품명"], admin: ["업체명", "처분일자"] };

export function parseDetail(html, src) {
  const map = labelMap(html);
  // 표는 있는데 우리가 찾는 라벨이 하나도 없으면 양식이 바뀐 것 → 조용히 빈 값 만들지 않는다.
  if (!(REQUIRED[src.id] || []).some(l => map.has(l))) {
    if (isErrorPage(html)) throw new Error("DETAIL_UNAVAILABLE");
    throw new Error("DETAIL_TABLE_NOT_FOUND");
  }
  if (src.id === "recall") {
    const d = {
      entpName: pick(map, "업체명"),
      entpAddr: pick(map, "업체소재지"),
      itemName: pick(map, "제품명"),
      reason: pick(map, "회수사유"),
      makeNo: pick(map, "제조번호[사용기한]", "제조번호[제조일자]", "제조번호"),
      expiry: pick(map, "사용기한"),
      packUnit: pick(map, "포장단위"),
      recallDate: pick(map, "회수명령일자"),
      remark: pick(map, "비고"),
      manager: pick(map, "담당자"),
    };
    // 담당자 "서울청 의약품안전관리과 : 나혜림, 02-2640-1414" → 관할청 필터용
    d.office = (d.manager.split(/[:：]/)[0] || "").trim();
    return d;
  }
  const d = {
    entpName: pick(map, "업체명"),
    bizType: pick(map, "업종"),
    permitNo: pick(map, "허가(신고)번호", "허가신고번호"),
    entpGubun: pick(map, "업체구분"),
    addr: pick(map, "소재지"),
    dispsDate: pick(map, "처분일자"),
    openEndDate: pick(map, "공개종료일자"),
    violation: pick(map, "위반내용"),
    disposition: pick(map, "처분사항"),
    law: pick(map, "근거법령"),
  };
  d.items = parseViolationItems(html);
  return d;
}
