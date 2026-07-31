// 실사결과서 본문에서 "실사 대상 제형(제조방법)" 값을 뽑아낸다.
//
// 표 예시(pdftotext -layout 결과):
//   제조업체                   제형                     비고
//   에스피씨(주)   비무균-일반제제-내용고형제(산제)          완제
//                 무균-세팔로스포린제제*-합성              원료
//
// 제형 토큰은 항상 "무균" 또는 "비무균"으로 시작하므로 그 지점부터 셀 끝까지를 잘라
// 뒤에 붙은 비고(완제/원료 등)를 떼어내는 방식으로 추출한다. 못 찾으면 빈 배열을
// 돌려주고, 호출부는 이를 '미확인'으로 남긴다 — 임의로 지어내지 않는다.

// 제형 셀은 항상 이 단어들 중 하나로 시작한다
// (예: "비무균-일반제제-합성", "무균-세팔로스포린제제-주사제", "생물-백신-주사제(동결건조주사제)")
const ANCHOR = /(비무균|무균|생물|한약|생약|방사성|첨단바이오|세포치료제|유전자치료제|임상시험용)/;
const ANCHOR_G = new RegExp(ANCHOR.source, "g");
const START = /실사\s*대상|제형\s*및\s*제조방법|제조방법\s*비고/;
const END = /지적\s*\(?\s*보완\s*\)?\s*사항|평가\s*결과|Deficiencies/;
const REMARK = /(완제\s*\+\s*원료|완제|원료|해당\s*없음|비고)\s*$/;

// 표에서 제형 셀만 남기기 위해 잘라내는 꼬리표들
const stripTail = s => {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(REMARK, "").trim().replace(/[,·]\s*$/, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
};

const clean = s => s
  .replace(/\s*[-‐‑–—]\s*/g, "-")        // 하이픈 주변 공백 정리
  .replace(/\s*\(\s*/g, "(").replace(/\s*\)\s*/g, ") ")
  .replace(/\)\s+-/g, ")-")               // "제제(가스) -가스제" → "제제(가스)-가스제"
  .replace(/\)\s+\(/g, ")(")              // "…원액제조) (무균)" → "…원액제조)(무균)"
  .replace(/\s+\)/g, ")")                 // "…(액상) )" → "…(액상))"
  .replace(/\s{2,}/g, " ")
  .replace(/\s+$/, "")
  .replace(/[·,]$/, "")
  .trim();

const nOpen = s => (s.match(/\(/g) || []).length;
const nClose = s => (s.match(/\)/g) || []).length;
const balanced = s => nOpen(s) === nClose(s);

// 괄호 짝을 맞춘다: 남는 ')'는 떼고, 안 닫힌 '('는 닫아준다
function fixParens(s) {
  let v = s.replace(/[[\]]/g, "").trim();   // "[무균-…-주사제]" 처럼 대괄호로 감싼 양식
  while (nClose(v) > nOpen(v)) v = v.replace(/\)([^)]*)$/, "$1");
  while (nOpen(v) > nClose(v)) v += ")";
  return v.replace(/\s*[\]\[]\s*$/, "").replace(/[,·\-‐‑–—\s]+$/, "").trim();
}

