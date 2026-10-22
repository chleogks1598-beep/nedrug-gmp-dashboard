# LLM 이 추출한 지적사항의 분야·구분·근거법령을 원본 PDF 표의 '칸 구조'로 바로잡는다.
# (scripts/tablefix.mjs 가 extract-local.mjs 추출 직후 호출)
#
# 왜: LLM 은 pdftotext 텍스트만 보고 표의 행 경계를 짐작한다. 그래서
#   - 표가 페이지를 넘어가며 이어지는 행을 다음 분야로 붙이고 (대웅바이오 2025-07-25)
#   - 세로로 쓴 「품질/경영」을 두 분야로 쪼개고
#   - 근거법령을 한 칸씩 밀어 적었다.
#   2026-10-22 전수조사에서 96개소 411항목이 이렇게 틀려 있었다(커밋 9ebf2d9).
#   pdfplumber 는 표의 괘선으로 칸을 나누므로 행 경계를 짐작하지 않는다.
#
# 사용: python -I table-fix.py <pdf>   (stdin = 지적사항 JSON 배열)
# 출력: stdout = {"deficiencies":[...], "changes":[...], "added":n, "unmatched":n, "mixed":[...]}
#       표를 못 찾으면 {"skip": "사유"} — 호출부는 LLM 결과를 그대로 쓴다.
import sys, json, re
import pdfplumber

STD = {'품질경영', '시설장비', '시험실', '원자재', '제조', '포장표시'}
MASK = '(원문 가림 처리 — 내용 비공개)'

def ws(s): return re.sub(r'\s+', ' ', s or '').strip()
def key(s): return re.sub(r'[^0-9A-Za-z가-힣]', '', s or '')

def colmap(header):
    m = {}
    for i, h in enumerate(header):
        h2 = re.sub(r'\s+', '', h or '')
        if not h2: continue
        if '분야' in h2 and 'field' not in m: m['field'] = i
        elif h2.startswith('구분') and 'gubun' not in m: m['gubun'] = i
        elif '근거' in h2 and 'law' not in m: m['law'] = i
        elif ('요약' in h2 or '지적' in h2 or '보완' in h2) and 'text' not in m: m['text'] = i
    return m

def keep(o):
    # 제목 그라데이션·검은 가림 박스 같은 '채운 사각형'은 괘선이 아니다(안 거르면 표를 못 찾는다)
    return not (o['object_type'] == 'rect' and o.get('fill') and min(o['width'], o['height']) > 1.2)

def parse(path):
    rows = []; lrow = 0
    with pdfplumber.open(path) as pdf:
        cm = None; ncols = None; cur = {}
        for pno, page in enumerate(pdf.pages):
            tables = sorted(page.filter(keep).find_tables(), key=lambda t: t.bbox[1])
            for ti, t in enumerate(tables):
                data = t.extract()
                if not data: continue
                m = colmap(data[0])
                if 'field' in m and 'text' in m:
                    if not (cm and ti == 0 and len(data[0]) == ncols):
                        cur = {}
                    cm = m; ncols = len(data[0]); body = data[1:]
                elif cm and ti == 0 and len(data[0]) == ncols:
                    body = data  # 페이지를 넘어 이어진 표 (머리글 없음)
                else:
                    cm = None
                    continue
                for ri, r in enumerate(body):
                    cell = lambda k: ws(r[cm[k]]) if k in cm and cm[k] < len(r) else ''
                    # 분야·구분 칸이 빈 첫 행 = 앞 쪽 행의 연속. 근거법령 칸이 쪽을 넘어 이어지면 합친다.
                    cont = body is data and ri == 0 and rows and not cell('field') and not cell('gubun')
                    if cont:
                        if cell('law'):
                            cur['law'] = ws(cur.get('law', '') + ' ' + cell('law'))
                            for x in rows:
                                if x['lrow'] == lrow: x['law'] = cur['law']
                    else:
                        for k in ('field', 'gubun', 'law'):
                            if cell(k): cur[k] = cell(k)
                        lrow = len(rows)
                    rows.append({'field': cur.get('field', ''), 'gubun': cur.get('gubun', ''),
                                 'law': cur.get('law', ''), 'text': cell('text'), 'row': len(rows), 'lrow': lrow})
    return rows

