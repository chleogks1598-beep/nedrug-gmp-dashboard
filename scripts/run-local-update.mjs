// 로컬 PC 자동 갱신 러너 — Windows 작업 스케줄러가 이걸 부른다.
//
// 흐름: pull → 수집(식약처 직접) → 원본보관 → 추출(claude CLI) → merge → commit → push
// push 가 성공하면 GitHub Pages 재배포와 팀 알림메일(notify.yml)이 자동으로 이어진다.
//
// 왜 로컬인가: ①클라우드 루틴은 GitHub App 미설치로 push 가 403 (7/28~ 0회 성공)
//              ②GitHub Actions 추출은 유료 API 키가 필요한데 회사 정책상 발급이 어렵다
//              → 로컬 Claude Code 구독으로 추출하면 추가 비용이 없다.
//
// 수집도 로컬에서 한다(2026-08-06 추가): 한국 IP 는 식약처가 거의 항상 받아주지만
// GitHub Actions 는 성공률 60% 인 데다 예약(cron) 자체가 자주 스킵돼 실측 하루 3회만 돈다.
// 로컬에서 직접 받으면 감지 지연이 6~7시간에서 2시간으로 줄고, pending/ 을 저장소로
// 주고받는 왕복도 없어진다.
//   ※ Actions 수집(gmp-fetch)은 그대로 살려둔다 — PC 가 꺼져 있는 동안의 안전망이고,
//     "파이프라인이 멈췄다"를 알려주는 감시 메일(pending-alert)이 그 안에서 돌기 때문이다.
//     로컬 수집이 실패하면 Actions 가 받아둔 pending/ 백로그로 자동 전환한다.
//
// 실패해도 조용히 묻히지 않는다: 미반영이 26시간을 넘기면 gmp-fetch 의 감시 메일이 뜬다.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadQuarantine } from "./quarantine.mjs";
import { syncPull } from "./git-sync.mjs";

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

