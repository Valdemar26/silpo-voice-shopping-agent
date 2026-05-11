import { Component, inject } from '@angular/core';
import { DashboardService } from '../../services/dashboard';
import { ChartComponent } from '../chart/chart';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ChartComponent],
  template: `
    <div class="dashboard">
      @if (dashboard.pinnedCharts().length === 0) {
        <div class="empty">
          <div class="empty-icon">📌</div>
          <h2>No pinned charts yet</h2>
          <p>Ask questions in the Chat and pin the charts you find useful — they'll appear here.</p>
        </div>
      } @else {
        <div class="dashboard-header">
          <span class="count">{{ dashboard.pinnedCharts().length }} chart(s) pinned</span>
          <button class="clear-btn" (click)="onClearAll()">Clear all</button>
        </div>
        <div class="grid">
          @for (item of dashboard.pinnedCharts(); track item.id) {
            <div class="card">
              <div class="card-header">
                <div class="query">"{{ item.query }}"</div>
                <button class="unpin" (click)="dashboard.unpin(item.id)" title="Remove">✕</button>
              </div>
              <app-chart [data]="item.chart" />
              <div class="card-footer">
                {{ formatDate(item.pinnedAt) }}
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .dashboard {
      flex: 1;
      padding: 24px 16px;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
    }

    .empty {
      text-align: center;
      padding: 80px 20px;
      color: #6b7280;

      .empty-icon { font-size: 48px; margin-bottom: 16px; }
      h2 { color: #1a1d23; margin-bottom: 8px; font-size: 20px; font-weight: 600; }
      p { font-size: 14px; max-width: 400px; margin: 0 auto; }
    }

    .dashboard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;

      .count { color: #6b7280; font-size: 14px; }
      .clear-btn {
        background: transparent;
        border: 1px solid #dde1e7;
        color: #6b7280;
        padding: 6px 12px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
        &:hover { border-color: #ef4444; color: #ef4444; }
      }
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 16px;
    }

    .card {
      background: #fff;
      border: 1px solid #dde1e7;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      transition: box-shadow 0.2s;
      &:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid #f0f2f5;

      .query {
        font-size: 13px;
        color: #374151;
        line-height: 1.5;
        flex: 1;
        font-style: italic;
      }

      .unpin {
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
        &:hover { background: #fee2e2; color: #ef4444; }
      }
    }

    .card-footer {
      padding: 8px 16px;
      font-size: 11px;
      color: #9ca3af;
      background: #f8f9fb;
      border-top: 1px solid #f0f2f5;
    }
  `]
})
export class DashboardComponent {
  readonly dashboard = inject(DashboardService);

  formatDate(ts: number): string {
    return new Date(ts).toLocaleString('en-US', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  onClearAll(): void {
    if (confirm('Remove all pinned charts?')) {
      this.dashboard.clear();
    }
  }
}