def toks(s):
    s = (s or '').replace('「의약품 등의 안전에 관한 규칙」', '')
    out = set(); annex = ''
    for m in re.finditer(r'\[\s*별표\s*(\d+(?:\s*의\s*\d+)?)\s*\]|(\d+(?:의\d+)?(?:\.\d+)*)\.?\s*호?\s*(?:([가-하])\s*목)?|(제\d+조)', s):
        if m.group(1): annex = re.sub(r'\s', '', m.group(1)); continue
        if m.group(4): annex = m.group(4); continue
        out.add('%s:%s%s' % (annex, m.group(2), ':' + m.group(3) if m.group(3) else ''))
    return frozenset(out)

def fieldval(pdf, data):
    k = key(pdf)
    if not k or k == key(data): return None
    if k in key(data) and k not in STD: return None   # 원문 오타(삼천당 「험실」) — 기존 값이 맞다
    return k if k in STD else ws(pdf)

def fix(path, defs):
    rows = parse(path)
    if not rows: return {'skip': '지적사항 표를 찾지 못함'}
    lt = {}
    for x in rows: lt[x['lrow']] = lt.get(x['lrow'], '') + key(x['text'])
    keyed = [(key(x['text']), x) for x in rows]
    hits = {}; unmatched = 0
    for i, d in enumerate(defs):
        k = key(d.get('summary'))
        if not k or '원문가림처리' in k: continue
        h = [x for kk, x in keyed if k[:20] in kk] or ([x for kk, x in keyed if k[-12:] in kk] if len(k) > 12 else [])
        if not h: unmatched += 1; continue
        if len({(x['field'], x['gubun'], x['law']) for x in h}) > 1: continue  # 같은 문장이 여러 행 — 판단 보류
        hits[i] = h[0]
    per_row = {}
    for x in hits.values(): per_row[x['row']] = per_row.get(x['row'], 0) + 1
    changes = []; mixed = []
    for i, x in hits.items():
        d = defs[i]; new = {}
        f = fieldval(x['field'], d['field'])
        if f is not None: new['field'] = f
        if key(x['gubun']) and key(x['gubun']) != key(d['gubun']): new['gubun'] = ws(x['gubun'])
        td, tp = toks(d['law']), toks(x['law'])
        if key(x['law']) and td != tp and not (td and td < tp and per_row[x['row']] > 1):
            # 한 칸에 법령 여러 개 + 항목 여러 개면 LLM 의 1:1 배정을 존중한다
            new['law'] = ws(x['law']).rstrip(',').strip()
        if new:
            changes.append({'i': i, 'summary': d['summary'][:40], 'before': {k: d[k] for k in new}, 'after': new})
            d.update(new)
        if key(d['summary']) not in lt[x['lrow']]:
            mixed.append(d['summary'][:60])   # 두 행의 문장이 한 항목에 섞임 — 자동으로 못 고친다
    # 행 전체가 가려진 칸 → 비공개 항목으로 자리만 남긴다 (전부 가린 문서는 이미 분야별 요약이라 제외)
    added = 0
    if defs and not all(MASK in d['summary'] for d in defs):
        usedL = {x['lrow'] for x in hits.values()}
        holders = {}
        for d in defs:
            if MASK in d['summary']:
                kk = (key(d['field']), toks(d['law'])); holders[kk] = holders.get(kk, 0) + 1
        ins = []
        for x in rows:
            if key(x['text']) or x['lrow'] in usedL or x['lrow'] != x['row'] or not key(x['field']) or not key(x['gubun']):
                continue
            f = fieldval(x['field'], '') or ''
            kk = (key(f), toks(x['law']))
            if holders.get(kk, 0) > 0: holders[kk] -= 1; continue
            before = [i for i, h in hits.items() if h['row'] < x['row']]
            ins.append((max(before) + 1 if before else 0, x['row'],
                        {'field': f, 'gubun': ws(x['gubun']), 'law': ws(x['law']).rstrip(',').strip(),
                         'summary': MASK, 'remark': ''}))
        for pos, _, item in sorted(ins, key=lambda a: (-a[0], -a[1])):
            defs.insert(pos, item); added += 1
    return {'deficiencies': defs, 'changes': changes, 'added': added, 'unmatched': unmatched, 'mixed': mixed}

if __name__ == '__main__':
    defs = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    try:
        res = fix(sys.argv[1], defs)
    except Exception as e:
        res = {'skip': 'pdfplumber 오류: ' + repr(e)[:200]}
    sys.stdout.buffer.write(json.dumps(res, ensure_ascii=False).encode('utf-8'))
