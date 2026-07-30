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

  let added = 0, carried = 0;
  const out = list.map(r => {
    let defs;
    if (newDef.has(r.docId)) { defs = newDef.get(r.docId); added++; }
    else if (prevDef.has(r.docId)) { defs = prevDef.get(r.docId); carried++; }
    else { defs = []; } // known in list but no deficiency info anywhere → treat as 적합
    return {
      seq: r.seq, docId: r.docId, prePost: r.prePost, type: r.type,
      country: r.country, site: r.site, address: r.address,
      inspStart: r.inspStart, inspEnd: r.inspEnd, regDate: r.regDate,
      result: defs.length > 0 ? "지적사항 있음" : "적합",
      defCount: defs.length, deficiencies: defs,
    };
  });
  out.sort((a, b) => a.seq - b.seq);
  fs.writeFileSync(DATA, JSON.stringify(out, null, 2));
  const withDef = out.filter(r => r.defCount > 0).length;
  const items = out.reduce((a, r) => a + r.defCount, 0);
  console.log(`MERGED total=${out.length} newlyExtracted=${added} carried=${carried} withDeficiency=${withDef} totalItems=${items}`);
}
main();
