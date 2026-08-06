// 신규 실사결과서에서 지적(보완)사항을 추출한다 — 로컬 PC 전용.
//
// scripts/extract.mjs 와 결과물은 같지만, 유료 API 키 대신 **로컬에 설치된
// Claude Code CLI(`claude -p`)** 를 호출한다. 기존 구독으로 처리되므로 API 비용이 없다.
// (회사 정책상 유료 API 키 발급이 어려워 이 경로를 기본으로 쓴다.)
//
// 입력:  <작업디렉터리>/manifest.json + <작업디렉터리>/<docId>.txt
// 출력:  <작업디렉터리>/extracted.json
//        작업디렉터리 = 환경변수 WORK_DIR (기본 pending = Actions 가 받아둔 백로그).
//        로컬에서 직접 수집한 경우 러너가 WORK_DIR=newdocs 로 부른다.
// 필요:  PATH 에 claude CLI (2.1.220 에서 검증)
//
// ★ 부분 성공을 만들지 않는다: 한 건이라도 실패하면 exit 1.
//   merge.mjs 는 extracted.json 에 없는 신규 docId 를 빈 배열=**'적합'으로 표시**하므로,
//   일부만 반영하면 지적사항이 있는 제조소가 적합으로 뒤바뀐다.
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const WORK_DIR = process.env.WORK_DIR || "pending";
const PENDING = path.join(ROOT, WORK_DIR);
const MANIFEST = path.join(PENDING, "manifest.json");
const OUT = path.join(PENDING, "extracted.json");

const INSTRUCTION = `입력으로 주어지는 것은 식약처가 공개한 의약품 제조소 GMP 실태조사 결과서 본문이다.
'지적(보완)사항' 표를 읽어 **JSON 배열만** 출력하라. 설명·코드펜스·머리말 없이 배열 하나만 출력한다.

각 항목의 형식:
{"field":"분야","gubun":"구분","law":"근거법령","summary":"지적사항 요약 원문","remark":"비고"}

규칙:
- 표 컬럼은 [분야 / 구분(중대·중요·기타) / 근거 법령 / 지적(보완)사항 요약 / 비고] 이다.
- "지적(보완)사항(Deficiencies) 없음" 이면 [] 를 출력하라.
- summary 는 줄바꿈으로 끊긴 것을 한 문장으로 이어붙이되 **의역·번역·요약·윤문 금지**. 원문 한국어 그대로.
- 비고가 없으면 remark 는 빈 문자열 "".
- 표 아래 각주("1) GMP 감시 분야(6개)…", "2) 지적사항은 PIC/S 정의에 따라…" 등)는 지적사항이 아니다. 제외하라.
- **분야·구분 셀이 세로 병합된 경우 주의**: 병합 셀의 라벨은 그 블록의 세로 중앙 줄에 찍힌다.
  라벨 줄 번호가 (블록 첫 줄 + 마지막 줄)/2 가 되도록 행을 묶어 어느 행이 어느 분야인지 갈라라.
  근거법령 번호로 분야를 추론하지 마라 — 문서가 법령 체계와 다르게 분류한 사례가 실제로 있다.
- 실제 제조소의 규제 정보다. 없는 내용을 지어내지 마라.`;

// claude CLI 를 띄우고 지시문+본문을 **전부 stdin 으로** 흘려보낸다.
// argv 에는 `-p` 만 남긴다: Windows 에서 shell:true 는 인자를 이스케이프 없이 이어붙이므로
// 따옴표가 든 긴 지시문을 argv 로 넘기면 명령줄이 깨질 수 있고, 길이 제한에도 걸린다.
function runClaude(docText) {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p"], {
      shell: true, // Windows 에서 claude.cmd/.exe 해석에 필요
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude 종료코드 ${code}: ${err.trim().slice(0, 300)}`));
      resolve(out);
    });
    p.stdin.write(`${INSTRUCTION}\n\n본문:\n---\n${docText}\n---\n`);
    p.stdin.end();
  });
}

// 모델이 앞뒤로 군말이나 코드펜스를 붙여도 배열만 건져낸다.
function parseArray(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a === -1 || b === -1 || b < a) throw new Error(`JSON 배열을 찾을 수 없음: ${s.slice(0, 200)}`);
  const parsed = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(parsed)) throw new Error("배열이 아님");
  const KEYS = ["field", "gubun", "law", "summary", "remark"];
  return parsed.map((d, i) => {
    for (const k of KEYS) {
      if (typeof d?.[k] !== "string") throw new Error(`${i}번 항목의 '${k}' 가 문자열이 아님`);
    }
    return { field: d.field, gubun: d.gubun, law: d.law, summary: d.summary, remark: d.remark };
  });
}

async function main() {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : [];
  if (!manifest.length) {
    console.log("EXTRACTED n=0 (신규 없음)");
    process.exit(0);
  }

  // hasText:false 는 자동 추출이 불가능하다. 넘기면 '적합'으로 잘못 표시되므로 중단한다.
  const noText = manifest.filter((r) => !r.hasText);
  if (noText.length) {
    console.error(
      `EXTRACT_ERROR: 본문 텍스트 추출 실패 문서 ${noText.length}건 — 자동 처리 불가, 수동 확인 필요:\n` +
        noText.map((r) => `  - ${r.docId} ${r.site}`).join("\n"),
    );
    process.exit(1);
  }

  const out = [], failed = [];
  for (const rec of manifest) {
    const txt = path.join(PENDING, `${rec.docId}.txt`);
    try {
      if (!fs.existsSync(txt)) throw new Error(`본문 파일 없음: ${WORK_DIR}/${rec.docId}.txt`);
      const defs = parseArray(await runClaude(fs.readFileSync(txt, "utf8")));
      out.push({ docId: rec.docId, deficiencies: defs });
      console.log(`  ${rec.docId} ${rec.site} → 지적 ${defs.length}건`);
    } catch (e) {
      failed.push(`${rec.docId} ${rec.site}: ${e.message}`);
      console.error(`  ${rec.docId} ${rec.site} → 실패: ${e.message}`);
    }
  }

  if (failed.length) {
    console.error(`EXTRACT_ERROR: ${failed.length}/${manifest.length}건 추출 실패 — merge 하지 않고 중단합니다.`);
    console.error("(일부만 반영하면 실패한 문서가 '적합'으로 잘못 표시됩니다.)");
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const items = out.reduce((a, r) => a + r.deficiencies.length, 0);
  const withDef = out.filter((r) => r.deficiencies.length).length;
  console.log(`EXTRACTED n=${out.length} withDeficiency=${withDef} totalItems=${items}`);
}

main().catch((e) => {
  console.error("EXTRACT_ERROR:", e.message);
  process.exit(1);
});
