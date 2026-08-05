// 로컬 PC 자동 갱신 러너 — Windows 작업 스케줄러가 이걸 부른다.
//
// 흐름: pull → 신규 확인 → 추출(claude CLI) → merge → commit → push
// push 가 성공하면 GitHub Pages 재배포와 팀 알림메일(notify.yml)이 자동으로 이어진다.
//
// 왜 로컬인가: ①클라우드 루틴은 GitHub App 미설치로 push 가 403 (7/28~ 0회 성공)
//              ②GitHub Actions 추출은 유료 API 키가 필요한데 회사 정책상 발급이 어렵다
//              → 로컬 Claude Code 구독으로 추출하면 추가 비용이 없다.
//
// 실패해도 조용히 묻히지 않는다: 미반영이 26시간을 넘기면 gmp-fetch 의 감시 메일이 뜬다.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}
function node(script, env = {}) {
  return execFileSync(process.execPath, [script], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env },
  }).trim();
}

function main() {
  log("=== 로컬 갱신 시작 ===");

  git(["pull", "--rebase", "--autostash", "-q", "origin", "main"]);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "pending", "manifest.json"), "utf8"));
  if (!manifest.length) {
    log("신규 0건 — 할 일 없음.");
    return;
  }
  log(`신규 ${manifest.length}건: ${manifest.map((r) => r.site).join(", ")}`);

  // 추출 실패 시 여기서 예외가 나고 merge 로 넘어가지 않는다(부분 반영 방지).
  log(node("scripts/extract-local.mjs"));

  log(node("scripts/merge.mjs", {
    LIST_PATH: "pending/list.json",
    EXTRACTED_PATH: "pending/extracted.json",
  }));

  git(["add", "public/data.json"]);
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!staged) {
    log("data.json 변화 없음 — 커밋 생략.");
    return;
  }

  git(["-c", "user.name=nedrug-bot", "-c", "user.email=bot@users.noreply.github.com",
       "commit", "-q", "-m", `data: 실사결과 자동 갱신 (신규 ${manifest.length}건)`]);

  // Actions 가 같은 브랜치에 수시로 커밋하므로 non-fast-forward 거부가 흔하다.
  for (let i = 1; i <= 5; i++) {
    try {
      git(["pull", "--rebase", "--autostash", "-q", "origin", "main"]);
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
  log("=== 정상 종료 ===");
} catch (e) {
  log(`!! 실패: ${e.message}`);
  if (e.stdout) log(`stdout: ${String(e.stdout).trim()}`);
  if (e.stderr) log(`stderr: ${String(e.stderr).trim()}`);
  process.exit(1);
}
