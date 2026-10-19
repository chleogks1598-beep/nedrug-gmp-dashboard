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
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
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

// ★ pdftotext 는 일부 PDF(글꼴 매핑이 없는 한글)에서 한글만 통째로 빠뜨리고 **오류 없이**
//   숫자·라틴 글자만 돌려준다. 그러면 LLM 이 빈 지적사항 표를 보고 [] 를 내서 '적합'으로
//   공개된다 — 2026-10-19 Remedica Ltd(실제 기타 6건) 신고로 드러났고, 전수 대조 결과
//   48건이 이렇게 '적합'으로 잘못 나가 있었다.
//   그래서 한글이 거의 없으면 pypdf 로 다시 읽고, 그래도 없으면 null(=사람 확인)로 돌린다.
const MIN_HANGUL = 30; // 결과서는 정상이면 한글이 수백 자 이상이다
const countHangul = (t) => (t.match(/[가-힣]/g) || []).length;
const PY_CANDIDATES = [
  process.env.PYTHON,
  path.join(os.homedir(), ".local", "python312", "python.exe"),
  "python3",
  "python",
].filter(Boolean);

function pypdfText(file) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pypdf-text.py");
  for (const py of PY_CANDIDATES) {
    try {
      return execFileSync(py, ["-I", script, file], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      // 이 파이썬이 없거나 pypdf 가 없음 → 다음 후보
    }
  }
  return null;
}

// 성공하면 텍스트, 실패하면 null.
// 호출부는 null 을 "본문 없음(hasText:false)" 으로 다루고 사람 확인을 요구한다.
export function pdfToText(file) {
  const t = pdftotextRaw(file);
  if (t != null && countHangul(t) >= MIN_HANGUL) return t;
  const alt = pypdfText(file);
  if (alt != null && countHangul(alt) >= MIN_HANGUL) {
    console.error(`PDFTEXT_FALLBACK: pdftotext 한글 누락 → pypdf 로 대체: ${file}`);
    return alt;
  }
  console.error(`PDFTEXT_NO_HANGUL: 한글을 읽지 못함(사람 확인 필요): ${file}`);
  return null;
}

function pdftotextRaw(file) {
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
