// Merge fresh list metadata + existing deficiencies + newly extracted deficiencies
// into public/data.json.
//
// Inputs:
//   newdocs/list.json        – authoritative current records (metadata + seq + order)
//   public/data.json         – previous dataset (source of deficiencies for KNOWN docIds)
//   newdocs/extracted.json   – agent output for NEW docIds: [{docId, deficiencies:[{field,gubun,law,summary,remark}]}]
// Output:
//   public/data.json (rebuilt, sorted by seq ascending = site's own ordering)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
  const prevDef = new Map(prev.map(r => [r.docId, r.deficiencies || []]));
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

  let added = 0, carried = 0;
  const out = list.map(r => {
    let defs;
    if (newDef.has(r.docId)) { defs = newDef.get(r.docId); added++; }
    else if (prevDef.has(r.docId)) { defs = prevDef.get(r.docId); carried++; }
    else { defs = []; } // known in list but no deficiency info anywhere → treat as 적합
    const fi = formsMap[r.docId] || prevForms.get(r.docId) || { forms: [], sterile: "" };
    return {
      seq: r.seq, docId: r.docId, prePost: r.prePost, type: r.type,
      country: r.country, site: r.site, address: r.address,
      inspStart: r.inspStart, inspEnd: r.inspEnd, regDate: r.regDate,
      forms: fi.forms || [], sterile: fi.sterile || "",
      archiveFile: archived.get(r.docId) || null,
      result: defs.length > 0 ? "지적사항 있음" : "적합",
      defCount: defs.length, deficiencies: defs,
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
      ` totalItems=${items} withForms=${withForms} delisted=${gone}(식약처 목록에서 내려갔지만 보존)`,
  );
}
main();
