// 신규 실사결과서 본문에서 지적(보완)사항을 추출해 pending/extracted.json 을 만든다.
//
// 원래 이 단계는 claude.ai 클라우드 루틴이 담당했는데, 루틴 샌드박스에서 git push 가
// 403 으로 막혀 8일간 한 번도 성공하지 못했다(재인증해도 동일). 그래서 수집·배포와
// 같은 GitHub Actions 로 옮겼다 — Actions 는 push 가 되고 실행 로그도 볼 수 있다.
//
// 입력:  pending/manifest.json + pending/<docId>.txt
// 출력:  pending/extracted.json  [{docId, deficiencies:[{field,gubun,law,summary,remark}]}]
// 환경:  ANTHROPIC_API_KEY (저장소 시크릿)
//
// ★ 실패하면 반드시 exit 1 한다. 추출 못 한 문서를 그냥 넘기면 merge.mjs 가 빈 배열로
//   보고 '적합'으로 표시해버린다 — 지적사항이 있는 제조소가 적합으로 뒤바뀐다.
//   차라리 워크플로우를 실패시켜 사람이 보게 하는 편이 안전하다.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const PENDING = path.join(ROOT, "pending");
const MANIFEST = path.join(PENDING, "manifest.json");
const OUT = path.join(PENDING, "extracted.json");

const MODEL = "claude-opus-5";

// 지적사항 표의 한 행. 다섯 칸 모두 문자열이고, 빈 칸은 "" 로 채운다.
const SCHEMA = {
  type: "object",
  properties: {
    deficiencies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", description: "분야 (품질경영·시설장비·제조·시험실·원자재·포장표시 등). 원문 그대로." },
          gubun: { type: "string", description: "구분 (중대·중요·기타). 원문 그대로." },
          law: { type: "string", description: "근거 법령. 예: [별표 1] 제5.1호 마목" },
          summary: { type: "string", description: "지적(보완)사항 요약 원문 전체. 줄바꿈으로 끊긴 것은 한 문장으로 이어붙이되 의역·요약 금지." },
          remark: { type: "string", description: "비고. 없으면 빈 문자열." },
        },
        required: ["field", "gubun", "law", "summary", "remark"],
        additionalProperties: false,
      },
    },
  },
  required: ["deficiencies"],
  additionalProperties: false,
};

const PROMPT = (site, text) => `아래는 식약처가 공개한 의약품 제조소 GMP 실태조사 결과서 본문이다(제조소: ${site}).
'지적(보완)사항' 표를 읽어 각 지적사항을 항목으로 추출하라.

규칙:
- 표 컬럼은 [분야 / 구분(중대·중요·기타) / 근거 법령 / 지적(보완)사항 요약 / 비고] 이다.
- "지적(보완)사항(Deficiencies) 없음" 이라고 되어 있으면 빈 배열을 반환하라.
- summary 는 줄바꿈으로 끊긴 것을 자연스러운 한 문장으로 이어붙이되, **의역·번역·요약·윤문 금지**. 원문 한국어 그대로 옮겨라.
- 없는 내용을 지어내지 마라. 실제 제조소의 규제 정보다.
- 표 아래 각주(1) GMP 감시 분야(6개)…, 2) 지적사항은 PIC/S 정의에 따라… 등)는 지적사항이 아니다. 제외하라.
- **분야·구분 셀이 세로로 병합된 경우 주의**: 병합된 셀의 라벨은 그 블록의 세로 중앙 줄에 찍힌다.
  라벨 줄 번호가 (블록 첫 줄 + 마지막 줄)/2 가 되도록 행을 묶어, 어느 행이 어느 분야인지 정확히 갈라라.
  근거법령 번호로 분야를 추론하지 마라 — 문서가 법령 체계와 다르게 분류한 경우가 실제로 있다.

본문:
---
${text}
---`;

async function extractOne(client, rec) {
  const txt = path.join(PENDING, `${rec.docId}.txt`);
  if (!fs.existsSync(txt)) throw new Error(`본문 파일 없음: pending/${rec.docId}.txt`);
  const text = fs.readFileSync(txt, "utf8");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: PROMPT(rec.site, text) }],
  });

  // 안전 분류기가 거절하면 content 가 비거나 잘린다 — 읽기 전에 확인한다.
  if (res.stop_reason === "refusal") {
    throw new Error(`모델이 요청을 거절함 (category=${res.stop_details?.category ?? "?"})`);
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("max_tokens 도달 — 응답이 잘렸다. 추출 결과를 신뢰할 수 없음");
  }

  const block = res.content.find((b) => b.type === "text");
  if (!block) throw new Error(`텍스트 응답 없음 (stop_reason=${res.stop_reason})`);

  const parsed = JSON.parse(block.text);
  const defs = parsed.deficiencies;
  if (!Array.isArray(defs)) throw new Error("deficiencies 가 배열이 아님");
  return defs;
}

async function main() {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : [];
  if (!manifest.length) {
    console.log("EXTRACTED n=0 (신규 없음)");
    process.exit(0);
  }
  // hasText:false 는 자동 추출이 불가능하다. 그냥 넘기면 '적합'으로 잘못 표시되므로
  // 여기서 멈추고 사람이 처리하게 한다.
  const noText = manifest.filter((r) => !r.hasText);
  if (noText.length) {
    console.error(
      `EXTRACT_ERROR: 본문 텍스트 추출 실패 문서 ${noText.length}건 — 자동 처리 불가, 수동 확인 필요:\n` +
        noText.map((r) => `  - ${r.docId} ${r.site}`).join("\n"),
    );
    process.exit(1);
  }

  // 키 검사는 실제로 호출할 일이 있을 때만 — 신규 0건인 회차가 키 때문에 실패하지 않도록.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("EXTRACT_ERROR: ANTHROPIC_API_KEY 가 없습니다 (저장소 시크릿 확인).");
    process.exit(1);
  }

  const client = new Anthropic();
  const out = [];
  const failed = [];
  for (const rec of manifest) {
    try {
      const defs = await extractOne(client, rec);
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
