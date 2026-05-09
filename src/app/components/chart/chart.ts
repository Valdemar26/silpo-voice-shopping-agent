import { Component, input, OnChanges, OnDestroy, ElementRef, viewChild } from '@angular/core';
import { Chart, ChartConfiguration, registerables } from 'chart.js';

Chart.register(...registerables);

export interface ChartData {
  type: 'bar' | 'doughnut' | 'pie' | 'line';
  title: string;
  labels: string[];
  datasets: { label: string; data: number[] }[];
}

@Component({
  selector: 'app-chart',
  standalone: true,
  template: `
    <div class="chart-wrapper">
      <canvas #canvas></canvas>
    </div>
  `,
  styles: [`
    .chart-wrapper {
      max-width: 480px;
      margin: 12px 0;
      padding: 16px;
      background: #f8f9fb;
      border-radius: 10px;
      border: 1px solid #dde1e7;
    }
  `]
})
export class ChartComponent implements OnChanges, OnDestroy {
  readonly data = input.required<ChartData>();
  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private chartInstance: Chart | null = null;

  ngOnChanges(): void {
    this.renderChart();
  }

  ngOnDestroy(): void {
    this.chartInstance?.destroy();
  }

  private renderChart(): void {
    this.chartInstance?.destroy();

    const d = this.data();
    const config: ChartConfiguration = {
      type: d.type,
      data: {
        labels: d.labels,
        datasets: d.datasets.map((ds, i) => ({
          label: ds.label,
          data: ds.data,
          backgroundColor: this.getColors(ds.data.length),
          borderColor: d.type === 'line' ? this.getColors(1)[0] : undefined,
          borderWidth: 1
        }))
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' },
          title: { display: true, text: d.title }
        }
      }
    };

    this.chartInstance = new Chart(this.canvas().nativeElement, config);
  }

  private getColors(count: number): string[] {
    const palette = [
      '#4f46e5','#06b6d4','#10b981','#f59e0b',
      '#ef4444','#8b5cf6','#ec4899','#14b8a6'
    ];
    return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
  }
}