export function extractForms(text) {
  if (!text) return [];
  const t = text.replace(/\r/g, "");
  // 제형 표가 있는 구간으로 좁힌다 (없으면 전체를 대상으로)
  const s = t.search(START);
  const region = s >= 0 ? t.slice(s) : t;
  const e = region.search(END);
  const body = e > 0 ? region.slice(0, e) : region;

  const lines = body.split("\n").map(l => l.replace(/\t/g, "    "));
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 셀이 시작되는 앵커 위치만 모은다.
    // 조건: 앞이 공백(또는 줄 시작)이고, 괄호 안이 아니어야 한다.
    // → "(무균)" 처럼 괄호 안에 든 표기나 "비무균" 속의 "무균"에는 걸리지 않는다.
    const starts = [];
    const re = new RegExp(ANCHOR_G.source, "g");
    let m;
    while ((m = re.exec(line)) !== null) {
      const pre = line.slice(0, m.index);
      re.lastIndex = m.index + m[0].length;
      if (nOpen(pre) !== nClose(pre)) continue;          // 괄호 안의 "(무균)" 표기 — 셀 시작이 아님
      // 줄 시작 / 공백 뒤 / 대괄호 바로 뒤("제조소명 [무균-…]")면 셀 시작으로 본다
      if (pre === "" || /\s$/.test(pre) || /\[$/.test(pre)) { starts.push(m.index); continue; }
      // 셀 앞에 대괄호나 제조방법 접두어가 붙은 양식도 있다:
      //   "[무균-일반제제-주사제]", "합성-무균-카바페넴제제-합성", "그밖의방법-무균-…"
      let last = 0, g; const gapRe = /\s{2,}/g;
      while ((g = gapRe.exec(pre)) !== null) last = g.index + g[0].length;
      const between = pre.slice(last);
      if (/^[[(]?$/.test(between) || /^[[(]?[가-힣]{2,8}[-‐‑–—]$/.test(between)) starts.push(last);
    }
    for (let k = 0; k < starts.length; k++) {
      // 같은 줄에 다음 제형 셀이 또 있으면 거기서 끊는다 ("…-합성   비무균-…" 병합 방지)
      const cell = line.slice(starts[k], starts[k + 1]);

      // 셀 경계는 공백 2칸 이상. 단 괄호가 열려 있거나 하이픈으로 끝나면 계속 이어붙인다
      let head = "", rest = cell.trim();
      while (rest) {
        const cut = rest.search(/\s{2,}/);
        head += (cut > 0 ? rest.slice(0, cut) : rest);
        rest = cut > 0 ? rest.slice(cut).trim() : "";
        if (balanced(head) && !/[-‐‑–—]\s*$/.test(head)) break;
        if (rest) head += " ";
      }
      // 줄바꿈으로 괄호가 끊긴 경우 다음 줄에서 이어 붙인다 (최대 2줄)
      for (let j = i + 1; j < lines.length && j <= i + 2 && !balanced(head); j++) {
        const nextCell = (lines[j].trim().split(/\s{2,}/)[0] || "").trim();
        if (!nextCell) break;
        head += " " + nextCell;
      }

      // 표 칸이 세로로 쪼개진 경우("비무균-일반제제-" / 다음 줄 "내용고형제"):
      // 하이픈으로 끝나거나 마지막 조각이 한 글자면, 아래 줄에서 같은 열(±8칸)의 토큰을 이어붙인다
      const col = starts[k];
      // 이어붙임이 필요한 상태: ①하이픈으로 끝남 ②마지막 조각이 한 글자 ③제제유형까지만 있고 제형이 없음
      const needsMore = t0 => {
        const t = t0.replace(/[\]\s]+$/, "");
        return /[-‐‑–—]$/.test(t) || /(^|-)[가-힣]$/.test(t.replace(/\([^)]*\)/g, "")) || /제제$/.test(t);
      };
      for (let j = i + 1; j < lines.length && j <= i + 3 && needsMore(head); j++) {
        const tokRe = /\S+/g; let tm, at = -1;
        while ((tm = tokRe.exec(lines[j])) !== null) {
          if (Math.abs(tm.index - col) <= 8) { at = tm.index; break; }
        }
        if (at < 0) continue;
        let seg = lines[j].slice(at);
        const cutp = seg.search(/\s{2,}/);
        let cand = (cutp > 0 ? seg.slice(0, cutp) : seg).trim();
        if (nOpen(cand) > nClose(cand)) cand = seg.trim();   // 괄호가 잘렸으면 줄 끝까지
        if (/^(완제|원료|비고|완제\+원료)$/.test(cand)) continue;
        if (!/^[가-힣][가-힣()·,\s]{1,30}$/.test(cand)) continue;
        const base = head.replace(/[\]\s]+$/, "");
        head = /[-‐‑–—]$/.test(base) || /(^|-)[가-힣]$/.test(base.replace(/\([^)]*\)/g, ""))
          ? base + cand            // 단어가 중간에 끊긴 경우 — 그대로 붙인다
          : base + "-" + cand;     // 제제유형까지만 있던 경우 — 제형을 다음 마디로 붙인다
      }

      const val = fixParens(clean(stripTail(clean(head))));
      // "앵커-…-…" 형태여야 하고, 문장(지적사항 등)이 딸려 들어온 것은 버린다
      if (val.length >= 6 && val.length <= 90 && val.includes("-")
          && !/할 것|제출|하여야|따라|기준에|평가 결과/.test(val)) {
        found.push(val);
      }
    }
  }
  // 중복 제거(순서 유지)
  return [...new Set(found)];
}

// 해외 사전 GMP 평가 문서에는 제형 표가 없고 "실사 대상 품목 … 무균/완제" 형식만 있다.
// 이 경우 제형은 지어내지 않고(빈 배열) 무균 여부만 살린다.
export function extractFormInfo(text) {
  const forms = extractForms(text);
  let sterile = "";
  const kinds = new Set(forms.map(f =>
    /^비무균/.test(f) ? "비무균"
    : /^무균/.test(f) ? "무균"
    : /\(무균\)/.test(f) ? "무균"          // 생물-백신-(…)(무균) 형태
    : /\(비무균\)/.test(f) ? "비무균" : "").filter(Boolean));
  if (kinds.size) sterile = [...kinds].sort().join("+");
  else {
    // 비고란 표기: "무균/완제", "비무균/원료", "비무균/DMF" 등
    const m = (text || "").match(/(비무균|무균)\s*[\/·]\s*[가-힣A-Za-z]/);
    if (m) sterile = m[1];
  }
  return { forms, sterile };
}

// 제형 문자열에서 필터용 축(무균여부 / 제제유형 / 제형)을 뽑는다
export function formFacets(forms) {
  const sterile = new Set(), kind = new Set(), shape = new Set();
  for (const f of forms) {
    const parts = f.split("-").map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (/^비무균/.test(parts[0])) sterile.add("비무균");
    else if (/^무균/.test(parts[0])) sterile.add("무균");
    const rest = parts.slice(1);
    for (const p of rest) {
      const base = p.replace(/\([^)]*\)/g, "").replace(/\*/g, "").trim();
      if (!base) continue;
      if (/제제$/.test(base)) kind.add(base);
      else shape.add(base);
    }
  }
  return { sterile: [...sterile], kind: [...kind], shape: [...shape] };
}
