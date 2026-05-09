import { Injectable, signal } from '@angular/core';
import { ChartData } from '../components/chart/chart';

export interface PinnedChart {
  id: string;
  chart: ChartData;
  query: string;
  pinnedAt: number;
}

const STORAGE_KEY = 'pinnedCharts';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  readonly pinnedCharts = signal<PinnedChart[]>([]);

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.pinnedCharts.set(JSON.parse(raw));
      }
    } catch {
      this.pinnedCharts.set([]);
    }
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pinnedCharts()));
  }

  pin(chart: ChartData, query: string): string {
    const id = crypto.randomUUID();
    const item: PinnedChart = { id, chart, query, pinnedAt: Date.now() };
    this.pinnedCharts.update(charts => [...charts, item]);
    this.save();
    return id;
  }

  unpin(id: string): void {
    this.pinnedCharts.update(charts => charts.filter(c => c.id !== id));
    this.save();
  }

  clear(): void {
    this.pinnedCharts.set([]);
    this.save();
  }
}