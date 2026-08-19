// CSV/Excel export helpers for report tables (RFP ANL-09: PDF/Excel/PowerPoint/CSV export).
// PDF is already covered by the printable report view; PowerPoint is not implemented.
import type { Response } from 'express';
import ExcelJS from 'exceljs';

export type ExportCell = string | number | null;

function csvEscape(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Streams a UTF-8 CSV (with BOM, so Arabic text opens correctly in Excel) to the response. */
export function sendCsv(res: Response, filename: string, headers: string[], rows: ExportCell[][]): void {
  const lines = [headers.map(csvEscape).join(','), ...rows.map((row) => row.map(csvEscape).join(','))];
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(csv);
}

/** Streams a single-sheet .xlsx workbook to the response. */
export async function sendXlsx(res: Response, filename: string, sheetName: string, headers: string[], rows: ExportCell[][]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(14, header.length + 2) }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}
