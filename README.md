# 의약품등 GMP 실사 결과공개 대시보드

식품의약품안전처 **의약품안전나라**의 [의약품등 GMP 실사 결과공개](https://nedrug.mfds.go.kr/pbp/CCBBD03)
데이터를 수집·정리하여 검색/필터/통계를 제공하는 정적 웹 대시보드입니다.
각 실사건의 **지적(보완)사항**을 원본 PDF에서 추출해 표로 정리하고, 원본 문서로 바로 연결합니다.

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

## 로컬 실행

```bash
npm install
npm run serve   # http://localhost:8787
```

## 주의

- 지적(보완)사항 요약은 원본 PDF에서 자동 추출한 것으로, 정확한 내용은 각 행의 **원본 문서**를 확인하세요.
- 본 저장소는 식약처 공개 데이터를 정리한 **참고용**이며 공식 자료가 아닙니다.
