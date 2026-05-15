import {
  App,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath,
} from "obsidian";

type JobMode =
  | "generate"
  | "transcribe"
  | "transcribe-diarize"
  | "transcribe-summary"
  | "transcribe-summary-diarize"
  | "summary"
  | "markdown-summary";
type ProgressStatus = "pending" | "running" | "done" | "error";
type TitleDateSource = "recording" | "today";

interface MeetingNotesSettings {
  apiKey: string;
  transcriptionModel: string;
  diarize: boolean;
  generateSummary: boolean;
  summaryModel: string;
  availableSummaryModels: string[];
  progressUpdateIntervalSeconds: number;
  includeSectionSummary: boolean;
  includeSectionDiscussedItems: boolean;
  includeSectionDecisions: boolean;
  includeSectionNextSteps: boolean;
  includeSectionTodo: boolean;
  summarySectionSummaryName: string;
  summarySectionDiscussedItemsName: string;
  summarySectionDecisionsName: string;
  summarySectionNextStepsName: string;
  summarySectionTodoName: string;
  splitTranscriptForSummary: boolean;
  outputFolder: string;
  saveWithRecording: boolean;
  noteTitleTemplate: string;
  titleDateFormat: string;
  titleDateSource: TitleDateSource;
  deleteRecordingAfterSuccess: boolean;
  transcriptionPrompt: string;
  summaryInstructions: string;
  showGenerateMeetingNotes: boolean;
  showTranscribe: boolean;
  showTranscribeDiarize: boolean;
  showTranscribeSummary: boolean;
  showTranscribeSummaryDiarize: boolean;
  showSummary: boolean;
  showSummarizeMarkdown: boolean;
}

interface ProgressItem {
  label: string;
  status: ProgressStatus;
  detail?: string;
}

interface TranscriptChunk {
  label: string;
  markdown: string;
  text: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  audioInputTokens: number;
  textInputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  durationSeconds: number;
  costUsd?: number;
  costUnavailable: boolean;
}

interface TokenPrices {
  input: number;
  cachedInput?: number;
  output: number;
}

type UsageKind = "transcription" | "summary";

interface JobState {
  title: string;
  sourcePath: string;
  mode: JobMode;
  status: "in_progress" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  transcriptionModel: string;
  summaryModel: string;
  diarize: boolean;
  includeSummary: boolean;
  includeTranscript: boolean;
  chunksTotal: number;
  chunksDone: number;
  progress: ProgressItem[];
  transcriptChunks: TranscriptChunk[];
  transcriptionUsage: UsageTotals;
  summaryUsage: UsageTotals;
  summary?: string;
  error?: string;
}

interface AudioChunkPlan {
  index: number;
  total: number;
  startSeconds: number;
  endSeconds: number;
}

interface AudioChunkPayload {
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
  offsetSeconds: number;
}

interface DiarizedSegment {
  speaker?: string;
  start?: number;
  end?: number;
  text?: string;
}

interface TranscriptionResult {
  markdown: string;
  text: string;
  usage: UsageTotals;
}

interface SummaryResult {
  text: string;
  usage: UsageTotals;
}

interface JobOptions {
  mode: JobMode;
  title: string;
  icon: string;
  diarize: boolean;
  includeSummary: boolean;
  includeTranscript: boolean;
  transcriptionModel: string;
  titleTemplate: string;
}

const DEFAULT_SETTINGS: MeetingNotesSettings = {
  apiKey: "",
  transcriptionModel: "gpt-4o-mini-transcribe",
  diarize: false,
  generateSummary: true,
  summaryModel: "gpt-5.5",
  availableSummaryModels: [],
  progressUpdateIntervalSeconds: 5,
  includeSectionSummary: true,
  includeSectionDiscussedItems: true,
  includeSectionDecisions: true,
  includeSectionNextSteps: true,
  includeSectionTodo: true,
  summarySectionSummaryName: "Summary",
  summarySectionDiscussedItemsName: "What was discussed",
  summarySectionDecisionsName: "Decisions made",
  summarySectionNextStepsName: "Next steps",
  summarySectionTodoName: "Task to do",
  splitTranscriptForSummary: false,
  outputFolder: "Meeting Notes",
  saveWithRecording: false,
  noteTitleTemplate: "{{date}}",
  titleDateFormat: "YYYY-MM-DD",
  titleDateSource: "recording",
  deleteRecordingAfterSuccess: false,
  transcriptionPrompt: "",
  summaryInstructions: "",
  showGenerateMeetingNotes: true,
  showTranscribe: true,
  showTranscribeDiarize: true,
  showTranscribeSummary: true,
  showTranscribeSummaryDiarize: true,
  showSummary: true,
  showSummarizeMarkdown: true,
};

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "wav",
  "webm",
]);

const MAX_DIRECT_UPLOAD_BYTES = 24 * 1024 * 1024;
const TARGET_CHUNK_UPLOAD_BYTES = 22 * 1024 * 1024;
const CHUNK_SAMPLE_RATE = 16000;
const CHUNK_BYTES_PER_SECOND = CHUNK_SAMPLE_RATE * 2;
const LEGACY_DEFAULT_TITLE_TEMPLATE = "{{file}} transcript {{date}}";
const LEGACY_DEFAULT_SUMMARY_INSTRUCTIONS =
  "Create concise meeting notes with: overview, decisions, action items, unresolved questions, and important details. Preserve names, dates, numbers, and terminology from the transcript.";
const DEFAULT_SUMMARY_MODEL_OPTIONS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
];
const TEXT_MODEL_PRICES_PER_1M: Record<string, TokenPrices> = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
};
const TRANSCRIPTION_TOKEN_PRICES_PER_1M: Record<string, TokenPrices> = {
  "gpt-4o-transcribe-diarize": { input: 2.5, output: 10 },
  "gpt-4o-transcribe": { input: 2.5, output: 10 },
  "gpt-4o-mini-transcribe": { input: 1.25, output: 5 },
};
const TRANSCRIPTION_DURATION_PRICE_PER_MINUTE = 0.006;

export default class MeetingNotesPlugin extends Plugin {
  settings: MeetingNotesSettings;

