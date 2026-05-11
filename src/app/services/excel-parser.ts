import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, any>[];
}

export type FileType = 'excel' | 'pdf';

export interface UploadedFile {
  name: string;
  type: FileType;
  sheets?: ParsedSheet[];   // for Excel
  base64?: string;          // for PDF
}

@Injectable({ providedIn: 'root' })
export class ExcelParserService {

  async parseFile(file: File): Promise<UploadedFile> {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const base64 = await this.fileToBase64(file);
      return { name: file.name, type: 'pdf', base64 };
    }

    const sheets = await this.parseExcel(file);
    return { name: file.name, type: 'excel', sheets };
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        resolve(dataUrl.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private parseExcel(file: File): Promise<ParsedSheet[]> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const data = e.target?.result as ArrayBuffer;
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheets: ParsedSheet[] = [];

          for (const sheetName of workbook.SheetNames) {
            if (sheetName === 'Comments') continue;
            const ws = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, any>[];
            if (json.length === 0) continue;

            sheets.push({
              name: sheetName,
              headers: Object.keys(json[0]),
              rows: json
            });
          }
          resolve(sheets);
        } catch (err) {
          reject(err);
        }
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  filesToContext(files: UploadedFile[]): string {
    const excelFiles = files.filter(f => f.type === 'excel' && f.sheets);

    if (excelFiles.length === 0) return '';

    return excelFiles.map(file => {
      const sheetsContext = file.sheets!.map(sheet => {
        const preview = sheet.rows.slice(0, 120);
        return `## Sheet: "${sheet.name}"\nColumns: ${sheet.headers.join(', ')}\nTotal rows: ${sheet.rows.length}\n\nData (JSON):\n${JSON.stringify(preview, null, 2)}`;
      }).join('\n\n');

      return `=== FILE: ${file.name} ===\n\n${sheetsContext}`;
    }).join('\n\n---\n\n');
  }
}
