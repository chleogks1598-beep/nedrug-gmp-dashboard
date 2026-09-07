// 스케줄러 진입점(run-local-update.cmd)이 '단계 실패'를 로그에 남길 때 쓰는 한 줄짜리 도구.
//
// .cmd 는 CP949 로 읽히므로 한글을 직접 넣을 수 없다. 그래서 문구만 이 파일(UTF-8)로 뺐다.
// 이게 없으면 단계가 죽어도 local-update.log 에는 '정상 종료' 없이 뚝 끊긴 흔적만 남아,
// 나중에 로그만 봐서는 '멈춰 있는 중'인지 '죽은 것'인지 구별할 수 없다(2026-09-04 실제 오진).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19); // 이 로그는 UTC 기준

const STAGE = { gmp: "GMP 실사결과", safety: "회수·폐기/행정처분" };
const stage = STAGE[process.argv[2]] ?? process.argv[2] ?? "알 수 없는";
const code = process.argv[3] ?? "?";

const line =
  `[${stamp()}] !! ${stage} 단계 비정상 종료 (종료코드 ${code}). ` +
  `바로 위 줄이 멈춘 지점이다. 종료코드 -1073741510(0xC000013A)이면 창을 닫았거나 Ctrl+C 로 끊긴 것.`;
try { fs.appendFileSync(LOG, line + "\n"); } catch {}
console.log(line);
