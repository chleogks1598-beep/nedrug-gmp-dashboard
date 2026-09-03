// origin/main 과 맞추는 pull. 로컬 러너(GMP·safety)가 시작할 때 공통으로 쓴다.
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

// git: (args[]) => stdout, log: (msg) => void, ROOT: 저장소 경로
export function syncPull(git, log, ROOT) {
  try {
    git(["pull", "--rebase", "--autostash", "-q", "origin", "main"]);
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
