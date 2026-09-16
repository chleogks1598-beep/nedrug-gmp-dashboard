// run-hidden.vbs 가 '다른 작업이 아직 돌고 있어 이번 회차를 건너뛴다'를 로그에 남길 때 쓴다.
//
// .vbs 는 CP949 로 읽히므로 한글을 직접 넣을 수 없다(scripts/log-fail.mjs 와 같은 이유).
// 조용히 종료하면 "왜 안 돌았지"를 나중에 알 방법이 없어서 반드시 한 줄을 남긴다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19); // 이 로그는 UTC 기준

const TASK = {
  "run-local-update.cmd": "GMP 실사결과/안전성정보",
  "run-change-orders.cmd": "변경명령",
};
const which = TASK[process.argv[2]] ?? process.argv[2] ?? "알 수 없는";
const mins = process.argv[3] ?? "?";

const line =
  `[${stamp()}] -- ${which} 갱신 건너뜀: 다른 갱신 작업이 ${mins}분째 실행 중이라 순번을 못 잡았다. ` +
  `(같은 저장소를 동시에 만지면 git pull 이 서로 충돌한다 — run-hidden.vbs 의 실행 잠금) 다음 예약에서 다시 시도한다.`;
try { fs.appendFileSync(LOG, line + "\n"); } catch {}
console.log(line);
