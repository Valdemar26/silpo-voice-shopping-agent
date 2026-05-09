import { Component, input } from '@angular/core';
import { TableData } from '../../services/claude';

@Component({
  selector: 'app-table',
  standalone: true,
  template: `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            @for (col of data().columns; track $index) {
              <th>{{ col }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of data().rows; track $index) {
            <tr>
              @for (cell of row; track $index) {
                <td>{{ cell }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .table-wrapper {
      margin: 12px 0;
      overflow-x: auto;
      border-radius: 10px;
      border: 1px solid #dde1e7;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      background: #f0f2f5;
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      color: #1a1d23;
      border-bottom: 1px solid #dde1e7;
    }
    td {
      padding: 9px 14px;
      border-bottom: 1px solid #f0f2f5;
      color: #374151;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8f9fb; }
  `]
})
export class TableComponent {
  readonly data = input.required<TableData>();
}
