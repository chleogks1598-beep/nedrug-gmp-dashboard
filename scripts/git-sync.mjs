// origin/main 과 맞추는 pull. 로컬 러너(GMP·safety·변경명령)가 시작할 때 공통으로 쓴다.
//
// 왜 별도 모듈인가: 이 저장소는 **수집기가 둘**이다 — 로컬 스케줄러와 GitHub Actions(gmp-fetch,
// PC 가 꺼져 있는 동안의 안전망). 둘이 같은 파일(public/archive/*.pdf)을 각자 내려받는다.
// 로컬 실행이 보관 단계를 지나 추출 단계에서 죽으면 그 PDF 가 커밋되지 못하고 untracked 로
// 남는데, 그사이 Actions 가 같은 파일을 커밋해 버리면 이후 모든 pull 이
//   error: The following untracked working tree files would be overwritten by merge
// 로 거부된다. 그러면 GMP 뿐 아니라 같은 pull 을 쓰는 safety(회수·폐기/행정처분)까지
// 통째로 멈춘다 — 2026-09-03 에 실제로 그렇게 14시간 정지했다.
//
// 그래서 그 상황을 스스로 푼다: 막고 있는 untracked 파일이 원격 것과 **바이트 동일**하면
// 삭제하고(어차피 원격에서 받아온다), 내용이 다르면 .conflict/ 로 옮겨 증거를 남긴 뒤 재시도한다.
// 절대 내용을 조용히 버리지 않는다.
import fs from "fs";
import path from "path";

// git stderr 에서 "…overwritten by merge/checkout:" 아래 탭으로 들여쓴 경로들을 뽑아낸다.
function blockedPaths(stderr) {
  const s = String(stderr || "");
  if (!/untracked working tree files would be overwritten/.test(s)) return [];
  const out = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\t(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// 자동 복구해도 되는 파일: 러너가 매 회차 새로 만들어 내는 데이터뿐이다.
// 스크립트(.mjs 등)가 충돌했다면 사람이 고친 것이니 건드리지 않고 실패시킨다.
const REGENERATED = rel => /\.json$/i.test(rel) || rel.startsWith("public/");

// 이전 실행이 남긴 '반쯤 끝난 git 상태'를 푼다.
//
// 2026-09-17~28 에 11일 정지한 원인: 변경명령 단계가 change-orders.json 을 고친 채 죽었고,
// 다음 실행의 pull --autostash 가 원격(Actions 안전망이 같은 파일을 갱신)을 받은 뒤
// 스태시를 되돌리다 충돌 → 'UU change-orders.json' 이 남았다. 그 뒤로 세 단계 전부가
//   error: Pulling is not possible because you have unmerged files.
// 로 시작하자마자 죽었다. 충돌 파일은 전부 러너가 다시 만드는 데이터라서, 원격(HEAD) 쪽으로
// 되돌리고 다음 단계가 새로 생성하게 두면 된다. 되돌리기 전 로컬 내용은 .conflict/ 에 남긴다.
export function healWorkingCopy(git, log, ROOT) {
  const gitDir = path.join(ROOT, ".git");
  for (const [marker, cmd] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"]]) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      log(`중단된 git ${cmd} 발견 — --abort 로 되돌린다`);
      git([cmd, "--abort"]);
    }
  }

  const unmerged = [...new Set(git(["diff", "--name-only", "--diff-filter=U"]).split(/\r?\n/).filter(Boolean))];
  if (!unmerged.length) return;

  const manual = unmerged.filter(rel => !REGENERATED(rel));
  if (manual.length) {
    throw new Error(`충돌 파일 중 자동 복구 대상이 아닌 것이 있다 — 직접 확인 필요: ${manual.join(", ")}`);
  }
  log(`풀리지 않은 충돌 ${unmerged.length}건 발견 — 원격 쪽으로 되돌린다(로컬 내용은 .conflict/ 에 보관): ${unmerged.join(", ")}`);
  const dir = path.join(ROOT, ".conflict", `${Date.now()}-unmerged`);
  for (const rel of unmerged) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(abs, path.join(dir, rel));
    }
  }
  git(["checkout", "HEAD", "--", ...unmerged]);
  log(`충돌 복구 완료 — 보관 위치 .conflict/${path.basename(dir)}`);
}

// git: (args[]) => stdout, log: (msg) => void, ROOT: 저장소 경로
export function syncPull(git, log, ROOT) {
  healWorkingCopy(git, log, ROOT);
  try {
    git(["pull", "--rebase", "--autostash", "-q", "origin", "main"]);
    // 함정: autostash 를 되돌리다 충돌해도 git 은 pull 을 **성공(종료코드 0)** 으로 끝낸다.
    // 그래서 성공 뒤에도 한 번 더 본다 — 이번 회차 안에서 바로 풀어야 뒤 단계가 산다.
    // (그때 로컬 변경분은 git 이 stash 목록에 남겨 두므로 잃지 않는다)
    healWorkingCopy(git, log, ROOT);
    return;
  } catch (e) {
    const blocked = blockedPaths(`${e.stderr || ""}\n${e.stdout || ""}\n${e.message || ""}`);
    if (!blocked.length) throw e; // 우리가 아는 상황이 아니면 그대로 실패시킨다

    log(`pull 이 untracked 파일 ${blocked.length}건에 막힘 — 원격 것과 대조해 정리한다: ${blocked.join(", ")}`);
    let removed = 0, moved = 0;
    for (const rel of blocked) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      let same = false;
      try {
        // 방금 pull 이 fetch 까지는 했으므로 FETCH_HEAD 로 원격 내용을 볼 수 있다.
        same = git(["hash-object", rel]) === git(["rev-parse", `FETCH_HEAD:${rel}`]);
      } catch { same = false; }
      if (same) {
        fs.rmSync(abs);
        removed++;
      } else {
        const dest = path.join(ROOT, ".conflict", `${Date.now()}-${path.basename(rel)}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(abs, dest);
        moved++;
        log(`  ! ${rel} 은 원격과 내용이 달라 .conflict/${path.basename(dest)} 로 옮겼다 — 확인 필요`);
      }
    }
    log(`정리 완료(동일 삭제 ${removed}건 / 보류 이동 ${moved}건) — pull 재시도`);
    git(["pull", "--rebase", "--autostash", "-q", "origin", "main"]);
  }
}