function readManifest(dir) {
  const f = path.join(ROOT, dir, "manifest.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}

const IDENT = ["-c", "user.name=nedrug-bot", "-c", "user.email=bot@users.noreply.github.com"];

// Actions 가 같은 브랜치에 수시로 커밋하므로 non-fast-forward 거부가 흔하다.
function pushWithRetry(label) {
  for (let i = 1; i <= 5; i++) {
    try {
      syncPull(git, log, ROOT);
      git(["push", "-q", "origin", "HEAD:main"]);
      log(`${label} push 성공 — ${git(["log", "-1", "--oneline"])}`);
      return;
    } catch (e) {
      log(`${label} push 재시도 ${i}/5: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(`${label} push 5회 실패`);
}

// ★ 추출이 실패해도 보존본은 먼저 커밋·푸시한다.
//   untracked 로 남겨두면, 그사이 Actions 수집기가 같은 파일을 커밋했을 때 이후 모든 pull 이
//   "untracked working tree files would be overwritten" 으로 거부되고 GMP·safety 파이프라인이
//   통째로 멈춘다 — 2026-09-03 에 실제로 14시간 정지했다.
//   notify.yml 은 public/data.json 경로만 보고 발화하므로 보존본만 올라가도 알림메일은 안 간다.
//   forms.json(제형)도 같이 커밋한다. 수집 단계에서 이미 채워졌고, 여기서 커밋해 두지 않으면
//   아래 push 의 pull --autostash 가 Actions 가 올린 forms.json 과 충돌해 실행이 꼬인다.
function commitArchive() {
  const paths = ["public/archive", "forms.json"];
  git(["add", ...paths]);
  const staged = git(["diff", "--cached", "--name-only", "--", ...paths]);
  if (!staged) return;
  const n = staged.split("\n").filter((f) => f.startsWith("public/archive/")).length;
  git([...IDENT, "commit", "-q", "-m", `archive: 실사결과서 보존본 ${n}건 추가`, "--", ...paths]);
  log(`보존본 ${n}건 선커밋 — 추출이 실패해도 다음 pull 이 막히지 않는다.`);
  pushWithRetry("보존본");
}

function main() {
  log("=== 로컬 갱신 시작 ===");

  syncPull(git, log, ROOT);

  // ① 수집 — newdocs/ 는 gitignore 대상이라 저장소를 더럽히지 않는다.
  //    실패해도 멈추지 않는다: Actions 가 pending/ 에 받아둔 백로그로 넘어간다.
  let work = "newdocs";
  try {
    log(node("scripts/fetch-new.mjs"));
  } catch (e) {
    log(`수집 실패(${String(e.message).split("\n")[0]}) — Actions 가 받아둔 pending/ 으로 진행`);
    work = "pending";
  }

  let manifest = readManifest(work);
  // 식약처가 이미 목록에서 내린 건은 방금 받은 목록에 없다. 그런 건은 Actions 가 먼저
  // 받아둔 pending/ 에만 남아 있으므로, 로컬 수집이 비었으면 그쪽을 확인한다.
  if (work === "newdocs" && !manifest.length) {
    const backlog = readManifest("pending");
    if (backlog.length) {
      log(`식약처 현재 목록엔 없지만 pending/ 에 ${backlog.length}건 남아 있음 — 그쪽으로 처리`);
      work = "pending";
      manifest = backlog;
    }
  }
  let commitMsg = `data: 실사결과 자동 갱신 (신규 ${manifest.length}건)`;

  // ★ 안전장치: 목록에 있는데 data.json 에도 manifest 에도 없는 문서가 하나라도 있으면
  //   이번 실행은 통째로 건너뛴다. 그런 건은 merge 에서 빈 배열 = '적합' 으로 잘못 찍힌다.
  //   다운로드가 그 건만 실패하면(fetch-new.mjs 가 skip) 이 상태가 된다.
  //   ※ 신규가 여러 건일 때 일부만 실패하는 경우까지 잡으려면 추출 '전'에 봐야 한다
  //     — 그래야 쓸데없는 LLM 호출도, 부분 반영도 없다.
  //   ※ 보류(quarantine.json) 건은 제외한다. 그 건은 merge 가 '확인중'으로 표시하므로
  //     '적합' 오표시 위험이 없고, 식약처가 원문을 내려 다운로드마저 실패하면 이 안전장치가
  //     매 회차 실행을 통째로 건너뛰게 만들어 파이프라인이 영구 정지한다.
  const quarantined = loadQuarantine();
  const listFile = path.join(ROOT, work, "list.json");
  if (fs.existsSync(listFile)) {
    const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
    const known = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data.json"), "utf8")).map((r) => r.docId));
    const inManifest = new Set(manifest.map((r) => r.docId));
    const missing = list.filter((r) => !known.has(r.docId) && !inManifest.has(r.docId) && !quarantined.has(r.docId));
    if (missing.length) {
      log(`미수집 문서 ${missing.length}건(${missing.map((r) => r.docId).join(", ")}) — 이번 실행 건너뜀, 다음 실행에서 재시도.`);
      return;
    }
  }

  if (!manifest.length) {
    // 신규 0건이어도 목록 메타데이터는 바뀔 수 있다. 실제로 '디아이지에어가스(주)'가
    // '에어리퀴드코리아(주)'로 사명이 바뀌었는데, 갱신이 신규 건에만 걸려 있어서
    // 다음 신규 건이 올 때까지 대시보드에 옛 이름이 남아 있었다. merge 만 다시 돌리면 되고
    // LLM 도 다운로드도 필요 없다.
    if (work !== "newdocs") {
      log("신규 0건 — 할 일 없음.");
      return;
    }
    // (미수집 문서 확인은 위에서 두 분기 공통으로 끝냈다.)
    log(node("scripts/merge.mjs", {
      LIST_PATH: "newdocs/list.json",
      EXTRACTED_PATH: "newdocs/__none.json", // 없는 경로 = 추출분 없음(기존 지적사항 그대로 유지)
    }));
    commitMsg = "meta: 목록 정보 갱신 (제조소명·주소 등)";
  } else {
    log(`신규 ${manifest.length}건(${work}): ${manifest.map((r) => r.site).join(", ")}`);

    // ② 원본 영구 보관 — 식약처가 원문을 내리기 전에 먼저 확보한다.
    //    merge 가 archiveFile(보존본 링크)을 붙이려면 merge 보다 앞서야 한다.
    try {
      log(node("scripts/archive-pdfs.mjs"));
    } catch (e) {
      log(`원본 보관 일부 실패 — 계속 진행(다음 실행에서 재시도): ${String(e.message).split("\n")[0]}`);
    }
    // 받은 보존본은 여기서 바로 커밋·푸시한다(이유는 commitArchive 주석 참고).
    if (!process.env.DRY_RUN) commitArchive();

    // ③ 추출 실패 시 여기서 예외가 나고 merge 로 넘어가지 않는다(부분 반영 방지).
    log(node("scripts/extract-local.mjs", { WORK_DIR: work }));

    log(node("scripts/merge.mjs", {
      LIST_PATH: `${work}/list.json`,
      EXTRACTED_PATH: `${work}/extracted.json`,
    }));
  }

  // DRY_RUN=1 이면 여기서 멈춘다 — 커밋·푸시 없이 파이프라인만 리허설할 때 쓴다
  // (data.json 에서 최근 건을 일부러 지우고 되살아나는지 대조하는 검증 절차).
  if (process.env.DRY_RUN) {
    log("DRY_RUN — 커밋·푸시 생략하고 종료.");
    return;
  }

  // forms.json(제형)·public/archive(보존본)도 이번 실행에서 늘어난다 — 같이 커밋해야 한다.
  // quarantine.json 은 사람이 손으로 고치는 파일이라 러너가 건드리지 않는다.
  git(["add", "public/data.json", "forms.json", "public/archive"]);
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!staged) {
    log("data.json 변화 없음 — 커밋 생략.");
    return;
  }

  git([...IDENT, "commit", "-q", "-m", commitMsg]);
  pushWithRetry("데이터");
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
