// LLM 추출 결과의 분야·구분·근거법령을 원본 PDF 표의 칸 구조로 바로잡는다.
// 실제 판독은 scripts/table-fix.py(pdfplumber). 배경은 그 파일 머리말 참고.
//
// ★ 보정 실패는 추출 실패가 아니다: 파이썬·pdfplumber 가 없거나 표를 못 찾으면
//   경고만 남기고 LLM 결과를 그대로 쓴다(보정 도입 전과 같은 동작). 보정 때문에
//   신규 건 공개가 멈추면 그게 더 큰 손해다.
import fs from "fs";
import path from "path";
import { runPython } from "./pdftext.mjs";

export function tableFix(root, docId, defs, workDir) {
  const pdf = [path.join(root, "public", "archive", `${docId}.pdf`), path.join(workDir, `${docId}.pdf`)]
    .find((p) => fs.existsSync(p));
  if (!pdf) return { defs, note: "PDF 없음(HWPX 등) — 보정 생략" };
  const out = runPython("table-fix.py", [pdf], JSON.stringify(defs));
  if (out == null) {
    console.error(`TABLEFIX_UNAVAILABLE: ${docId} — 파이썬/pdfplumber 실행 실패, LLM 결과 그대로 사용`);
    return { defs, note: "보정 불가" };
  }
  let res;
  try { res = JSON.parse(out); } catch { res = { skip: "출력 해석 실패" }; }
  if (res.skip) return { defs, note: `보정 생략: ${res.skip}` };
  for (const c of res.changes)
    console.log(`    표 보정 #${c.i} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}  (${c.summary})`);
  if (res.added) console.log(`    표 보정: 행 전체가 가려진 칸 ${res.added}개를 비공개 항목으로 추가`);
  // 두 행의 문장이 한 항목에 섞인 건 자동으로 못 고친다 — 로그로만 남긴다
  for (const m of res.mixed) console.error(`TABLEFIX_MIXED: ${docId} — 행이 섞인 항목(사람 확인 권장): ${m}`);
  return {
    defs: res.deficiencies,
    note: `표 보정 ${res.changes.length}건·가림 추가 ${res.added}건${res.unmatched ? `·대조 못한 항목 ${res.unmatched}건` : ""}`,
  };
}
