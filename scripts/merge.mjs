// Merge fresh list metadata + existing deficiencies + newly extracted deficiencies
// into public/data.json.
//
// Inputs:
//   newdocs/list.json        – authoritative current records (metadata + seq + order)
//   public/data.json         – previous dataset (source of deficiencies for KNOWN docIds)
//   newdocs/extracted.json   – agent output for NEW docIds: [{docId, deficiencies:[{field,gubun,law,summary,remark}]}]
//   quarantine.json          – 사람이 '자동 처리 불가'로 판정한 건 → result:"확인중"
// Output:
//   public/data.json (rebuilt, sorted by seq ascending = site's own ordering)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadQuarantine } from "./quarantine.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DATA = path.join(ROOT, "public", "data.json");
// LIST_PATH/EXTRACTED_PATH let the caller work out of ./pending instead of ./newdocs
const LIST = process.env.LIST_PATH || path.join(ROOT, "newdocs", "list.json");
const EXTRACTED = process.env.EXTRACTED_PATH || path.join(ROOT, "newdocs", "extracted.json");
const FORMS = path.join(ROOT, "forms.json"); // docId → {forms:[...], sterile:"…"}
const ARCHIVE = path.join(ROOT, "public", "archive"); // 원본 PDF 영구 보관함

const norm = d => ({
  field: (d.field || "").trim(), gubun: (d.gubun || "").trim(),
  law: (d.law || "").trim(), summary: (d.summary || "").trim(), remark: (d.remark || "").trim(),
});

