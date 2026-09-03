// 실사결과서 원본을 저장소에 영구 보관한다.
//
// 왜: 식약처는 오래된 실사결과를 목록에서 내리고 원문도 언젠가 사라진다.
//     대시보드가 식약처 URL 로만 링크하면 그때 죽은 링크가 된다.
//     → public/archive/<docId>.pdf 로 받아 두고 GitHub Pages 가 그대로 서빙한다.
//
// 특징:
//  - 이미 받은 파일은 건너뛴다(재실행 안전, 중단 후 이어받기 가능)
//  - 목록에서 내려간 건(delisted)도 대상 — 아직 원문이 살아 있는 동안 확보한다
//  - 받은 파일이 PDF/HWPX 인지 검증하고, 아니면 저장하지 않는다(오류 페이지 저장 방지)
//
// 사용: node scripts/archive-pdfs.mjs [--limit N] [--only docId,...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const DATA = path.join(ROOT, 'public', 'data.json');
// 아직 data.json 에 안 들어간 신규 건의 목록 — 수집 주체가 둘이라 둘 다 본다.
//   pending/  = GitHub Actions 가 수집한 백로그
//   newdocs/  = 로컬 스케줄러가 방금 직접 수집한 것(gitignore, 같은 PC 에서 바로 처리)
const LISTS = [path.join(ROOT, 'pending', 'list.json'), path.join(ROOT, 'newdocs', 'list.json')];
const OUT = path.join(ROOT, 'public', 'archive');
const DOWN = 'https://nedrug.mfds.go.kr/cmn/edms/down/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const LIMIT = Number(arg('--limit') || 0);
const ONLY = (arg('--only') || '').split(',').filter(Boolean);

async function fetchRetry(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      last = e;
      await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
    }
  }
  throw last;
}

const kindOf = (buf) => {
  const head = buf.slice(0, 4).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) return 'hwpx';
  return null;
};

fs.mkdirSync(OUT, { recursive: true });
// data.json(대시보드 반영분) + pending/list.json(아직 추출 대기 중인 신규 건).
//  ※ 신규 건은 추출·병합 전까지 data.json 에 없다. data.json 만 보면 그 동안 원본을
//    확보하지 못하는 공백이 생긴다 — 식약처가 그 사이 원문을 내리면 영영 못 받는다.
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const seen = new Set(data.map((r) => r.docId));
const all = [...data];
for (const listPath of LISTS) {
  if (!fs.existsSync(listPath)) continue;
  for (const r of JSON.parse(fs.readFileSync(listPath, 'utf8'))) {
    if (seen.has(r.docId)) continue;
    seen.add(r.docId);
    all.push(r);
  }
}
let targets = ONLY.length ? all.filter((r) => ONLY.includes(r.docId)) : all;
targets = targets.filter((r) => {
  const pdf = path.join(OUT, r.docId + '.pdf');
  const hwpx = path.join(OUT, r.docId + '.hwpx');
  return !fs.existsSync(pdf) && !fs.existsSync(hwpx); // 이미 보관됨 → 건너뜀
});
if (LIMIT) targets = targets.slice(0, LIMIT);

const already = all.length - targets.length;
console.log(`보관 대상 ${targets.length}건 (이미 보관 ${already}건 / 전체 ${all.length}건)`);

let ok = 0;
let fail = 0;
let bytes = 0;
const failed = [];
for (let i = 0; i < targets.length; i++) {
  const r = targets[i];
  try {
    const res = await fetchRetry(DOWN + r.docId);
    const buf = Buffer.from(await res.arrayBuffer());
    const kind = kindOf(buf);
    // 원문이 이미 내려갔거나, 식약처가 애초에 잘못된 파일을 올린 경우다. 후자는 재시도로
    // 풀리지 않으므로 quarantine.json 에 적어 '확인중'으로 빼야 한다(2026-09-02 중앙산업가스 건).
    if (!kind) throw new Error(`PDF/HWPX 아님 (${buf.length}바이트, 앞머리 ${JSON.stringify(buf.slice(0, 8).toString("latin1"))})`
      + ` — 원문이 내려갔거나 식약처가 잘못된 파일을 올렸을 수 있음`);
    fs.writeFileSync(path.join(OUT, `${r.docId}.${kind}`), buf);
    ok++;
    bytes += buf.length;
  } catch (e) {
    fail++;
    failed.push({ docId: r.docId, site: r.site, regDate: r.regDate, reason: e.message });
    console.log(`  [실패] ${r.docId} ${r.site} — ${e.message}`);
  }
  if ((i + 1) % 50 === 0) {
    console.log(`  ...${i + 1}/${targets.length} (성공 ${ok} / 실패 ${fail} / ${(bytes / 1048576).toFixed(1)}MB)`);
  }
  await new Promise((s) => setTimeout(s, 120)); // 식약처 서버 배려
}

console.log(`완료: 성공 ${ok} / 실패 ${fail} / 이번에 받은 용량 ${(bytes / 1048576).toFixed(1)}MB`);
if (failed.length) {
  fs.writeFileSync(path.join(ROOT, 'archive-failed.json'), JSON.stringify(failed, null, 2));
  console.log(`  실패 목록 → archive-failed.json (재실행하면 실패분만 다시 시도)`);
}
const total = fs.readdirSync(OUT).filter((f) => /\.(pdf|hwpx)$/.test(f)).length;
const size = fs
  .readdirSync(OUT)
  .filter((f) => /\.(pdf|hwpx)$/.test(f))
  .reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`아카이브 현황: ${total}개 파일 / ${(size / 1048576).toFixed(1)}MB`);
