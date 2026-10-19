// 로컬 스케줄러용 변경명령(CCBAR01F012) 감시 진입점.
// 흐름: pull → 수집(change-orders.mjs LOCAL) → 기준선 갱신 → 변경 있으면 commit → push
// push 하면 change-orders-notify.yml 이 직전 커밋과 비교해 알림메일을 보낸다.
// 2026-10-19 부터 같은 회차에 식약처·대전청 공지사항 감시(notice-watch.mjs → notices.json,
// 메일은 notices-notify.yml)도 돈다. 두 감시는 서로 실패를 격리한다.
//
// 왜 로컬로 옮겼나: 같은 감시를 GitHub Actions 에서 매시간 돌렸는데 식약처가 클라우드 IP 를
// 간헐 차단해 UND_ERR_CONNECT_TIMEOUT 으로 3회 중 1회씩 실패했다(2026-09-10 확인).
// 사내망에서는 막히지 않는다. 클라우드 쪽(change-orders.yml)은 PC 가 꺼져 있을 때를 위한
// 하루 1회 안전망으로만 남겼다.
//
// 메일 발송은 GitHub 에 남아 있다 — Gmail 자격증명이 Actions Secrets 에만 있고,
// 이 PC 에 SMTP 비밀번호를 두지 않기 위해서다. 회수·폐기(run-safety-update.mjs)와 같은 구조.
//
// GMP·safety 갱신과 완전히 분리해서 돈다 — 한쪽이 실패해도 다른 쪽은 진행.
// 로그는 같은 local-update.log 에 남긴다.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { syncPull } from "./git-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");
const SNAP = path.join(ROOT, "change-orders.json");
const CURFILE = path.join(ROOT, "change-orders.current.json");
// 식약처·대전청 공지사항 감시(scripts/notice-watch.mjs) — 같은 매시간 작업에 얹었다
const NOTICE_SNAP = path.join(ROOT, "notices.json");
const NOTICE_CUR = path.join(ROOT, "notices.current.json");

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] [변경명령] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch { /* 로그 실패로 갱신을 막지 않는다 */ }
}
const git = args => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function main() {
  log("시작");
  syncPull(git, log, ROOT);

  // 두 감시(변경명령 / 공지사항)는 서로 독립이다 — 한쪽 접속이 실패해도 다른 쪽은 커밋·푸시한다.
  // 실패한 쪽은 기준선을 전진시키지 않으므로 다음 회차에 그대로 재시도된다.
  const failed = [];
  const step = (name, script, cur, snap) => {
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", script)], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LOCAL: "1" },
      });
      out.split("\n").filter(Boolean).forEach(l => log(`${name}: ${l.trim()}`));
      // 스크립트는 실패하면 0 이 아닌 종료코드로 죽으므로(execFileSync 가 throw)
      // 여기 오면 cur 는 방금 받은 온전한 목록이다.
      if (!fs.existsSync(cur)) throw new Error(`수집 결과가 없습니다: ${cur}`);
      if (process.env.DRY_RUN) return;
      fs.copyFileSync(cur, snap);
      git(["add", path.basename(snap)]);
    } catch (e) {
      const detail = (e.stderr || "").toString().trim() || e.message;
      log(`ERROR ${name}: ${detail.split("\n").slice(-3).join(" / ")}`);
      failed.push(name);
    }
  };
  step("변경명령", "change-orders.mjs", CURFILE, SNAP);
  step("공지", "notice-watch.mjs", NOTICE_CUR, NOTICE_SNAP);

  if (process.env.DRY_RUN) { log("DRY_RUN — 기준선 갱신·커밋·푸시 생략하고 종료."); return failed; }
  if (!git(["diff", "--cached", "--name-only"])) { log("변화 없음 — 커밋 생략."); return failed; }

  git(["-c", "user.name=nedrug-bot", "-c", "user.email=bot@users.noreply.github.com",
       "commit", "-q", "-m", "monitor: 변경명령·공지 스냅샷 갱신"]);
  for (let i = 1; i <= 5; i++) {
    try {
      syncPull(git, log, ROOT);
      git(["push", "-q", "origin", "HEAD:main"]);
      log(`push 성공 — ${git(["log", "-1", "--oneline"])} (메일은 change-orders-notify.yml / notices-notify.yml 가 발송)`);
      return failed;
    } catch (e) {
      log(`push 재시도 ${i}/5: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error("push 5회 실패");
}

try {
  const failed = main();
  if (failed.length) throw new Error(`실패 단계: ${failed.join(", ")}`);
} catch (e) {
  // execFileSync 는 자식의 stderr 를 e.stderr 에 담아 온다 — 원인을 로그에 남긴다.
  const detail = (e.stderr || "").toString().trim() || e.message;
  log(`ERROR ${detail.split("\n").slice(-3).join(" / ")}`);
  process.exit(1);
}