  async onload() {
    await this.loadSettings();

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addFileMenuItems(menu, file);
      })
    );

    this.addSettingTab(new MeetingNotesSettingTab(this.app, this));
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<MeetingNotesSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (this.settings.summaryInstructions.trim() === LEGACY_DEFAULT_SUMMARY_INSTRUCTIONS) {
      this.settings.summaryInstructions = "";
    }
    if (!loaded?.noteTitleTemplate || loaded.noteTitleTemplate === LEGACY_DEFAULT_TITLE_TEMPLATE) {
      this.settings.noteTitleTemplate = DEFAULT_SETTINGS.noteTitleTemplate;
    }
    if (this.settings.titleDateSource !== "recording" && this.settings.titleDateSource !== "today") {
      this.settings.titleDateSource = DEFAULT_SETTINGS.titleDateSource;
    }
    this.settings.summaryModel = normalizeSummaryModel(this.settings.summaryModel);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshAvailableSummaryModels(): Promise<number> {
    if (!this.settings.apiKey.trim()) {
      throw new Error("Add your OpenAI API key before refreshing models.");
    }

    const response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
      },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(readOpenAiError(response.text, `OpenAI model list request failed with HTTP ${response.status}`));
    }

    const models = readModelIds(response.json).filter(isLikelySummaryModel).sort((left, right) => left.localeCompare(right));
    if (models.length === 0) {
      throw new Error("OpenAI returned no text-capable model IDs.");
    }

    this.settings.availableSummaryModels = models;
    await this.saveSettings();
    return models.length;
  }

  private addFileMenuItems(menu: Menu, file: TAbstractFile) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (this.isSupportedAudioFile(file)) {
      this.addAudioFileMenuItems(menu, file);
      return;
    }

    if (file.extension.toLowerCase() === "md" && this.settings.showSummarizeMarkdown) {
      menu.addItem((item) => {
        item
          .setTitle("Summarize note")
          .setIcon("list-checks")
          .onClick(() => {
            void this.startMarkdownSummaryJob(file);
          });
      });
    }
  }

  private addAudioFileMenuItems(menu: Menu, file: TFile) {
    for (const action of this.getVisibleActions()) {
      menu.addItem((item) => {
        item
          .setTitle(action.title)
          .setIcon(action.icon)
          .onClick(() => {
            void this.startJob(file, action);
          });
      });
    }
  }

  private isSupportedAudioFile(file: TFile): boolean {
    return AUDIO_EXTENSIONS.has(file.extension.toLowerCase());
  }

  private getVisibleActions(): JobOptions[] {
    const actions: JobOptions[] = [
      {
        mode: "generate",
        title: "Generate meeting notes",
        icon: "file-text",
        diarize: this.settings.diarize,
        includeSummary: this.settings.generateSummary,
        includeTranscript: true,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
      {
        mode: "transcribe",
        title: "Transcribe",
        icon: "mic",
        diarize: false,
        includeSummary: false,
        includeTranscript: true,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
      {
        mode: "transcribe-diarize",
        title: "Transcribe (diarize)",
        icon: "mic",
        diarize: true,
        includeSummary: false,
        includeTranscript: true,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
      {
        mode: "transcribe-summary",
        title: "Transcribe and summary",
        icon: "file-text",
        diarize: false,
        includeSummary: true,
        includeTranscript: true,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
      {
        mode: "transcribe-summary-diarize",
        title: "Transcribe and summary (diarize)",
        icon: "file-text",
        diarize: true,
        includeSummary: true,
        includeTranscript: true,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
      {
        mode: "summary",
        title: "Summary",
        icon: "list-checks",
        diarize: this.settings.diarize,
        includeSummary: true,
        includeTranscript: false,
        transcriptionModel: this.settings.transcriptionModel.trim(),
        titleTemplate: this.settings.noteTitleTemplate,
      },
    ];

    return actions.filter((action) => {
      if (action.mode === "generate") return this.settings.showGenerateMeetingNotes;
      if (action.mode === "transcribe") return this.settings.showTranscribe;
      if (action.mode === "transcribe-diarize") return this.settings.showTranscribeDiarize;
      if (action.mode === "transcribe-summary") return this.settings.showTranscribeSummary;
      if (action.mode === "transcribe-summary-diarize") return this.settings.showTranscribeSummaryDiarize;
      return this.settings.showSummary;
    });
  }

  private async startJob(sourceFile: TFile, options: JobOptions) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Meeting Notes: add your OpenAI API key in settings first.");
      return;
    }

    const transcriptionModel = this.effectiveTranscriptionModel(options);
    const title = renderTemplate(
      options.titleTemplate,
      sourceFile,
      options.mode,
      transcriptionModel,
      this.settings.titleDateFormat,
      this.settings.titleDateSource
    );
    const outputPath = await this.getAvailableOutputPath(title, sourceFile);
    const now = new Date().toISOString();
    const state: JobState = {
      title,
      sourcePath: sourceFile.path,
      mode: options.mode,
      status: "in_progress",
      startedAt: now,
      updatedAt: now,
      transcriptionModel,
      summaryModel: normalizeSummaryModel(this.settings.summaryModel),
      diarize: options.diarize,
      includeSummary: options.includeSummary,
      includeTranscript: options.includeTranscript,
      chunksTotal: 0,
      chunksDone: 0,
      progress: [
        { label: "Created note", status: "done", detail: outputPath },
        { label: "Read source recording", status: "pending" },
        { label: "Prepare audio", status: "pending" },
        { label: "Transcribe audio", status: "pending" },
      ],
      transcriptChunks: [],
      transcriptionUsage: createUsageTotals(),
      summaryUsage: createUsageTotals(),
    };

    if (options.includeSummary) {
      state.progress.push({ label: "Summarize transcript", status: "pending" });
    }
    if (this.settings.deleteRecordingAfterSuccess) {
      state.progress.push({ label: "Delete source recording", status: "pending" });
    }

    const outputFile = await this.app.vault.create(outputPath, renderJobNote(state));

    try {
      new Notice("Meeting Notes: transcription started.");
      await this.updateProgress(outputFile, state, "Read source recording", "running");
      const sourceData = await this.app.vault.readBinary(sourceFile);
      await this.updateProgress(outputFile, state, "Read source recording", "done", formatBytes(sourceData.byteLength));

      await this.updateProgress(outputFile, state, "Prepare audio", "running");
      const chunkPlans = await this.withProgressHeartbeat(
        outputFile,
        state,
        "Prepare audio",
        (elapsedSeconds) => `Preparing audio; elapsed ${formatDuration(elapsedSeconds)}`,
        () => this.prepareChunkPlans(sourceFile, sourceData, outputFile, state)
      );
      await this.updateProgress(outputFile, state, "Prepare audio", "done", `${chunkPlans.length} upload${chunkPlans.length === 1 ? "" : "s"}`);

      await this.updateProgress(outputFile, state, "Transcribe audio", "running", "Connecting to OpenAI");
      let priorTranscriptTail = "";

      for (const plan of chunkPlans) {
        await this.setChunkProgress(outputFile, state, plan.index - 1, chunkPlans.length, "running");
        const payload =
          chunkPlans.length === 1 && sourceData.byteLength <= MAX_DIRECT_UPLOAD_BYTES
            ? {
                fileName: sourceFile.name,
                mimeType: inferMimeType(sourceFile.extension),
                data: sourceData,
                offsetSeconds: 0,
              }
            : await this.makeWavChunkPayload(sourceFile, sourceData, plan);

        const result = await this.withProgressHeartbeat(
          outputFile,
          state,
          "Transcribe audio",
          (elapsedSeconds) => buildTranscriptionHeartbeatDetail(plan.index, chunkPlans.length, elapsedSeconds),
          () => this.transcribeChunk(payload, priorTranscriptTail, state)
        );
        addUsageTotals(state.transcriptionUsage, result.usage);
        state.transcriptChunks.push({
          label: chunkPlans.length === 1 ? "Transcript" : `Chunk ${plan.index}`,
          markdown: result.markdown,
          text: result.text,
        });
        priorTranscriptTail = result.text.slice(-1600);
        state.chunksDone = plan.index;
        await this.setChunkProgress(outputFile, state, plan.index, chunkPlans.length, "done");
      }

      await this.updateProgress(outputFile, state, "Transcribe audio", "done", `${state.chunksDone}/${state.chunksTotal} chunks finished`);

      if (options.includeSummary) {
        await this.updateProgress(outputFile, state, "Summarize transcript", "running", `Using ${state.summaryModel}`);
        state.summary = await this.withProgressHeartbeat(
          outputFile,
          state,
          "Summarize transcript",
          (elapsedSeconds) => `Using ${state.summaryModel}; elapsed ${formatDuration(elapsedSeconds)}`,
          () => this.summarizeTranscript(outputFile, state)
        );
        await this.updateProgress(outputFile, state, "Summarize transcript", "done");
      }

      if (this.settings.deleteRecordingAfterSuccess) {
        await this.trashSourceRecording(outputFile, state, sourceFile);
      }

      state.status = "completed";
      state.updatedAt = new Date().toISOString();
      await this.writeState(outputFile, state);
      new Notice("Meeting Notes: note completed.");
    } catch (error) {
      state.status = "failed";
      state.error = getErrorMessage(error);
      state.updatedAt = new Date().toISOString();
      markRunningItemsFailed(state);
      await this.writeState(outputFile, state);
      new Notice(`Meeting Notes failed: ${state.error}`);
    } finally {
      decodedAudioCache.delete(sourceFile.path);
    }
  }

  private effectiveTranscriptionModel(options: Pick<JobOptions, "diarize" | "transcriptionModel">): string {
    return options.diarize ? "gpt-4o-transcribe-diarize" : options.transcriptionModel.trim() || DEFAULT_SETTINGS.transcriptionModel;
  }

  private async startMarkdownSummaryJob(sourceFile: TFile) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Meeting Notes: add your OpenAI API key in settings first.");
      return;
    }

    const summaryModel = normalizeSummaryModel(this.settings.summaryModel);
    const title = renderTemplate(
      this.settings.noteTitleTemplate,
      sourceFile,
      "markdown-summary",
      summaryModel,
      this.settings.titleDateFormat,
      this.settings.titleDateSource
    );
    const outputPath = await this.getAvailableOutputPath(title, sourceFile);
    const now = new Date().toISOString();
    const state: JobState = {
      title,
      sourcePath: sourceFile.path,
      mode: "markdown-summary",
      status: "in_progress",
      startedAt: now,
      updatedAt: now,
      transcriptionModel: "none",
      summaryModel,
      diarize: false,
      includeSummary: true,
      includeTranscript: true,
      chunksTotal: 0,
      chunksDone: 0,
      progress: [
        { label: "Created note", status: "done", detail: outputPath },
        { label: "Read source note", status: "pending" },
        { label: "Summarize transcript", status: "pending" },
      ],
      transcriptChunks: [],
      transcriptionUsage: createUsageTotals(),
      summaryUsage: createUsageTotals(),
    };

    const outputFile = await this.app.vault.create(outputPath, renderJobNote(state));

    try {
      new Notice("Meeting Notes: summary started.");
      await this.updateProgress(outputFile, state, "Read source note", "running");
      const sourceMarkdown = await this.app.vault.read(sourceFile);
      const transcript = extractSummarizableMarkdown(sourceMarkdown);
      if (!transcript.trim()) {
        throw new Error("Source note does not contain text to summarize.");
      }

      state.transcriptChunks.push({
        label: "Transcript",
        markdown: transcript,
        text: transcript,
      });
      await this.updateProgress(outputFile, state, "Read source note", "done", `${formatInteger(transcript.length)} characters`);

      await this.updateProgress(outputFile, state, "Summarize transcript", "running", `Using ${state.summaryModel}`);
      state.summary = await this.withProgressHeartbeat(
        outputFile,
        state,
        "Summarize transcript",
        (elapsedSeconds) => `Using ${state.summaryModel}; elapsed ${formatDuration(elapsedSeconds)}`,
        () => this.summarizeTranscript(outputFile, state)
      );
      await this.updateProgress(outputFile, state, "Summarize transcript", "done");

      state.status = "completed";
      state.updatedAt = new Date().toISOString();
      await this.writeState(outputFile, state);
      new Notice("Meeting Notes: summary completed.");
    } catch (error) {
      state.status = "failed";
      state.error = getErrorMessage(error);
      state.updatedAt = new Date().toISOString();
      markRunningItemsFailed(state);
      await this.writeState(outputFile, state);
      new Notice(`Meeting Notes failed: ${state.error}`);
    }
  }

  private async getAvailableOutputPath(rawTitle: string, sourceFile: TFile): Promise<string> {
    const folder = this.settings.saveWithRecording ? getParentPath(sourceFile.path) : normalizePath(this.settings.outputFolder.trim());
    if (folder) {
      await ensureFolder(this.app, folder);
    }

    const fileName = sanitizeFileName(rawTitle || DEFAULT_SETTINGS.noteTitleTemplate);
    const prefix = folder ? `${folder}/` : "";
    let candidate = normalizePath(`${prefix}${fileName}.md`);
    let counter = 2;

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${prefix}${fileName} ${counter}.md`);
      counter += 1;
    }

    return candidate;
  }

  private async trashSourceRecording(outputFile: TFile, state: JobState, sourceFile: TFile) {
    await this.updateProgress(outputFile, state, "Delete source recording", "running", "Moving source file to system trash");

    try {
      await this.app.vault.trash(sourceFile, true);
      await this.updateProgress(outputFile, state, "Delete source recording", "done", "Moved to system trash");
    } catch (error) {
      await this.updateProgress(outputFile, state, "Delete source recording", "error", getErrorMessage(error));
      new Notice(`Meeting Notes: note completed, but the recording was not deleted: ${getErrorMessage(error)}`);
    }
  }

  private async prepareChunkPlans(
    sourceFile: TFile,
    sourceData: ArrayBuffer,
    outputFile: TFile,
    state: JobState
  ): Promise<AudioChunkPlan[]> {
    if (sourceData.byteLength <= MAX_DIRECT_UPLOAD_BYTES) {
      state.chunksTotal = 1;
      state.chunksDone = 0;
      await this.writeState(outputFile, state);
      return [{ index: 1, total: 1, startSeconds: 0, endSeconds: 0 }];
    }

    await this.updateProgress(
      outputFile,
      state,
      "Prepare audio",
      "running",
      "File exceeds the OpenAI upload limit; decoding for local chunking"
    );

    const audioBuffer = await decodeAudio(sourceData);
    const chunkSeconds = Math.max(60, Math.floor(TARGET_CHUNK_UPLOAD_BYTES / CHUNK_BYTES_PER_SECOND));
    const total = Math.ceil(audioBuffer.duration / chunkSeconds);
    const plans: AudioChunkPlan[] = [];

    for (let index = 1; index <= total; index += 1) {
      const startSeconds = (index - 1) * chunkSeconds;
      const endSeconds = Math.min(index * chunkSeconds, audioBuffer.duration);
      plans.push({ index, total, startSeconds, endSeconds });
    }

    decodedAudioCache.set(sourceFile.path, audioBuffer);
    state.chunksTotal = plans.length;
    state.chunksDone = 0;
    await this.writeState(outputFile, state);
    return plans;
  }

  private async makeWavChunkPayload(sourceFile: TFile, sourceData: ArrayBuffer, plan: AudioChunkPlan): Promise<AudioChunkPayload> {
    let audioBuffer = decodedAudioCache.get(sourceFile.path);

    if (!audioBuffer) {
      audioBuffer = await decodeAudio(sourceData);
      decodedAudioCache.set(sourceFile.path, audioBuffer);
    }

    return {
      fileName: `${sourceFile.basename}-part-${String(plan.index).padStart(2, "0")}.wav`,
      mimeType: "audio/wav",
      data: encodeWavChunk(audioBuffer, plan.startSeconds, plan.endSeconds),
      offsetSeconds: plan.startSeconds,
    };
  }

  private async transcribeChunk(payload: AudioChunkPayload, priorTranscriptTail: string, state: JobState): Promise<TranscriptionResult> {
    const boundary = `meeting-notes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const form = new MultipartBuilder(boundary);

    form.appendField("model", state.transcriptionModel);

    if (state.diarize) {
      form.appendField("response_format", "diarized_json");
      form.appendField("chunking_strategy", "auto");
    } else {
      form.appendField("response_format", "json");
      const prompt = buildTranscriptionPrompt(this.settings.transcriptionPrompt, priorTranscriptTail);
      if (prompt) {
        form.appendField("prompt", prompt);
      }
    }

    form.appendFile("file", payload.fileName, payload.mimeType, payload.data);

    const response = await requestUrl({
      url: "https://api.openai.com/v1/audio/transcriptions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: form.build(),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(readOpenAiError(response.text, `OpenAI transcription request failed with HTTP ${response.status}`));
    }

    const result = formatTranscriptionResponse(response.json, state.diarize, payload.offsetSeconds);
    return {
      ...result,
      usage: readUsageTotals(response.json, state.transcriptionModel, "transcription"),
    };
  }

  private async summarizeTranscript(outputFile: TFile, state: JobState): Promise<string> {
    const transcript = state.transcriptChunks.map((chunk) => `### ${chunk.label}\n${chunk.text}`).join("\n\n");

    if (!this.settings.splitTranscriptForSummary) {
      const result = await this.requestSummary(transcript, state.sourcePath, state.summaryModel);
      addUsageTotals(state.summaryUsage, result.usage);
      return result.text;
    }

    const textChunks = splitTextForSummary(transcript);
    if (textChunks.length === 1) {
      const result = await this.requestSummary(textChunks[0], state.sourcePath, state.summaryModel);
      addUsageTotals(state.summaryUsage, result.usage);
      return result.text;
    }

    const partialSummaries: string[] = [];
    for (let index = 0; index < textChunks.length; index += 1) {
      await this.updateProgress(
        outputFile,
        state,
        "Summarize transcript",
        "running",
        `Summarizing transcript part ${index + 1}/${textChunks.length}`
      );
      const result = await this.requestSummary(textChunks[index], `${state.sourcePath}, part ${index + 1}`, state.summaryModel);
      addUsageTotals(state.summaryUsage, result.usage);
      partialSummaries.push(result.text);
    }

    await this.updateProgress(outputFile, state, "Summarize transcript", "running", "Combining partial summaries");
    const result = await this.requestSummary(partialSummaries.join("\n\n"), `${state.sourcePath}, combined partial summaries`, state.summaryModel);
    addUsageTotals(state.summaryUsage, result.usage);
    return result.text;
  }

  private async requestSummary(transcript: string, sourceLabel: string, summaryModel: string): Promise<SummaryResult> {
    const instructions = buildSummaryInstructions(this.settings);
    const model = normalizeSummaryModel(summaryModel);
    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions,
        input: `Source file: ${sourceLabel}\n\nTranscript:\n${transcript}`,
        text: {
          verbosity: "low",
        },
      }),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(readOpenAiError(response.text, `OpenAI summary request failed with HTTP ${response.status}`));
    }

    const text = extractResponseText(response.json);
    if (!text) {
      throw new Error("OpenAI summary response did not contain output text.");
    }
    return {
      text: normalizeSummaryMarkdown(text, this.settings),
      usage: readUsageTotals(response.json, model, "summary"),
    };
  }

  private async updateProgress(outputFile: TFile, state: JobState, label: string, status: ProgressStatus, detail?: string) {
    const item = state.progress.find((entry) => entry.label === label);
    if (item) {
      item.status = status;
      item.detail = detail;
    }
    state.updatedAt = new Date().toISOString();
    await this.writeState(outputFile, state);
  }

  private async setChunkProgress(
    outputFile: TFile,
    state: JobState,
    chunksDone: number,
    chunksTotal: number,
    status: ProgressStatus
  ) {
    state.chunksDone = chunksDone;
    state.chunksTotal = chunksTotal;
    await this.updateProgress(outputFile, state, "Transcribe audio", status, `${chunksDone}/${chunksTotal} chunks finished`);
  }

  private async writeState(outputFile: TFile, state: JobState) {
    state.updatedAt = new Date().toISOString();
    await this.app.vault.process(outputFile, () => renderJobNote(state));
  }

  private async withProgressHeartbeat<T>(
    outputFile: TFile,
    state: JobState,
    label: string,
    detailFactory: (elapsedSeconds: number) => string,
    work: () => Promise<T>
  ): Promise<T> {
    const intervalSeconds = normalizeProgressUpdateInterval(this.settings.progressUpdateIntervalSeconds);
    if (intervalSeconds <= 0) {
      return await work();
    }

    const startedAt = Date.now();
    let stopped = false;
    let lastWrite = Promise.resolve();
    const writeHeartbeat = () => {
      lastWrite = lastWrite
        .catch(() => undefined)
        .then(async () => {
          if (stopped) {
            return;
          }
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          await this.updateProgress(outputFile, state, label, "running", detailFactory(elapsedSeconds));
        });
    };
    const timer = window.setInterval(writeHeartbeat, intervalSeconds * 1000);

    try {
      return await work();
    } finally {
      stopped = true;
      window.clearInterval(timer);
      await lastWrite.catch(() => undefined);
    }
  }
}

