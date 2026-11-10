"""Dump a .docx / .pptx / .txt to plain text so the model reads it once.

Reading binary Office files through python-docx/pptx on every turn is expensive and
fragile (long results get compressed in transit). Converting once to a .txt keeps
the working notes small and lets ops_grep search them.
"""
import json
import os
import sys


def dump_docx(path):
    from docx import Document

    doc = Document(path)
    lines = []
    for paragraph in doc.paragraphs:
        text = paragraph.text.strip()
        if text:
            lines.append(text)
    for index, table in enumerate(doc.tables, 1):
        lines.append("")
        lines.append("[表格 %d]" % index)
        for row in table.rows:
            cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
            lines.append(" | ".join(cells))
    return lines, {"paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}


def dump_pptx(path):
    from pptx import Presentation

    prs = Presentation(path)
    lines = []
    for number, slide in enumerate(prs.slides, 1):
        lines.append("")
        lines.append("[第 %d 页]" % number)
        for shape in slide.shapes:
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    text = "".join(run.text for run in paragraph.runs).strip()
                    if text:
                        lines.append(text)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                    lines.append(" | ".join(cells))
    return lines, {"slides": len(prs.slides)}


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: ref_dump.py <input.docx|pptx|txt> <output.txt>")
    source, out = sys.argv[1], sys.argv[2]
    ext = os.path.splitext(source)[1].lower()
    if ext == ".docx":
        lines, meta = dump_docx(source)
        kind = "docx"
    elif ext == ".pptx":
        lines, meta = dump_pptx(source)
        kind = "pptx"
    elif ext in (".txt", ".md"):
        with open(source, "r", encoding="utf-8", errors="ignore") as handle:
            lines = [line.rstrip() for line in handle]
        meta, kind = {}, "text"
    else:
        raise SystemExit("unsupported file type: %s" % ext)

    body = "\n".join(lines).strip() + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        handle.write(body)
    print(json.dumps({"out": out, "kind": kind, "chars": len(body),
                      "lines": len(body.splitlines()), **meta}, ensure_ascii=False))


if __name__ == "__main__":
    main()
