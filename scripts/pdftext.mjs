// pdftotext 호출을 한 곳에 모은다.
//
// ★ 왜 별도 모듈인가: `execFileSync("pdftotext", ...)` 는 PATH 에 있을 때만 동작한다.
// 이 PC 의 pdftotext 는 Git for Windows 의 mingw64 안에 들어 있는데, 그 디렉터리는
// Git Bash 안에서만 PATH 에 올라온다. cmd.exe(작업 스케줄러 `NedrugGmpUpdate` 가
// 쓰는 환경)에서는 잡히지 않는다.
// 그래서 "손으로 Git Bash 에서 돌릴 땐 되는데 스케줄러로 돌면 hasText:false" 라는
// 형태로 2026-08-10 신규 1건(중부산업가스)에서 파이프라인이 멈췄다.
// PATH 에 없으면 알려진 설치 위치를 직접 찾아본다.
import fs from "fs";
import { execFileSync } from "child_process";

// 우선순위: 환경변수 > PATH > 알려진 설치 위치
const CANDIDATES = [
  "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
  "C:\\Program Files (x86)\\Git\\mingw64\\bin\\pdftotext.exe",
  "C:\\msys64\\mingw64\\bin\\pdftotext.exe",
  "C:\\ProgramData\\chocolatey\\bin\\pdftotext.exe",
  "C:\\Program Files (x86)\\nSeries\\nPDF\\utils\\pdftotext.exe",
];

let resolved; // null = 못 찾음, undefined = 아직 안 찾아봄

function probe(exe) {
  try {
    execFileSync(exe, ["-v"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // pdftotext -v 는 버전을 stderr 로 찍고 0 이 아닌 코드로 끝나기도 한다.
    // 실행 자체가 안 된 경우(ENOENT)만 실패로 본다.
    return e.code !== "ENOENT";
  }
}

export function resolvePdftotext() {
  if (resolved !== undefined) return resolved;
  const env = process.env.PDFTOTEXT;
  if (env && fs.existsSync(env)) return (resolved = env);
  if (probe("pdftotext")) return (resolved = "pdftotext");
  for (const c of CANDIDATES) if (fs.existsSync(c)) return (resolved = c);
  return (resolved = null);
}

// 성공하면 텍스트, 실패하면 null.
// 호출부는 null 을 "본문 없음(hasText:false)" 으로 다루고 사람 확인을 요구한다.
export function pdfToText(file) {
  const exe = resolvePdftotext();
  if (!exe) {
    console.error(
      "PDFTOTEXT_MISSING: pdftotext 실행 파일을 찾지 못했습니다. " +
        "PATH 에 넣거나 환경변수 PDFTOTEXT 로 경로를 지정하세요.",
    );
    return null;
  }
  try {
    return execFileSync(exe, ["-enc", "UTF-8", "-layout", file, "-"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`PDFTOTEXT_FAILED: ${file} — ${e.message}`);
    return null;
  }
}
