// 자동 처리가 불가능하다고 사람이 판정한 문서 목록(quarantine.json)을 읽는다.
//
// 왜 필요한가: extract 단계는 "한 건이라도 실패하면 전부 중단"이 원칙이다(부분 반영을 하면
// 지적사항이 있는 제조소가 '적합'으로 뒤바뀐다). 그런데 식약처가 애초에 자동 추출이
// 불가능한 파일을 올리는 경우가 있다 — 2026-09-02 중앙산업가스(주) 대덕 건은 원문이
// 문서보안(DRM) 래퍼(파일 매직 SCDSA004)로 올라와 PDF/HWPX 구조가 아예 없었다.
// 이런 건은 아무리 재시도해도 풀리지 않으므로, 그대로 두면 **해독 불가능한 1건이 같이 올라온
// 다른 신규 건과 이후 모든 갱신을 무기한 막는다**(실제로 14시간 정지했다).
//
// 그래서 '보류(quarantine)'를 둔다. 보류된 건은
//   ① extract 가 건너뛰고(LLM 호출 없음)
//   ② merge 가 '적합'이 아니라 **'확인중'** 으로 표시하고(unresolved:true)
//   ③ 감시 메일이 반복 경고하지 않는다(사람이 이미 인지한 건이므로)
// 나머지 신규 건은 정상적으로 반영된다.
//
// ★ 자동으로 등록하지 않는다 — 반드시 사람이 quarantine.json 에 적는다.
//   추출 실패를 자동 보류하면 claude CLI 일시 오류 같은 '고칠 수 있는 실패'까지
//   조용히 확인중으로 굳어져, 하드 스톱이 지켜주던 안전성이 사라진다.
//
// ★ 되돌리기: 식약처가 정상 파일로 재업로드하면 본문이 읽히므로 extract 가 정상 추출하고
//   merge 는 추출 결과를 우선한다(확인중이 자동으로 풀린다). 그 뒤 이 파일에서 항목을 지운다.
//   항목만 먼저 지우고 추출 정보가 없으면 merge 가 다시 하드 스톱한다 — 의도된 동작이다.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const QUARANTINE_FILE = path.join(ROOT, "quarantine.json");

// → Map<docId, {docId, site, regDate, since, reason, action}>
export function loadQuarantine() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(QUARANTINE_FILE, "utf8"));
  } catch {
    return new Map(); // 파일이 없거나 깨졌으면 보류 없음 = 기존 하드 스톱 동작 그대로
  }
  const rows = Array.isArray(raw) ? raw : [];
  return new Map(rows.filter((r) => r && typeof r.docId === "string" && r.docId).map((r) => [r.docId, r]));
}
