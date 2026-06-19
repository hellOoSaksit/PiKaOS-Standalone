"""Export mapping rows as an .xlsx that matches the central checklist template.

Mirrors `Ref/http_redirect_checklist_5_sites_by_symbol.xlsx` so the export drops straight back
into the team's workflow: three sheets (Redirect Checklist · Symbol Setup · Summary), the same
title rows, the same 7-column header, and the same status dropdown. The tool's 4 statuses are
mapped onto the template's dropdown vocabulary so every exported cell stays valid in Excel.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from ..schemas import FilesOut, MappingRow

# tool status → template "ดำเนินการหรือยัง" dropdown value (so the cell is valid in Excel's list)
_STATUS_EXPORT = {
    "รอดำเนินการ": "ยังไม่ดำเนินการ",
    "ดำเนินการแล้ว": "ดำเนินการแล้ว",
    "ติดปัญหา": "ติดปัญหา",
    "ไม่ต้อง Redirect": "ไม่ต้องทำ",
}
# the exact dropdown list from the template (sheet1 E5:E154 data validation)
_DROPDOWN = '"ยังไม่ดำเนินการ,กำลังดำเนินการ,ดำเนินการแล้ว,รอตรวจสอบ,ติดปัญหา,ไม่ต้องทำ"'

_TITLE = "HTTP Redirect Checklist สำหรับเทียบ URL เดิม/ใหม่ และติดตามการทำ Redirect"
_SUBTITLE = "ใช้สำหรับ checklist งาน redirect 5 เว็บไซต์ตาม Symbol: กรอก URL เดิม, URL ใหม่, สถานะ, และ note ของแต่ละรายการ"
_HEADERS = ["No.", "Symbol", "URL เว็บไซต์เดิม", "URL เว็บไซต์ใหม่", "ดำเนินการหรือยัง", "วันที่ดำเนินการ", "Note"]

# styles
_TITLE_FONT = Font(bold=True, size=14)
_SUB_FONT = Font(size=10, italic=True, color="666666")
_HEAD_FONT = Font(bold=True, color="FFFFFF")
_HEAD_FILL = PatternFill("solid", fgColor="4F46E5")
_CENTER = Alignment(horizontal="center", vertical="center")
_WRAP = Alignment(vertical="top", wrap_text=True)
_THIN = Side(style="thin", color="D0D0D0")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _style_header(ws, row: int, ncols: int) -> None:
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = _HEAD_FONT
        cell.fill = _HEAD_FILL
        cell.alignment = _CENTER
        cell.border = _BORDER


def _sheet_checklist(ws, rows: list[MappingRow]) -> None:
    ws.title = "Redirect Checklist"
    ws.merge_cells("A1:G1")
    ws["A1"] = _TITLE
    ws["A1"].font = _TITLE_FONT
    ws.merge_cells("A2:G2")
    ws["A2"] = _SUBTITLE
    ws["A2"].font = _SUB_FONT
    # row 3 blank, row 4 header
    for col, head in enumerate(_HEADERS, 1):
        ws.cell(row=4, column=col, value=head)
    _style_header(ws, 4, len(_HEADERS))

    for i, r in enumerate(rows):
        row = 5 + i
        ws.cell(row=row, column=1, value=i + 1).alignment = _CENTER
        ws.cell(row=row, column=2, value=r.symbol)
        ws.cell(row=row, column=3, value=r.oldUrl)
        ws.cell(row=row, column=4, value=r.newUrl)
        ws.cell(row=row, column=5, value=_STATUS_EXPORT.get(r.status, r.status or ""))
        ws.cell(row=row, column=6, value="")  # วันที่ดำเนินการ — filled by hand when actually done
        ws.cell(row=row, column=7, value=r.note).alignment = _WRAP

    # status dropdown over a generous range (matches the template's E5:E154; extend if more rows)
    last = max(154, 4 + len(rows))
    dv = DataValidation(type="list", formula1=_DROPDOWN, allow_blank=True)
    ws.add_data_validation(dv)
    dv.add(f"E5:E{last}")

    widths = [6, 16, 46, 46, 18, 16, 34]
    for c, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A5"


def _sheet_symbol_setup(ws, rows: list[MappingRow]) -> None:
    ws.title = "Symbol Setup"
    ws.merge_cells("A1:E1")
    ws["A1"] = "ตั้งค่า Symbol สำหรับเว็บไซต์"
    ws["A1"].font = _TITLE_FONT
    ws.merge_cells("A2:E2")
    ws["A2"] = "Symbol จริงของแต่ละเว็บไซต์ — ใช้ Symbol เดียวกันในหน้า Redirect Checklist"
    ws["A2"].font = _SUB_FONT
    heads = ["Symbol", "ชื่อเว็บไซต์/บริษัท", "URL หลักเว็บไซต์เดิม", "URL หลักเว็บไซต์ใหม่", "Note"]
    for col, head in enumerate(heads, 1):
        ws.cell(row=4, column=col, value=head)
    _style_header(ws, 4, len(heads))

    # one row per distinct symbol (in first-seen order); main old/new = its first mapping row
    seen: dict[str, MappingRow] = {}
    for r in rows:
        key = r.symbol.strip() or "(no symbol)"
        if key not in seen:
            seen[key] = r
    for i, (sym, r) in enumerate(seen.items()):
        row = 5 + i
        ws.cell(row=row, column=1, value=sym)
        ws.cell(row=row, column=3, value=_origin_of(r.oldUrl))
        ws.cell(row=row, column=4, value=_origin_of(r.newUrl))

    for c, w in enumerate([16, 24, 40, 40, 30], 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A5"


def _sheet_summary(ws, rows: list[MappingRow], as_of: str) -> None:
    ws.title = "Summary"
    ws.merge_cells("A1:H1")
    ws["A1"] = "สรุปสถานะ HTTP Redirect Checklist"
    ws["A1"].font = _TITLE_FONT
    ws.merge_cells("A2:H2")
    ws["A2"] = f"สร้างเมื่อ {as_of} — ติดตามจำนวน URL ที่ต้อง redirect แยกตาม Symbol"
    ws["A2"].font = _SUB_FONT

    total = len(rows)
    done = sum(1 for r in rows if r.status == "ดำเนินการแล้ว")
    problem = sum(1 for r in rows if r.status == "ติดปัญหา")
    remaining = total - done
    pct = round(done / total * 100, 1) if total else 0

    ws.merge_cells("A4:H4")
    ws["A4"] = "ภาพรวม"
    ws["A4"].font = Font(bold=True)
    over_head = ["รายการทั้งหมด", "ดำเนินการแล้ว", "คงเหลือ", "ติดปัญหา", "% สำเร็จ"]
    for col, head in enumerate(over_head, 1):
        ws.cell(row=5, column=col, value=head)
    _style_header(ws, 5, len(over_head))
    for col, val in enumerate([total, done, remaining, problem, pct], 1):
        ws.cell(row=6, column=col, value=val).alignment = _CENTER

    # per-symbol breakdown
    per_head = ["Symbol", "ชื่อเว็บไซต์/บริษัท", "URL เดิมหลัก", "URL ใหม่หลัก", "รายการทั้งหมด", "ดำเนินการแล้ว", "คงเหลือ", "ติดปัญหา"]
    for col, head in enumerate(per_head, 1):
        ws.cell(row=9, column=col, value=head)
    _style_header(ws, 9, len(per_head))

    order: list[str] = []
    by_sym: dict[str, list[MappingRow]] = {}
    for r in rows:
        key = r.symbol.strip() or "(no symbol)"
        if key not in by_sym:
            by_sym[key] = []
            order.append(key)
        by_sym[key].append(r)
    for i, sym in enumerate(order):
        grp = by_sym[sym]
        s_total = len(grp)
        s_done = sum(1 for r in grp if r.status == "ดำเนินการแล้ว")
        s_problem = sum(1 for r in grp if r.status == "ติดปัญหา")
        row = 10 + i
        ws.cell(row=row, column=1, value=sym)
        ws.cell(row=row, column=3, value=_origin_of(grp[0].oldUrl))
        ws.cell(row=row, column=4, value=_origin_of(grp[0].newUrl))
        ws.cell(row=row, column=5, value=s_total).alignment = _CENTER
        ws.cell(row=row, column=6, value=s_done).alignment = _CENTER
        ws.cell(row=row, column=7, value=s_total - s_done).alignment = _CENTER
        ws.cell(row=row, column=8, value=s_problem).alignment = _CENTER

    for c, w in enumerate([16, 22, 36, 36, 14, 14, 12, 12], 1):
        ws.column_dimensions[get_column_letter(c)].width = w


def _origin_of(url: str) -> str:
    """Scheme://host of a URL (the 'main' URL for a symbol), empty string if not a URL."""
    from urllib.parse import urlsplit
    p = urlsplit((url or "").strip())
    return f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else (url or "")


