import { Component, signal, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ExcelParserService, UploadedFile } from './services/excel-parser';
import { ClaudeService, ChatMessage, ClaudeResponse } from './services/claude';
import { ChartComponent, ChartData } from './components/chart/chart';
import { TableComponent } from './components/table/table';
import { TableData } from './services/claude';
import { DashboardService } from './services/dashboard';
import { DashboardComponent } from './components/dashboard/dashboard';

interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
  loading?: boolean;
  chart?: ChartData;
  table?: TableData;
  cacheStats?: { cacheRead: number; cacheWritten: number };
  query?: string;
  pinnedId?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, ChartComponent, TableComponent, DashboardComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class AppComponent {
  readonly files = signal<UploadedFile[]>([]);
  readonly messages = signal<DisplayMessage[]>([]);
  readonly userInput = signal('');
  readonly isLoading = signal(false);
  readonly currentView = signal<'chat' | 'dashboard'>('chat');

  readonly dashboard = inject(DashboardService);
  readonly hasFiles = computed(() => this.files().length > 0);
  readonly pinnedCount = computed(() => this.dashboard.pinnedCharts().length);

  readonly suggestedQuestions = [
    'Show offices by region',
    'Top 5 cities by RSF',
    'Budget distribution by Cost Code',
    'Which leases expire in 2026?'
  ];

  private chatHistory: ChatMessage[] = [];

  constructor(
    private excelParser: ExcelParserService,
    private claude: ClaudeService
  ) {}

  togglePin(msg: DisplayMessage): void {
    if (!msg.chart || !msg.query) return;

    if (msg.pinnedId) {
      this.dashboard.unpin(msg.pinnedId);
      this.messages.update(msgs =>
        msgs.map(m => m === msg ? { ...m, pinnedId: undefined } : m)
      );
    } else {
      const id = this.dashboard.pin(msg.chart, msg.query);
      this.messages.update(msgs =>
        msgs.map(m => m === msg ? { ...m, pinnedId: id } : m)
      );
    }
  }

  async onFileUpload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0) return;

    const newFiles: UploadedFile[] = [];

    for (const file of Array.from(fileList)) {
      try {
        const sheets = await this.excelParser.parseFile(file);
        newFiles.push({ name: file.name, sheets });
      } catch (e) {
        this.messages.update(msgs => [...msgs, {
          role: 'assistant',
          text: `❌ Error reading "${file.name}": ${e}`
        }]);
      }
    }

    if (newFiles.length === 0) return;

    this.files.update(current => [...current, ...newFiles]);
    this.refreshContext();

    const summary = newFiles.map(f =>
      `${f.name} (${f.sheets.length} sheet(s), ${f.sheets.reduce((sum, s) => sum + s.rows.length, 0)} rows)`
    ).join(', ');

    this.messages.update(msgs => [...msgs, {
      role: 'assistant',
      text: `✅ Added: ${summary}\n\nTotal files: ${this.files().length}. You can ask questions about any file or compare data across them.`
    }]);

    input.value = '';
  }

  removeFile(index: number): void {
    this.files.update(current => current.filter((_, i) => i !== index));
    this.refreshContext();
    if (this.files().length === 0) {
      this.messages.set([]);
      this.chatHistory = [];
    }
  }

  clearAll(): void {
    this.files.set([]);
    this.messages.set([]);
    this.chatHistory = [];
  }

  private refreshContext(): void {
    if (this.files().length === 0) {
      this.chatHistory = [];
      return;
    }
    const context = this.excelParser.filesToContext(this.files());
    this.claude.setDataContext(context);
  }

  async sendMessage(): Promise<void> {
    const text = this.userInput().trim();
    if (!text || this.isLoading() || !this.hasFiles()) return;

    this.userInput.set('');
    const loadingMsg: DisplayMessage = { role: 'assistant', text: '', loading: true };
    this.messages.update(msgs => [...msgs, { role: 'user', text }, loadingMsg]);
    this.chatHistory = [...this.chatHistory, { role: 'user', content: text }];
    this.isLoading.set(true);

    await this.claude.chatStream(this.chatHistory, {
      onText: () => { /* поки не використовуємо */ },

      onDone: (result: ClaudeResponse) => {
        this.messages.update(msgs =>
          msgs.map(m => m === loadingMsg
            ? {
                role: 'assistant' as const,
                text: result.answer,
                chart: result.chart,
                table: result.table,
                cacheStats: result.cacheStats,
                query: text,
                loading: false
              }
            : m
          )
        );
        this.chatHistory = [...this.chatHistory, { role: 'assistant', content: result.answer }];
        this.isLoading.set(false);
      },

      onError: (error: string) => {
        this.messages.update(msgs =>
          msgs.map(m => m === loadingMsg
            ? { role: 'assistant' as const, text: `❌ ${error}`, loading: false }
            : m
          )
        );
        this.isLoading.set(false);
      }
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  selectSuggestion(question: string): void {
    this.userInput.set(question);
    this.sendMessage();
  }
}