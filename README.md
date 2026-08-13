# 의약품안전나라 자동 수집 대시보드

식품의약품안전처 **의약품안전나라** 공개데이터를 자동 수집·정리해 검색/필터/통계를 제공하는
정적 웹 대시보드 모음입니다. 세 개의 대시보드가 한 저장소에서 GitHub Pages 로 배포됩니다.

| 경로 | 대시보드 | 원본 |
|---|---|---|
| `/` | 의약품등 GMP 실사 결과공개 | [CCBBD03](https://nedrug.mfds.go.kr/pbp/CCBBD03) |
| `/recall/` | 의약품 회수·폐기 | [CCBAI01](https://nedrug.mfds.go.kr/pbp/CCBAI01) |
| `/admin/` | 의약품 행정처분정보 | [CCBAO01](https://nedrug.mfds.go.kr/pbp/CCBAO01) |

GMP 실사건은 **지적(보완)사항**을 원본 PDF에서 추출해 표로 정리하고, 원본 문서로 바로 연결합니다.
회수·폐기와 행정처분은 목록/상세가 HTML 표로 제공되므로 규칙 기반으로 전량 파싱합니다.

## 구성

```
public/
  index.html     대시보드 (단일 파일, 외부 의존성 없음)
  data.json      데이터셋 (전체 실사 목록 + 지적사항)
scripts/
  fetch-new.mjs  목록 재조회 → 신규 docId 감지 → 신규 원본 다운로드/텍스트 추출
  merge.mjs      최신 메타데이터 + 기존/신규 지적사항 병합 → public/data.json
  serve.mjs      로컬 정적 서버 (개발용)
```

## 데이터 갱신 파이프라인

의약품안전나라에 실사 결과가 추가되면 아래 순서로 갱신됩니다 (매일 자동 실행 — 클라우드 루틴).

1. `node scripts/fetch-new.mjs`
   전체 목록을 재조회하고, `public/data.json`에 없는 **신규 docId**만 골라 원본 파일을
   `newdocs/`에 내려받고 텍스트를 추출합니다. `newdocs/list.json`(전체 최신 메타)과
   `newdocs/manifest.json`(신규 건)을 생성합니다. `NEW=<건수>`를 출력합니다.
2. **지적(보완)사항 추출** — 신규 건이 있으면, 각 `newdocs/<docId>.txt`에서
   지적사항을 구조화하여 `newdocs/extracted.json`
   (`[{docId, deficiencies:[{field,gubun,law,summary,remark}]}]`)으로 저장합니다.
   (이 단계는 LLM 판단이 필요해 Claude 에이전트가 수행합니다.)
3. `node scripts/merge.mjs`
   최신 목록 순서/메타데이터에 기존·신규 지적사항을 합쳐 `public/data.json`을 다시 씁니다.
4. 변경분을 git commit & push → Vercel이 자동 재배포합니다.

## 회수·폐기 / 행정처분 파이프라인

GMP 와 달리 첨부 PDF·LLM 추출이 없어 스크립트 하나로 끝납니다.

```
scripts/
  safety-common.mjs       공통: UA 헤더 fetch 재시도, 목록/상세 HTML 파싱, 소스 정의
  safety-fetch.mjs        목록 전량 조회 → 신규·변경 건만 상세 수집 → public/{recall,admin}-data.json
  build-safety-email.mjs  직전 스냅샷 대비 신규·변경 알림 메일 본문 (수신자 recipients-safety.json)
  run-safety-update.mjs   로컬 스케줄러 진입점 (pull → 수집 → commit → push)
public/
  recall/index.html  admin/index.html   대시보드 (각각 단일 파일)
  recall-data.json   admin-data.json    데이터셋
```

```bash
node scripts/safety-fetch.mjs                  # 두 소스 모두
node scripts/safety-fetch.mjs --source=admin   # 하나만
DRY_RUN=1 node scripts/run-safety-update.mjs   # 커밋·푸시 없이 리허설
```

- 자동화: 로컬 작업 스케줄러 `NedrugGmpUpdate`(2시간마다, `run-local-update.cmd`)가 GMP 와 함께 실행하고,
  PC 가 꺼진 동안을 위해 `.github/workflows/safety-fetch.yml`(2시간마다)이 같은 일을 합니다.
- 데이터 푸시 → `pages.yml` 재배포 + `safety-notify.yml` 알림메일.
- **누적 보존**: 두 게시판 모두 공개기간이 끝나면 원문 목록에서 사라집니다(행정처분은 수개월).
  목록에서 내려간 건은 삭제하지 않고 `delisted` 표시만 붙여 계속 보존합니다.
- 상세 응답은 `%TEMP%\nedrug-safety-cache` 에 캐시되어 중단 후 재시도 시 이어받습니다.
- `safety-fetch.mjs` 종료코드: `0` 정상 / `1` 식약처 접속 실패(조용히 재시도) /
  **`2` 목록·상세 표 구조 변경 의심** — 2면 Actions job 을 빨간불로 실패시켜 알림이 가게 합니다.
- 상세 한 건이라도 수집에 실패하면 그 소스는 **통째로 반영하지 않습니다**(부분 반영 금지).
  단, 식약처가 상세 대신 오류 페이지를 주는 건(데이터 결함)은 `detail.unavailable` 로 표시하고
  목록 정보만으로 진행하며 매 회차 다시 시도합니다.

## 로컬 실행

```bash
npm install
npm run serve   # http://localhost:8787
```

## 주의

- 지적(보완)사항 요약은 원본 PDF에서 자동 추출한 것으로, 정확한 내용은 각 행의 **원본 문서**를 확인하세요.
- 본 저장소는 식약처 공개 데이터를 정리한 **참고용**이며 공식 자료가 아닙니다.

<!-- deploy check: 2026-07-28T00:19:40Z -->
