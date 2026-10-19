# pdftotext 가 한글을 통째로 빠뜨리는 PDF 용 폴백 (scripts/pdftext.mjs 가 호출).
# 사용: python -I pypdf-text.py <pdf>  → stdout 에 UTF-8 텍스트
import sys
from pypdf import PdfReader

out = []
for page in PdfReader(sys.argv[1]).pages:
    try:
        out.append(page.extract_text(extraction_mode="layout") or "")
    except Exception:
        out.append(page.extract_text() or "")
sys.stdout.buffer.write("\n".join(out).encode("utf-8"))
