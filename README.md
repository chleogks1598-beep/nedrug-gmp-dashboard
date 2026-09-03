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
  quarantine.mjs 자동 처리 불가로 '보류'한 문서 목록 로더 (→ quarantine.json)
  git-sync.mjs   두 수집기(로컬·Actions)가 같은 파일을 받아 pull 이 막히는 상황을 푸는 pull
  serve.mjs      로컬 정적 서버 (개발용)
quarantine.json  자동 추출 불가 판정 건 (사람이 직접 관리 → 대시보드에 '확인중' 표시)
```

> **수집기가 둘입니다.** 로컬 스케줄러와 GitHub Actions(`gmp-fetch`, PC 가 꺼진 동안의 안전망)가
> 같은 파일(`public/archive/*.pdf`)을 각자 내려받습니다. 로컬이 추출 단계에서 죽으면 그 PDF 가
> untracked 로 남고, 그사이 Actions 가 같은 파일을 커밋하면 이후 모든 `git pull` 이
> `untracked working tree files would be overwritten` 로 거부되어 **GMP 와 safety 가 함께 멈춥니다**
> (2026-09-03 발생). 대책 두 가지: 보존본은 추출 전에 먼저 커밋·푸시하고(`run-local-update.mjs`),
> 그래도 막히면 `git-sync.mjs` 가 원격과 바이트 동일한 것만 지우고 다른 것은 `.conflict/` 로
> 대피시킨 뒤 재시도합니다.

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

**추출 실패는 부분 반영하지 않습니다.** 한 건이라도 실패하면 merge 로 넘어가지 않고 실행 전체를
중단합니다 — 일부만 반영하면 지적사항이 있는 제조소가 빈 배열(=`적합`)로 공개되고, 한 번 들어가면
다음 회차부터 `known` 이라 영영 다시 보지 않습니다.

### 자동 처리 불가 문서 보류 — `quarantine.json`

식약처가 **애초에 자동 추출이 불가능한 파일**을 올리는 경우가 있습니다(2026-09-02 중앙산업가스(주)
대덕 건은 원문이 문서보안 DRM 래퍼로 올라와 PDF/HWPX 구조가 아예 없었습니다). 이런 건은 재시도로
풀리지 않으므로 위의 하드 스톱이 **해독 불가능한 1건 때문에 같이 올라온 다른 신규 건과 이후 모든
갱신을 무기한 막습니다**(실제로 14시간 정지).

그래서 `quarantine.json` 에 사람이 직접 적어 '보류'로 뺍니다.

```json
[{ "docId": "…", "site": "…", "regDate": "…", "since": "…", "reason": "…", "action": "…" }]
```

| 단계 | 보류 건 처리 |
|---|---|
| `extract*.mjs` | 건너뜀 (LLM 호출 없음). 본문이 읽히게 되면 정상 추출로 되돌아감 |
| `merge.mjs` | `적합`이 아니라 **`확인중`** + `unresolved:true` 로 기록 |
| 대시보드 | `확인중` 배지·전용 필터·별도 타일. 적합 건수에 섞이지 않음 |
| `pending-alert.mjs` | 감시 메일에서 제외(사람이 이미 인지한 건) |
| `fetch-new.mjs` | `unresolved` 건은 `known` 에서 빼 매 회차 다시 받아봄 → 재업로드되면 자동 해소 |

- **자동 등록하지 않습니다.** 추출 실패를 자동 보류하면 claude CLI 일시 오류 같은 '고칠 수 있는
  실패'까지 조용히 `확인중` 으로 굳어져, 하드 스톱이 지켜주던 안전성이 사라집니다.
- 해소되면 `quarantine.json` 에서 항목을 지웁니다. 추출 정보 없이 항목만 지우면 merge 가 다시
  하드 스톱합니다(의도된 동작 — `unresolved` 레코드는 `prevDef` 에서 제외되므로 `적합` 으로 굳지 않습니다).

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
