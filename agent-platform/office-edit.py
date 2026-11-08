"""Write one edited element back into an Office file.

Runs inside a disposable sandbox container (python-docx / openpyxl /
python-pptx are already installed) with the workspace bind-mounted at
/workspace. The request arrives as JSON on stdin:

    {"path": "default/report.docx",
     "target": {"kind": "docx", "paragraph": 3} | {"kind": "xlsx", "sheet": "...", "ref": "B4"} | {"kind": "pptx", "slide": 2, "shape": 3},
     "value": "new text"}

and stdout carries {"ok": true, "before": "...", "after": "..."} or
{"error": "..."}. Element numbering matches the preview renderer: paragraphs
are counted in document order across the whole body, slides and shapes in
PresentationML document order.
"""
import json
import os
import sys

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
SHAPE_TAGS = {"sp", "pic", "graphicFrame"}


try:
    # The request carries UTF-8 paths and text; Windows consoles default to a
    # legacy codepage, and the container is UTF-8 already.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass


def fail(message):
    print(json.dumps({"error": message}, ensure_ascii=False))
    sys.exit(0)


def edit_docx(path, target, value):
    from docx import Document
    from docx.text.paragraph import Paragraph

    document = Document(path)
    paragraphs = list(document.element.body.iter("{%s}p" % W_NS))
    index = int(target.get("paragraph") or 0)
    if not 1 <= index <= len(paragraphs):
        fail("段落不存在")
    paragraph = Paragraph(paragraphs[index - 1], document)
    before = paragraph.text
    runs = paragraph.runs
    if runs:
        runs[0].text = value
        for run in runs[1:]:
            run._element.getparent().remove(run._element)
    elif value:
        paragraph.add_run(value)
    document.save(path)
    return before


def edit_xlsx(path, target, value):
    from openpyxl import load_workbook

    workbook = load_workbook(path)
    name = str(target.get("sheet") or "")
    sheet = workbook[name] if name in workbook.sheetnames else workbook.active
    ref = str(target.get("ref") or "").strip().upper()
    if not ref or len(ref) > 12:
        fail("单元格无效")
    cell = sheet[ref]
    before = cell.value
    cell.value = coerce(value, before)
    workbook.save(path)
    return "" if before is None else str(before)


def coerce(value, before):
    if isinstance(before, (int, float)) and not isinstance(before, bool):
        try:
            number = float(str(value).replace(",", "").replace("¥", "").strip())
            return int(number) if number.is_integer() and isinstance(before, int) else number
        except ValueError:
            return value
    return value


def edit_pptx(path, target, value):
    from pptx import Presentation

    presentation = Presentation(path)
    slides = list(presentation.slides)
    slide_index = int(target.get("slide") or 0)
    shape_index = int(target.get("shape") or 0)
    if not 1 <= slide_index <= len(slides):
        fail("幻灯片不存在")
    slide = slides[slide_index - 1]
    shapes = [element for element in slide.element.iter() if etree.QName(element).localname in SHAPE_TAGS]
    if not 1 <= shape_index <= len(shapes):
        fail("元素不存在")
    element = shapes[shape_index - 1]
    body = element.find("{%s}txBody" % P_NS)
    if body is None:
        fail("这个元素没有文字")
    before = "".join(node.text or "" for node in body.iter("{%s}t" % A_NS))
    paragraphs = body.findall("{%s}p" % A_NS)
    if not paragraphs:
        fail("这个元素没有段落")
    first = paragraphs[0]
    runs = first.findall("{%s}r" % A_NS)
    if runs:
        node = runs[0].find("{%s}t" % A_NS)
        if node is None:
            node = etree.SubElement(runs[0], "{%s}t" % A_NS)
        node.text = value
        for run in runs[1:]:
            first.remove(run)
    else:
        run = etree.SubElement(first, "{%s}r" % A_NS)
        etree.SubElement(run, "{%s}t" % A_NS).text = value
    for paragraph in paragraphs[1:]:
        body.remove(paragraph)
    presentation.save(path)
    return before


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        fail("请求无法解析")
    relative = str(request.get("path") or "")
    if not relative or relative.startswith("/") or ".." in relative.split("/"):
        fail("路径无效")
    target = request.get("target") or {}
    value = str(request.get("value") or "")[:4000]
    path = os.path.join(os.environ.get("IRIS_OFFICE_ROOT", "/workspace"), relative)
    if not os.path.isfile(path):
        fail("文件不存在")
    kind = str(target.get("kind") or "")
    try:
        if kind == "docx":
            before = edit_docx(path, target, value)
        elif kind == "xlsx":
            before = edit_xlsx(path, target, value)
        elif kind == "pptx":
            before = edit_pptx(path, target, value)
        else:
            fail("不支持的元素类型")
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - report the parser's reason to the reader
        fail("无法写入：%s" % error)
    print(json.dumps({"ok": True, "before": before, "after": value}, ensure_ascii=False))


main()