function main() {
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  const prev = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, "utf8")) : [];
  const quarantined = loadQuarantine();
  // ★ '확인중'(unresolved) 으로 넣어둔 건은 지적사항 정보가 **없는** 것과 같다.
  //   여기서 걸러내지 않으면 나중에 보류를 풀었을 때 defs=[] 가 그대로 이어져 '적합'으로
  //   뒤바뀐다 — 하드 스톱이 막아주던 바로 그 사고가 우회된다.
  const prevDef = new Map(prev.filter(r => !r.unresolved).map(r => [r.docId, r.deficiencies || []]));
  const extracted = fs.existsSync(EXTRACTED) ? JSON.parse(fs.readFileSync(EXTRACTED, "utf8")) : [];
  const newDef = new Map(extracted.map(e => [e.docId, (e.deficiencies || []).map(norm)]));
  // 제형: forms.json 이 우선, 없으면 직전 data.json 값을 유지
  const formsMap = fs.existsSync(FORMS) ? JSON.parse(fs.readFileSync(FORMS, "utf8")) : {};
  // 보관된 원본이 있으면 대시보드가 식약처 대신 보존본을 링크한다(원문이 사라져도 열림)
  //  ※ 15건은 HWPX 라 확장자가 다르다 → 파일명을 그대로 들고 있어야 링크가 깨지지 않는다
  const archived = new Map(
    (fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE) : [])
      .filter((f) => /\.(pdf|hwpx)$/i.test(f))
      .map((f) => [f.replace(/\.(pdf|hwpx)$/i, ""), f]),
  );
  const prevForms = new Map(prev.map(r => [r.docId, { forms: r.forms || [], sterile: r.sterile || "" }]));

  // ★ 추출 없는 신규 건은 절대 통과시키지 않는다.
  //   목록에 있는데 extracted 에도 직전 data.json 에도 없으면 아래에서 defs=[] 가 되어
  //   '적합' 으로 찍힌다. 실제 지적사항이 있는 제조소가 적합으로 공개되고, 한 번 들어가면
  //   다음 실행부터는 'known' 이라 영영 다시 보지 않는다.
  //   이런 상태는 다운로드 실패(fetch-new.mjs 가 그 건만 skip)나 본문 추출 실패로 생긴다.
  //   여기서 멈추면 커밋이 없으니 다음 실행에서 통째로 재시도된다.
  //   ※ quarantine.json 에 사람이 적어둔 건은 예외다 — 아래에서 '확인중'으로 표시하므로
  //     '적합' 오표시가 아니고, 여기서 막으면 해독 불가능한 1건이 파이프라인을 영구 정지시킨다.
  const unextracted = list.filter(r => !newDef.has(r.docId) && !prevDef.has(r.docId) && !quarantined.has(r.docId));
  if (unextracted.length && !process.env.ALLOW_UNEXTRACTED) {
    console.error(
      `MERGE_ERROR: 추출 정보가 없는 신규 문서 ${unextracted.length}건 — '적합' 오표시를 막기 위해 중단합니다:\n` +
        unextracted.map(r => `  - ${r.docId} ${r.site}`).join("\n") +
        `\n(최초 구축처럼 의도적으로 비워둬야 할 때만 ALLOW_UNEXTRACTED=1` +
        `, 원문 자체가 자동 처리 불가인 건은 quarantine.json 에 적어 '확인중'으로 빼두세요)`,
    );
    process.exit(1);
  }

  let added = 0, carried = 0, review = 0;
  const out = list.map(r => {
    // 우선순위: 이번에 추출한 결과 > 보류(확인중) > 직전 data.json > (여기까지 오면 위에서 이미 중단)
    // 추출 결과가 보류보다 우선이라 식약처가 정상 파일로 재업로드하면 '확인중'이 자동으로 풀린다.
    let defs, hold = null;
    if (newDef.has(r.docId)) { defs = newDef.get(r.docId); added++; }
    else if (quarantined.has(r.docId)) { defs = []; hold = quarantined.get(r.docId); review++; }
    else if (prevDef.has(r.docId)) { defs = prevDef.get(r.docId); carried++; }
    else { defs = []; } // known in list but no deficiency info anywhere → treat as 적합
    const fi = formsMap[r.docId] || prevForms.get(r.docId) || { forms: [], sterile: "" };
    return {
      seq: r.seq, docId: r.docId, prePost: r.prePost, type: r.type,
      country: r.country, site: r.site, address: r.address,
      inspStart: r.inspStart, inspEnd: r.inspEnd, regDate: r.regDate,
      forms: fi.forms || [], sterile: fi.sterile || "",
      archiveFile: archived.get(r.docId) || null,
      result: hold ? "확인중" : (defs.length > 0 ? "지적사항 있음" : "적합"),
      defCount: defs.length, deficiencies: defs,
      // 확인중 건에만 붙는다. 이 표식이 있으면 다음 실행의 prevDef 에서 제외돼
      // '적합'으로 굳지 않는다(위 prevDef 주석 참고).
      ...(hold ? { unresolved: true, unresolvedReason: hold.reason || "", unresolvedSince: hold.since || "" } : {}),
    };
  });
  out.sort((a, b) => a.seq - b.seq);

  // ★ 누적 보존: 식약처가 목록에서 내린 건도 지우지 않는다.
  //   (식약처는 오래된 실사결과를 목록에서 삭제한다. 예전엔 목록을 그대로 반영해
  //    대시보드에서도 함께 사라졌고, 실제로 4건·지적항목 74건이 소실됐다.)
  //   한 번 수집한 레코드는 delisted 로 표시해 남기고, 최초 감지일을 기록한다.
  const listIds = new Set(list.map((r) => r.docId));
  const today = new Date().toISOString().slice(0, 10);
  const delisted = [];
  for (const r of prev) {
    if (listIds.has(r.docId)) continue;
    delisted.push({ ...r, archiveFile: archived.get(r.docId) || null, delisted: true, delistedAt: r.delistedAt || today });
  }
  delisted.sort((a, b) => String(b.regDate).localeCompare(String(a.regDate)));
  out.push(...delisted);

  fs.writeFileSync(DATA, JSON.stringify(out, null, 2));
  const withDef = out.filter(r => r.defCount > 0).length;
  const items = out.reduce((a, r) => a + r.defCount, 0);
  const withForms = out.filter(r => (r.forms || []).length).length;
  const gone = out.filter(r => r.delisted).length;
  console.log(
    `MERGED total=${out.length} newlyExtracted=${added} carried=${carried} withDeficiency=${withDef}` +
      ` totalItems=${items} withForms=${withForms} delisted=${gone}(식약처 목록에서 내려갔지만 보존)` +
      ` review=${review}(확인중: 자동 추출 불가로 보류)`,
  );
}
main();
