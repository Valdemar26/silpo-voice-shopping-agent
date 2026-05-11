import { Component, signal, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ExcelParserService, UploadedFile } from './services/excel-parser';
import { ClaudeService, ChatMessage, ClaudeResponse, CacheStats } from './services/claude';
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
  cacheStats?: CacheStats;
  query?: string;
  pinnedId?: string;
  error?: boolean;
  errorMessage?: string;
  originalQuery?: string;
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
  readonly sessionCost = signal(0);

  private chatHistory: ChatMessage[] = [];
  private abortController?: AbortController;

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
        const uploadedFile = await this.excelParser.parseFile(file);
        newFiles.push(uploadedFile);
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

    const summary = newFiles.map(f => {
      if (f.type === 'pdf') {
        return `${f.name} (PDF)`;
      }
      const rowCount = f.sheets!.reduce((sum, s) => sum + s.rows.length, 0);
      return `${f.name} (${f.sheets!.length} sheet(s), ${rowCount} rows)`;
    }).join(', ');

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
    this.sessionCost.set(0);
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

    const newHistory: ChatMessage[] = [...this.chatHistory, { role: 'user', content: text }];
    this.isLoading.set(true);
    this.abortController = new AbortController();

    const pdfs = this.files().filter(f => f.type === 'pdf');

    await this.claude.chatStream(newHistory, pdfs, {
      onText: () => {},

      onDone: (result: ClaudeResponse) => {
        this.chatHistory = [...newHistory, { role: 'assistant', content: result.answer }];

        this.messages.update(msgs =>
          msgs.map(m => m === loadingMsg ? {
            role: 'assistant' as const,
            text: result.answer,
            chart: result.chart,
            table: result.table,
            cacheStats: result.cacheStats,
            query: text,
            loading: false
          } : m)
        );

        if (result.cacheStats) {
          this.addToSessionCost(result.cacheStats);
        }

        this.isLoading.set(false);
      },

      onError: (error: string) => {
        this.messages.update(msgs =>
          msgs.map(m => m === loadingMsg ? {
            role: 'assistant' as const,
            text: '',
            error: true,
            errorMessage: error,
            originalQuery: text,
            loading: false
          } : m)
        );
        this.isLoading.set(false);
      }
    }, this.abortController.signal);
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

  private addToSessionCost(usage: CacheStats): void {
    // Sonnet 4-6 pricing per million tokens
    const cost =
      (usage.inputTokens * 3 +
      usage.cacheWritten * 3.75 +
      usage.cacheRead * 0.30 +
      usage.outputTokens * 15) / 1_000_000;
    this.sessionCost.update(c => c + cost);
  }

  stopGeneration(): void {
    this.abortController?.abort();
  }

  retryMessage(msg: DisplayMessage): void {
    if (!msg.originalQuery) return;

    this.messages.update(msgs => {
      const errorIdx = msgs.indexOf(msg);
      if (errorIdx === -1) return msgs;
      return msgs.filter((_, i) => i !== errorIdx && i !== errorIdx - 1);
    });

    this.userInput.set(msg.originalQuery);
    this.sendMessage();
  }
}