class MeetingNotesSettingTab extends PluginSettingTab {
  plugin: MeetingNotesPlugin;

  constructor(app: App, plugin: MeetingNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    let transcriptionPromptDescEl: HTMLElement | null = null;
    let summaryPromptDescEl: HTMLElement | null = null;
    const refreshPromptPreviews = () => {
      if (transcriptionPromptDescEl) {
        renderPromptDescription(
          transcriptionPromptDescEl,
          "Optional context for non-diarized transcription.",
          buildGeneratedTranscriptionPromptPreview(DEFAULT_SETTINGS),
          buildGeneratedTranscriptionPromptPreview(this.plugin.settings)
        );
      }
      if (summaryPromptDescEl) {
        renderPromptDescription(
          summaryPromptDescEl,
          "Optional override. Leave blank to use the current generated summary prompt from the selected sections.",
          buildGeneratedSummaryInstructions(DEFAULT_SETTINGS),
          buildGeneratedSummaryInstructions(this.plugin.settings)
        );
      }
    };
    const saveAndRefreshPromptPreviews = async () => {
      await this.plugin.saveSettings();
      refreshPromptPreviews();
    };
    const addSummarySectionSetting = (
      label: string,
      desc: string,
      enabled: boolean,
      onEnabledChange: (value: boolean) => void,
      name: string,
      onNameChange: (value: string) => void,
      placeholder: string
    ) => {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addToggle((toggle) => {
          toggle.setValue(enabled).onChange(async (value) => {
            onEnabledChange(value);
            await saveAndRefreshPromptPreviews();
          });
        })
        .addText((text) => {
          text
            .setPlaceholder(placeholder)
            .setValue(name)
            .onChange(async (value) => {
              onNameChange(value.trim());
              await saveAndRefreshPromptPreviews();
            });
        });
    };

    containerEl.createEl("h3", { text: "OpenAI" });

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Stored in this vault's plugin data. Used for transcription, summary, and refreshing available models.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Summary model")
      .setDesc("Used by Generate meeting notes when summary is enabled, Transcribe and summary, and Summary.")
      .addDropdown((dropdown) => {
        for (const model of getSummaryModelOptions(this.plugin.settings)) {
          dropdown.addOption(model, model);
        }
        dropdown.setValue(this.plugin.settings.summaryModel || DEFAULT_SETTINGS.summaryModel).onChange(async (value) => {
          this.plugin.settings.summaryModel = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton((button) => {
        button.setButtonText("Refresh models").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Refreshing...");
          try {
            const count = await this.plugin.refreshAvailableSummaryModels();
            new Notice(`Meeting Notes: refreshed ${count} summary model options.`);
            this.display();
          } catch (error) {
            new Notice(`Meeting Notes: ${getErrorMessage(error)}`);
            button.setDisabled(false);
            button.setButtonText("Refresh models");
          }
        });
      });

    containerEl.createEl("h3", { text: "Generate meeting notes defaults" });

    new Setting(containerEl)
      .setName("Transcription model")
      .setDesc("Used by Generate meeting notes when diarization is off, and by all non-diarized right-click actions.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe")
          .addOption("gpt-4o-transcribe", "gpt-4o-transcribe")
          .addOption("whisper-1", "whisper-1")
          .setValue(this.plugin.settings.transcriptionModel)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionModel = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Diarize speakers")
      .setDesc("Default for Generate meeting notes and Summary. Explicit diarized right-click actions always diarize.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.diarize).onChange(async (value) => {
          this.plugin.settings.diarize = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Generate meeting notes includes summary")
      .setDesc("When off, Generate meeting notes only transcribes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.generateSummary).onChange(async (value) => {
          this.plugin.settings.generateSummary = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Summary output" });

    addSummarySectionSetting(
      "Include Section 1",
      "Default: Summary. Toggle inclusion; edit the field on the right to change the Markdown header name.",
      this.plugin.settings.includeSectionSummary,
      (value) => {
        this.plugin.settings.includeSectionSummary = value;
      },
      this.plugin.settings.summarySectionSummaryName,
      (value) => {
        this.plugin.settings.summarySectionSummaryName = value;
      },
      DEFAULT_SETTINGS.summarySectionSummaryName
    );

    addSummarySectionSetting(
      "Include Section 2",
      "Default: What was discussed. Toggle inclusion; edit the field on the right to change the Markdown header name.",
      this.plugin.settings.includeSectionDiscussedItems,
      (value) => {
        this.plugin.settings.includeSectionDiscussedItems = value;
      },
      this.plugin.settings.summarySectionDiscussedItemsName,
      (value) => {
        this.plugin.settings.summarySectionDiscussedItemsName = value;
      },
      DEFAULT_SETTINGS.summarySectionDiscussedItemsName
    );

    addSummarySectionSetting(
      "Include Section 3",
      "Default: Decisions made. Toggle inclusion; edit the field on the right to change the Markdown header name.",
      this.plugin.settings.includeSectionDecisions,
      (value) => {
        this.plugin.settings.includeSectionDecisions = value;
      },
      this.plugin.settings.summarySectionDecisionsName,
      (value) => {
        this.plugin.settings.summarySectionDecisionsName = value;
      },
      DEFAULT_SETTINGS.summarySectionDecisionsName
    );

    addSummarySectionSetting(
      "Include Section 4",
      "Default: Next steps. Toggle inclusion; edit the field on the right to change the Markdown header name.",
      this.plugin.settings.includeSectionNextSteps,
      (value) => {
        this.plugin.settings.includeSectionNextSteps = value;
      },
      this.plugin.settings.summarySectionNextStepsName,
      (value) => {
        this.plugin.settings.summarySectionNextStepsName = value;
      },
      DEFAULT_SETTINGS.summarySectionNextStepsName
    );

    addSummarySectionSetting(
      "Include Section 5",
      "Default: Task to do. Toggle inclusion; edit the field on the right to change the Markdown header name. Items are generated as ordered Markdown checkboxes.",
      this.plugin.settings.includeSectionTodo,
      (value) => {
        this.plugin.settings.includeSectionTodo = value;
      },
      this.plugin.settings.summarySectionTodoName,
      (value) => {
        this.plugin.settings.summarySectionTodoName = value;
      },
      DEFAULT_SETTINGS.summarySectionTodoName
    );

    new Setting(containerEl)
      .setName("Split transcript before summary")
      .setDesc("Advanced long-context models such as gpt-5.5 usually do not need this. Enable only when summary requests are too large or fail.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.splitTranscriptForSummary).onChange(async (value) => {
          this.plugin.settings.splitTranscriptForSummary = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Note creation" });

    new Setting(containerEl)
      .setName("Save note beside source file")
      .setDesc("When on, the new note is saved in the same folder as the audio or Markdown source file and the output folder below is ignored.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.saveWithRecording).onChange(async (value) => {
          this.plugin.settings.saveWithRecording = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Created if it does not exist. Ignored when Save note beside source file is on.")
      .addText((text) => {
        text
          .setPlaceholder("Meeting Notes")
          .setValue(this.plugin.settings.outputFolder)
          .setDisabled(this.plugin.settings.saveWithRecording)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Note title template")
      .setDesc("Default is {{date}}. Variables: {{date}}, {{file}}, {{stem}}, {{time}}, {{mode}}, {{model}}. Examples: {{date}}, {{date}} {{stem}}, Meeting {{date}}.")
      .addText((text) => {
        text
          .setPlaceholder("{{date}}")
          .setValue(this.plugin.settings.noteTitleTemplate)
          .onChange(async (value) => {
            this.plugin.settings.noteTitleTemplate = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("Controls {{date}} in the title template. Supported tokens include YYYY, YY, MM, M, DD, D. Examples: YYYY-MM-DD, YYYYMMDD, YYMMDD.")
      .addText((text) => {
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.titleDateFormat)
          .onChange(async (value) => {
            this.plugin.settings.titleDateFormat = value.trim() || DEFAULT_SETTINGS.titleDateFormat;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Date source")
      .setDesc("Controls whether {{date}} and {{time}} use the recording file creation date or the current date.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("recording", "Recording date")
          .addOption("today", "Today's date")
          .setValue(this.plugin.settings.titleDateSource)
          .onChange(async (value) => {
            this.plugin.settings.titleDateSource = value as TitleDateSource;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Delete recording after successful note")
      .setDesc("After the note is generated, move the source recording to the system trash. If deletion fails, the note is kept.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.deleteRecordingAfterSuccess).onChange(async (value) => {
          this.plugin.settings.deleteRecordingAfterSuccess = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Progress update interval")
      .setDesc("Seconds between note rewrites while a long prepare, transcription, or summary request is running. Set to 0 to disable heartbeat updates.")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.progressUpdateIntervalSeconds))
          .onChange(async (value) => {
            this.plugin.settings.progressUpdateIntervalSeconds = normalizeProgressUpdateInterval(Number(value));
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Right-click menu" });

    new Setting(containerEl)
      .setName("Show Generate meeting notes")
      .setDesc("Uses the Generate meeting notes defaults, summary output settings, and note creation settings above.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showGenerateMeetingNotes).onChange(async (value) => {
          this.plugin.settings.showGenerateMeetingNotes = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Transcribe")
      .setDesc("Creates a transcript note only. Does not diarize and does not summarize.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showTranscribe).onChange(async (value) => {
          this.plugin.settings.showTranscribe = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Transcribe (diarize)")
      .setDesc("Creates a transcript note only and forces speaker diarization.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showTranscribeDiarize).onChange(async (value) => {
          this.plugin.settings.showTranscribeDiarize = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Transcribe and summary")
      .setDesc("Creates a transcript and summary note. Does not diarize.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showTranscribeSummary).onChange(async (value) => {
          this.plugin.settings.showTranscribeSummary = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Transcribe and summary (diarize)")
      .setDesc("Creates a transcript and summary note and forces speaker diarization.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showTranscribeSummaryDiarize).onChange(async (value) => {
          this.plugin.settings.showTranscribeSummaryDiarize = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Summary")
      .setDesc("Creates a summary-only note. It transcribes internally and uses the Generate meeting notes diarization default.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showSummary).onChange(async (value) => {
          this.plugin.settings.showSummary = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Summarize note")
      .setDesc("Appears on Markdown files. Uses the current summary model, summary output settings, and note creation settings.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showSummarizeMarkdown).onChange(async (value) => {
          this.plugin.settings.showSummarizeMarkdown = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Prompts" });

    const transcriptionPromptSetting = new Setting(containerEl)
      .setName("Transcription prompt")
      .setDesc("")
      .addTextArea((text) => {
        text
          .setPlaceholder("Names, acronyms, terminology, or language preferences")
          .setValue(this.plugin.settings.transcriptionPrompt)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionPrompt = value;
            await this.plugin.saveSettings();
            refreshPromptPreviews();
          });
        text.inputEl.rows = 4;
      });
    transcriptionPromptDescEl = transcriptionPromptSetting.descEl;

    const summaryPromptSetting = new Setting(containerEl)
      .setName("Summary prompt")
      .setDesc("")
      .addTextArea((text) => {
        text
          .setPlaceholder("Leave blank to use the selected section toggles.")
          .setValue(this.plugin.settings.summaryInstructions)
          .onChange(async (value) => {
            this.plugin.settings.summaryInstructions = value;
            await this.plugin.saveSettings();
            refreshPromptPreviews();
          });
        text.inputEl.rows = 5;
      });
    summaryPromptDescEl = summaryPromptSetting.descEl;

    refreshPromptPreviews();
  }
}

const decodedAudioCache = new Map<string, AudioBuffer>();

class MultipartBuilder {
  private readonly parts: Uint8Array[] = [];
  private readonly encoder = new TextEncoder();

  constructor(private readonly boundary: string) {}

  appendField(name: string, value: string) {
    this.parts.push(
      this.encoder.encode(`--${this.boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n${value}\r\n`)
    );
  }

  appendFile(name: string, fileName: string, mimeType: string, data: ArrayBuffer) {
    this.parts.push(
      this.encoder.encode(
        `--${this.boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(name)}"; filename="${escapeMultipartName(
          fileName
        )}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      )
    );
    this.parts.push(new Uint8Array(data));
    this.parts.push(this.encoder.encode("\r\n"));
  }

  build(): ArrayBuffer {
    this.parts.push(this.encoder.encode(`--${this.boundary}--\r\n`));
    const byteLength = this.parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(byteLength);
    let offset = 0;

    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }

    return output.buffer;
  }
}

function renderJobNote(state: JobState): string {
  const lines: string[] = [`# ${state.title}`, ""];

  if (state.summary) {
    lines.push("", "## Summary", "", state.summary.trim());
  } else if (state.includeSummary) {
    lines.push("", "## Summary", "", "_Summary will appear here after processing finishes._");
  }

  if (state.includeTranscript || state.error) {
    lines.push("", "## Transcript", "");

    if (state.transcriptChunks.length === 0) {
      lines.push("_Transcript will appear here as chunks complete._");
    } else {
      for (const chunk of state.transcriptChunks) {
        if (state.transcriptChunks.length > 1) {
          lines.push(`### ${chunk.label}`, "");
        }
        lines.push(chunk.markdown.trim(), "");
      }
    }
  }

  if (state.error) {
    lines.push("", "## Error", "", state.error);
  }

  lines.push("", "## Progress", "");
  for (const item of state.progress) {
    lines.push(`${progressPrefix(item.status)} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
  }

  lines.push(
    "",
    "## Properties",
    "",
    `- source: ${state.sourcePath}`,
    `- status: ${state.status}`,
    `- mode: ${state.mode}`,
    `- transcription_model: ${state.transcriptionModel}`,
    `- summary_model: ${state.summaryModel}`,
    `- diarize: ${state.diarize}`,
    `- include_summary: ${state.includeSummary}`,
    `- include_transcript: ${state.includeTranscript}`,
    `- started_at: ${state.startedAt}`,
    `- updated_at: ${state.updatedAt}`
  );
  if (state.mode !== "markdown-summary") {
    lines.push(...formatUsageProperties("transcription", state.transcriptionUsage));
  }
  lines.push(...formatUsageProperties("summary", state.summaryUsage));

  return `${lines.join("\n").replace(/\s+$/u, "")}\n`;
}

function progressPrefix(status: ProgressStatus): string {
  if (status === "done") {
    return "- [x] Done:";
  }
  if (status === "running") {
    return "- [ ] Running:";
  }
  if (status === "error") {
    return "- [ ] Error:";
  }
  return "- [ ] Pending:";
}

function markRunningItemsFailed(state: JobState) {
  for (const item of state.progress) {
    if (item.status === "running") {
      item.status = "error";
    }
  }
}

function extractSummarizableMarkdown(markdown: string): string {
  const transcriptSection = extractMarkdownSection(markdown, "Transcript");
  return (transcriptSection ?? markdown).trim();
}

function extractMarkdownSection(markdown: string, sectionName: string): string | null {
  const lines = markdown.split("\n");
  const target = sectionName.toLowerCase();
  const sectionLines: string[] = [];
  let sectionLevel = 0;
  let inSection = false;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim().replace(/:$/u, "").toLowerCase();

      if (inSection && level <= sectionLevel) {
        break;
      }
      if (!inSection && heading === target) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
    }

    if (inSection) {
      sectionLines.push(line);
    }
  }

  const section = sectionLines.join("\n").trim();
  return section ? section : null;
}

function renderTemplate(template: string, file: TFile, mode: JobMode, model: string, dateFormat: string, dateSource: TitleDateSource): string {
  const sourceDate = dateSource === "today" ? new Date() : new Date(file.stat.ctime);
  const date = formatDate(sourceDate, dateFormat || DEFAULT_SETTINGS.titleDateFormat);
  const time = formatDate(sourceDate, "HHmm");

  return (template || DEFAULT_SETTINGS.noteTitleTemplate)
    .split("{{file}}")
    .join(file.basename)
    .split("{{stem}}")
    .join(file.basename)
    .split("{{date}}")
    .join(date)
    .split("{{time}}")
    .join(time)
    .split("{{mode}}")
    .join(mode)
    .split("{{model}}")
    .join(model)
    .trim();
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function formatDate(date: Date, format: string): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    D: String(date.getDate()),
    HH: pad2(date.getHours()),
    H: String(date.getHours()),
    mm: pad2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    s: String(date.getSeconds()),
  };

  return (format || DEFAULT_SETTINGS.titleDateFormat).replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/gu, (token) => values[token]);
}

function getParentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return normalizePath(parts.join("/"));
}

async function ensureFolder(app: App, folder: string) {
  const parts = folder.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function buildTranscriptionPrompt(basePrompt: string, priorTranscriptTail: string): string {
  const promptParts = [basePrompt.trim()];
  if (priorTranscriptTail.trim()) {
    promptParts.push(`Previous transcript context:\n${priorTranscriptTail.trim()}`);
  }
  return promptParts.filter(Boolean).join("\n\n");
}

function buildGeneratedTranscriptionPromptPreview(settings: MeetingNotesSettings): string {
  const customPrompt = settings.transcriptionPrompt.trim();
  const priorContextNote = "Previous transcript context:\n[added automatically from the previous chunk when needed]";

  if (customPrompt) {
    return `${customPrompt}\n\n${priorContextNote}`;
  }

  return `No default prompt is sent for the first chunk.\n\n${priorContextNote}`;
}

function renderPromptDescription(descEl: HTMLElement, intro: string, defaultPrompt: string, currentPrompt: string) {
  descEl.empty();
  descEl.createDiv({ text: intro });
  descEl.createDiv({ text: "Default generated prompt:" }).addClass("meeting-notes-prompt-label");
  descEl.createEl("pre", { text: defaultPrompt, cls: "meeting-notes-prompt-note" });
  descEl.createDiv({ text: "Current generated prompt:" }).addClass("meeting-notes-prompt-label");
  descEl.createEl("pre", { text: currentPrompt, cls: "meeting-notes-prompt-note" });
}

function buildSummaryInstructions(settings: MeetingNotesSettings): string {
  const customPrompt = settings.summaryInstructions.trim();
  if (customPrompt) {
    return customPrompt;
  }

  return buildGeneratedSummaryInstructions(settings);
}

function buildGeneratedSummaryInstructions(settings: MeetingNotesSettings): string {
  const sections = getSummarySections(settings).filter((section) => section.enabled);
  const selectedSections = sections.length > 0 ? sections : [getSummarySections(DEFAULT_SETTINGS)[0]];

  return [
    "Create concise meeting notes from the transcript.",
    "Use only the transcript content; do not invent names, dates, decisions, or tasks.",
    "Preserve important names, dates, numbers, and technical terms.",
    `Return Markdown with exactly these subheaders, in this order: ${selectedSections.map((section) => `## ${section.name}`).join(", ")}.`,
    "Use ordered lists under each subheader. Do not use simple bullet points.",
    ...selectedSections.map(summarySectionInstruction),
  ].join("\n");
}

function getSummarySections(settings: MeetingNotesSettings) {
  return [
    {
      key: "summary",
      enabled: settings.includeSectionSummary,
      name: sectionName(settings.summarySectionSummaryName, DEFAULT_SETTINGS.summarySectionSummaryName),
    },
    {
      key: "discussed",
      enabled: settings.includeSectionDiscussedItems,
      name: sectionName(settings.summarySectionDiscussedItemsName, DEFAULT_SETTINGS.summarySectionDiscussedItemsName),
    },
    {
      key: "decisions",
      enabled: settings.includeSectionDecisions,
      name: sectionName(settings.summarySectionDecisionsName, DEFAULT_SETTINGS.summarySectionDecisionsName),
    },
    {
      key: "nextSteps",
      enabled: settings.includeSectionNextSteps,
      name: sectionName(settings.summarySectionNextStepsName, DEFAULT_SETTINGS.summarySectionNextStepsName),
    },
    {
      key: "todo",
      enabled: settings.includeSectionTodo,
      name: sectionName(settings.summarySectionTodoName, DEFAULT_SETTINGS.summarySectionTodoName),
    },
  ];
}

function summarySectionInstruction(section: { key: string; name: string }): string {
  if (section.key === "summary") {
    return `For ${section.name}, write a short overview.`;
  }
  if (section.key === "discussed") {
    return `For ${section.name}, list the substantive topics covered.`;
  }
  if (section.key === "decisions") {
    return `For ${section.name}, list decisions or settled conclusions only.`;
  }
  if (section.key === "nextSteps") {
    return `For ${section.name}, list generalized guidance that follows from the meeting.`;
  }
  return `For ${section.name}, list specific actionable tasks only. Use ordered Markdown task checkboxes exactly like \`1. [ ] Task\`; include owner or deadline only if stated.`;
}

function sectionName(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function matchesHeading(normalizedHeading: string, configuredHeading: string, aliases: string[]): boolean {
  return normalizedHeading === configuredHeading.toLowerCase() || aliases.includes(normalizedHeading);
}

function normalizeSummaryMarkdown(summary: string, settings: MeetingNotesSettings): string {
  let inTaskSection = false;
  const todoName = sectionName(settings.summarySectionTodoName, DEFAULT_SETTINGS.summarySectionTodoName);

  return summary
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(/^(#{2,6})\s+(.+?)\s*$/u);
      if (headingMatch) {
        const heading = normalizeSummaryHeading(headingMatch[2], settings);
        inTaskSection = heading.toLowerCase() === todoName.toLowerCase();
        return `${headingMatch[1]} ${heading}`;
      }

      if (inTaskSection) {
        const taskText = extractListItemText(line);
        return taskText ? `1. [ ] ${taskText}` : line;
      }

      const listText = extractBulletItemText(line);
      return listText ? `1. ${listText}` : line;
    })
    .join("\n")
    .trim();
}

function normalizeSummaryHeading(heading: string, settings: MeetingNotesSettings): string {
  const normalized = heading.trim().replace(/:$/u, "").toLowerCase();
  const summaryName = sectionName(settings.summarySectionSummaryName, DEFAULT_SETTINGS.summarySectionSummaryName);
  const discussedName = sectionName(settings.summarySectionDiscussedItemsName, DEFAULT_SETTINGS.summarySectionDiscussedItemsName);
  const decisionsName = sectionName(settings.summarySectionDecisionsName, DEFAULT_SETTINGS.summarySectionDecisionsName);
  const nextStepsName = sectionName(settings.summarySectionNextStepsName, DEFAULT_SETTINGS.summarySectionNextStepsName);
  const todoName = sectionName(settings.summarySectionTodoName, DEFAULT_SETTINGS.summarySectionTodoName);

  if (matchesHeading(normalized, summaryName, ["summary", "overview"])) {
    return summaryName;
  }
  if (matchesHeading(normalized, discussedName, ["discussed items", "discussion", "what was discussed"])) {
    return discussedName;
  }
  if (matchesHeading(normalized, decisionsName, ["decisions", "decisions made"])) {
    return decisionsName;
  }
  if (matchesHeading(normalized, nextStepsName, ["next steps", "guidance"])) {
    return nextStepsName;
  }
  if (matchesHeading(normalized, todoName, ["todo", "to-do", "task to do", "tasks to do", "action items"])) {
    return todoName;
  }
  return heading.trim().replace(/:$/u, "");
}

function extractListItemText(line: string): string | null {
  const orderedTaskMatch = line.match(/^\s*\d+[\.)]\s+\[[ xX]\]\s+(.+?)\s*$/u);
  if (orderedTaskMatch) {
    return orderedTaskMatch[1];
  }

  const unorderedTaskMatch = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/u);
  if (unorderedTaskMatch) {
    return unorderedTaskMatch[1];
  }

  const orderedMatch = line.match(/^\s*\d+[\.)]\s+(.+?)\s*$/u);
  if (orderedMatch) {
    return orderedMatch[1];
  }

  return extractBulletItemText(line);
}

function extractBulletItemText(line: string): string | null {
  const bulletMatch = line.match(/^\s*[-*+]\s+(.+?)\s*$/u);
  if (bulletMatch) {
    return bulletMatch[1];
  }

  return null;
}

async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This Obsidian environment does not provide AudioContext, so large-file chunking is unavailable.");
  }

  const audioContext = new AudioContextClass();
  try {
    return await audioContext.decodeAudioData(data.slice(0));
  } finally {
    void audioContext.close();
  }
}

function encodeWavChunk(audioBuffer: AudioBuffer, startSeconds: number, endSeconds: number): ArrayBuffer {
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const frameCount = Math.ceil(duration * CHUNK_SAMPLE_RATE);
  const dataBytes = frameCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CHUNK_SAMPLE_RATE, true);
  view.setUint32(28, CHUNK_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourcePosition = (startSeconds + frame / CHUNK_SAMPLE_RATE) * audioBuffer.sampleRate;
    const sample = readMonoSample(audioBuffer, sourcePosition);
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function readMonoSample(audioBuffer: AudioBuffer, sourcePosition: number): number {
  const index = Math.floor(sourcePosition);
  const nextIndex = Math.min(index + 1, audioBuffer.length - 1);
  const fraction = sourcePosition - index;
  let sample = 0;

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    const current = data[Math.min(index, data.length - 1)] ?? 0;
    const next = data[nextIndex] ?? current;
    sample += current + (next - current) * fraction;
  }

  return sample / audioBuffer.numberOfChannels;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function formatTranscriptionResponse(responseJson: unknown, diarize: boolean, offsetSeconds: number): Omit<TranscriptionResult, "usage"> {
  if (!diarize) {
    const text = readTextField(responseJson);
    return {
      markdown: text,
      text,
    };
  }

  const segments = readDiarizedSegments(responseJson);
  if (segments.length === 0) {
    const text = readTextField(responseJson);
    return {
      markdown: text,
      text,
    };
  }

  const markdown = segments
    .map((segment) => {
      const speaker = segment.speaker || "Speaker";
      const start = typeof segment.start === "number" ? formatTimestamp(segment.start + offsetSeconds) : "";
      const end = typeof segment.end === "number" ? formatTimestamp(segment.end + offsetSeconds) : "";
      const range = start && end ? ` [${start}-${end}]` : "";
      return `**${speaker}**${range}: ${segment.text ?? ""}`.trim();
    })
    .join("\n\n");

  const text = segments.map((segment) => `${segment.speaker || "Speaker"}: ${segment.text ?? ""}`.trim()).join("\n");

  return { markdown, text };
}

function readTextField(responseJson: unknown): string {
  if (isRecord(responseJson) && typeof responseJson.text === "string") {
    return responseJson.text.trim();
  }
  return JSON.stringify(responseJson, null, 2);
}

function readDiarizedSegments(responseJson: unknown): DiarizedSegment[] {
  if (!isRecord(responseJson) || !Array.isArray(responseJson.segments)) {
    return [];
  }

  return responseJson.segments.filter(isRecord).map((segment) => ({
    speaker: typeof segment.speaker === "string" ? segment.speaker : undefined,
    start: typeof segment.start === "number" ? segment.start : undefined,
    end: typeof segment.end === "number" ? segment.end : undefined,
    text: typeof segment.text === "string" ? segment.text : undefined,
  }));
}

function extractResponseText(responseJson: unknown): string {
  if (!isRecord(responseJson) || !Array.isArray(responseJson.output)) {
    return "";
  }

  const output: string[] = [];
  for (const item of responseJson.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        output.push(content.text);
      }
    }
  }
  return output.join("\n").trim();
}

function splitTextForSummary(text: string): string[] {
  const maxChars = 80000;
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxChars));
    offset += maxChars;
  }
  return chunks;
}

function inferMimeType(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === "mp3" || ext === "mpga" || ext === "mpeg") {
    return "audio/mpeg";
  }
  if (ext === "m4a") {
    return "audio/mp4";
  }
  if (ext === "mp4") {
    return "video/mp4";
  }
  if (ext === "wav") {
    return "audio/wav";
  }
  if (ext === "webm") {
    return "audio/webm";
  }
  return "application/octet-stream";
}

function readOpenAiError(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    return body || fallback;
  }
  return body || fallback;
}

function normalizeSummaryModel(model: string): string {
  const value = model.trim();
  if (value === "gpt-5.5-mini") {
    return "gpt-5.4-mini";
  }
  return value || DEFAULT_SETTINGS.summaryModel;
}

function getSummaryModelOptions(settings: MeetingNotesSettings): string[] {
  const values = [
    normalizeSummaryModel(settings.summaryModel),
    DEFAULT_SETTINGS.summaryModel,
    ...DEFAULT_SUMMARY_MODEL_OPTIONS,
    ...settings.availableSummaryModels,
  ].map((value) => value.trim());

  return Array.from(new Set(values.filter(Boolean)));
}

function readModelIds(responseJson: unknown): string[] {
  if (!isRecord(responseJson) || !Array.isArray(responseJson.data)) {
    return [];
  }

  return responseJson.data
    .filter(isRecord)
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string");
}

function isLikelySummaryModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const blockedFragments = [
    "audio",
    "dall-e",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "sora",
    "speech",
    "transcribe",
    "tts",
    "video",
    "voice",
    "whisper",
  ];

  return !blockedFragments.some((fragment) => id.includes(fragment));
}

function normalizeProgressUpdateInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.progressUpdateIntervalSeconds;
  }

  return Math.max(0, Math.min(300, Math.round(value)));
}

function createUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    audioInputTokens: 0,
    textInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    durationSeconds: 0,
    costUnavailable: false,
  };
}

function addUsageTotals(target: UsageTotals, usage: UsageTotals) {
  if (!hasReportedUsage(usage)) {
    return;
  }

  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.audioInputTokens += usage.audioInputTokens;
  target.textInputTokens += usage.textInputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.durationSeconds += usage.durationSeconds;
  target.costUnavailable = target.costUnavailable || usage.costUnavailable;

  if (typeof usage.costUsd === "number") {
    target.costUsd = (target.costUsd ?? 0) + usage.costUsd;
  }
}

function readUsageTotals(responseJson: unknown, model: string, kind: UsageKind): UsageTotals {
  const totals = createUsageTotals();
  if (!isRecord(responseJson) || !isRecord(responseJson.usage)) {
    return totals;
  }

  const usage = responseJson.usage;
  const inputDetails = readNestedRecord(usage, "input_token_details") ?? readNestedRecord(usage, "input_tokens_details");
  const outputDetails = readNestedRecord(usage, "output_token_details") ?? readNestedRecord(usage, "output_tokens_details");

  totals.inputTokens = readNumberField(usage, "input_tokens") || readNumberField(usage, "prompt_tokens");
  totals.outputTokens = readNumberField(usage, "output_tokens") || readNumberField(usage, "completion_tokens");
  totals.totalTokens = readNumberField(usage, "total_tokens");
  totals.durationSeconds = readNumberField(usage, "seconds");

  if (inputDetails) {
    totals.audioInputTokens = readNumberField(inputDetails, "audio_tokens");
    totals.textInputTokens = readNumberField(inputDetails, "text_tokens");
    totals.cachedInputTokens = readNumberField(inputDetails, "cached_tokens");
  }
  if (outputDetails) {
    totals.reasoningTokens = readNumberField(outputDetails, "reasoning_tokens");
  }

  if (totals.totalTokens === 0 && totals.inputTokens + totals.outputTokens > 0) {
    totals.totalTokens = totals.inputTokens + totals.outputTokens;
  }

  const costUsd = calculateUsageCost(totals, model, kind);
  if (typeof costUsd === "number") {
    totals.costUsd = costUsd;
  } else {
    totals.costUnavailable = hasReportedUsage(totals);
  }

  return totals;
}

function calculateUsageCost(usage: UsageTotals, model: string, kind: UsageKind): number | undefined {
  if (!hasReportedUsage(usage)) {
    return undefined;
  }

  if (kind === "transcription" && usage.durationSeconds > 0 && usage.totalTokens === 0) {
    return (usage.durationSeconds / 60) * TRANSCRIPTION_DURATION_PRICE_PER_MINUTE;
  }

  const prices =
    kind === "transcription"
      ? getModelPricing(TRANSCRIPTION_TOKEN_PRICES_PER_1M, model)
      : getModelPricing(TEXT_MODEL_PRICES_PER_1M, model);
  if (!prices || usage.inputTokens + usage.outputTokens === 0) {
    return undefined;
  }

  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const cachedInputPrice = prices.cachedInput ?? prices.input;

  return (uncachedInputTokens * prices.input + cachedInputTokens * cachedInputPrice + usage.outputTokens * prices.output) / 1_000_000;
}

function getModelPricing(prices: Record<string, TokenPrices>, model: string): TokenPrices | undefined {
  const modelId = model.trim().toLowerCase();
  const keys = Object.keys(prices).sort((a, b) => b.length - a.length);

  for (const key of keys) {
    const normalizedKey = key.toLowerCase();
    if (modelId === normalizedKey || modelId.startsWith(`${normalizedKey}-`)) {
      return prices[key];
    }
  }

  return undefined;
}

function formatUsageProperties(prefix: "transcription" | "summary", usage: UsageTotals): string[] {
  return [`- ${prefix}_tokens: ${formatUsageSummary(usage)}`, `- ${prefix}_cost_usd: ${formatUsageCost(usage)}`];
}

function formatUsageSummary(usage: UsageTotals): string {
  if (!hasReportedUsage(usage)) {
    return "not reported yet";
  }

  const parts: string[] = [];
  if (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0) {
    parts.push(`input ${formatInteger(usage.inputTokens)}`);
    parts.push(`output ${formatInteger(usage.outputTokens)}`);
    parts.push(`total ${formatInteger(usage.totalTokens)}`);
  }
  if (usage.audioInputTokens > 0) {
    parts.push(`audio input ${formatInteger(usage.audioInputTokens)}`);
  }
  if (usage.textInputTokens > 0) {
    parts.push(`text input ${formatInteger(usage.textInputTokens)}`);
  }
  if (usage.cachedInputTokens > 0) {
    parts.push(`cached input ${formatInteger(usage.cachedInputTokens)}`);
  }
  if (usage.reasoningTokens > 0) {
    parts.push(`reasoning ${formatInteger(usage.reasoningTokens)}`);
  }
  if (usage.durationSeconds > 0) {
    parts.push(`duration ${formatDuration(usage.durationSeconds)}`);
  }

  return parts.join("; ") || "reported without billable units";
}

function formatUsageCost(usage: UsageTotals): string {
  if (typeof usage.costUsd === "number") {
    return formatUsd(usage.costUsd);
  }
  if (hasReportedUsage(usage) && usage.costUnavailable) {
    return "unavailable for this model";
  }
  return "not reported yet";
}

function hasReportedUsage(usage: UsageTotals): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.totalTokens > 0 ||
    usage.audioInputTokens > 0 ||
    usage.textInputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.durationSeconds > 0 ||
    usage.costUnavailable
  );
}

function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatInteger(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.000001) {
    return "<$0.000001";
  }
  return `$${value.toFixed(6)}`;
}

function buildTranscriptionHeartbeatDetail(chunkIndex: number, chunksTotal: number, elapsedSeconds: number): string {
  return `chunk ${chunkIndex}/${chunksTotal}; elapsed ${formatDuration(elapsedSeconds)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(remainingSeconds)}`;
  }
  return `${minutes}:${pad2(remainingSeconds)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeMultipartName(value: string): string {
  return value.split('"').join("%22").split("\r").join("").split("\n").join("");
}

function yamlEscape(value: string): string {
  return value.split("\\").join("\\\\").split('"').join('\\"');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