def _sheet_files(ws, files: FilesOut) -> None:
    ws.title = "Files"
    ws.merge_cells("A1:D1")
    ws["A1"] = "เทียบไฟล์ดาวน์โหลด (เว็บเดิม vs เว็บใหม่)"
    ws["A1"].font = _TITLE_FONT
    ws.merge_cells("A2:D2")
    ws["A2"] = (f"เว็บเดิม {files.oldCount} ไฟล์ ({files.oldPages} หน้า) · เว็บใหม่ {files.newCount} ไฟล์ "
                f"({files.newPages} หน้า) · เหมือนกัน {len(files.matched)} · เฉพาะเดิม {len(files.onlyOld)} "
                f"· เฉพาะใหม่ {len(files.onlyNew)}")
    ws["A2"].font = _SUB_FONT
    heads = ["ชื่อไฟล์", "สถานะ", "URL เดิม", "URL ใหม่"]
    for col, head in enumerate(heads, 1):
        ws.cell(row=4, column=col, value=head)
    _style_header(ws, 4, len(heads))

    row = 5
    for it in files.matched:
        ws.cell(row=row, column=1, value=it.name)
        ws.cell(row=row, column=2, value="มีทั้ง 2 เว็บ")
        ws.cell(row=row, column=3, value=it.oldUrl)
        ws.cell(row=row, column=4, value=it.newUrl)
        row += 1
    for it in files.onlyOld:
        ws.cell(row=row, column=1, value=it.name)
        ws.cell(row=row, column=2, value="เฉพาะเว็บเดิม (หาย)")
        ws.cell(row=row, column=3, value=it.oldUrl)
        row += 1
    for it in files.onlyNew:
        ws.cell(row=row, column=1, value=it.name)
        ws.cell(row=row, column=2, value="เฉพาะเว็บใหม่ (เพิ่ม)")
        ws.cell(row=row, column=4, value=it.newUrl)
        row += 1

    for c, w in enumerate([42, 20, 50, 50], 1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A5"


def build(rows: list[MappingRow], files: FilesOut | None = None) -> bytes:
    as_of = datetime.now(timezone.utc).date().isoformat()
    wb = Workbook()
    _sheet_checklist(wb.active, rows)
    _sheet_symbol_setup(wb.create_sheet(), rows)
    _sheet_summary(wb.create_sheet(), rows, as_of)
    if files is not None:
        _sheet_files(wb.create_sheet(), files)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
