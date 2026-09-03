// 로컬 스케줄러용 안전성정보(회수·폐기 / 행정처분) 갱신 진입점.
// 흐름: pull → 수집·병합(safety-fetch) → 변경 있으면 commit → push
// push 하면 GitHub Pages 재배포와 알림메일(safety-notify.yml)이 이어진다.
//
// GMP 갱신(run-local-update.mjs)과 완전히 분리해서 돈다 — 한쪽이 실패해도 다른 쪽은 진행.
// 로그는 GMP 와 같은 local-update.log 에 남긴다.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { syncPull } from "./git-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");
const DATA = ["public/recall-data.json", "public/admin-data.json"];

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] [safety] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch { /* 로그 실패로 갱신을 막지 않는다 */ }
}
const git = args => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function main() {
  log("시작");
  // GMP 쪽이 남긴 untracked 보존본 때문에 pull 이 막혀 safety 까지 멈춘 적이 있다
  // (2026-09-03). syncPull 이 그 상황을 스스로 푼다 — scripts/git-sync.mjs 참고.
  syncPull(git, log, ROOT);

  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "safety-fetch.mjs")], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  out.split("\n").filter(Boolean).forEach(l => log(l.trim()));

  if (process.env.DRY_RUN) { log("DRY_RUN — 커밋·푸시 생략하고 종료."); return; }

  git(["add", ...DATA]);
  if (!git(["diff", "--cached", "--name-only"])) { log("변화 없음 — 커밋 생략."); return; }

  git(["-c", "user.name=nedrug-bot", "-c", "user.email=bot@users.noreply.github.com",
       "commit", "-q", "-m", "safety: 회수·폐기/행정처분 데이터 갱신"]);
  for (let i = 1; i <= 5; i++) {
    try {
      syncPull(git, log, ROOT);
      git(["push", "-q", "origin", "HEAD:main"]);
      log(`push 성공 — ${git(["log", "-1", "--oneline"])}`);
      return;
    } catch (e) {
      log(`push 재시도 ${i}/5: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error("push 5회 실패");
}

try {
  main();
} catch (e) {
  // execFileSync 는 자식의 stderr 를 e.stderr 에 담아 온다 — 원인을 로그에 남긴다.
  const detail = (e.stderr || "").toString().trim() || e.message;
  // safety-fetch 의 종료코드 2 = 표 구조/양식 변경 의심(파서를 고쳐야 함).
  const hint = e.status === 2 ? "[구조변경 의심 — 파서 점검 필요] " : "";
  log(`ERROR ${hint}${detail.split("\n").slice(-3).join(" / ")}`);
  process.exit(1);
}
