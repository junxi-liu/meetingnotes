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

type JobMode = "transcribe" | "summarize";
type ProgressStatus = "pending" | "running" | "done" | "error";

interface MeetingNotesSettings {
  apiKey: string;
  transcriptionModel: string;
  diarize: boolean;
  summaryModel: string;
  outputFolder: string;
  noteTitleTemplate: string;
  transcriptionPrompt: string;
  summaryInstructions: string;
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
  chunksTotal: number;
  chunksDone: number;
  progress: ProgressItem[];
  transcriptChunks: TranscriptChunk[];
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
}

const DEFAULT_SETTINGS: MeetingNotesSettings = {
  apiKey: "",
  transcriptionModel: "gpt-4o-mini-transcribe",
  diarize: false,
  summaryModel: "gpt-5.5",
  outputFolder: "Meeting Notes",
  noteTitleTemplate: "{{file}} transcript {{date}}",
  transcriptionPrompt: "",
  summaryInstructions:
    "Create concise meeting notes with: overview, decisions, action items, unresolved questions, and important details. Preserve names, dates, numbers, and terminology from the transcript.",
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

export default class MeetingNotesPlugin extends Plugin {
  settings: MeetingNotesSettings;

  async onload() {
    await this.loadSettings();

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addAudioFileMenuItems(menu, file);
      })
    );

    this.addSettingTab(new MeetingNotesSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private addAudioFileMenuItems(menu: Menu, file: TAbstractFile) {
    if (!(file instanceof TFile) || !this.isSupportedAudioFile(file)) {
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle("Transcribe to note")
        .setIcon("mic")
        .onClick(() => {
          void this.startJob(file, "transcribe");
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Transcribe and summarize to note")
        .setIcon("file-text")
        .onClick(() => {
          void this.startJob(file, "summarize");
        });
    });
  }

  private isSupportedAudioFile(file: TFile): boolean {
    return AUDIO_EXTENSIONS.has(file.extension.toLowerCase());
  }

  private async startJob(sourceFile: TFile, mode: JobMode) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Meeting Notes: add your OpenAI API key in settings first.");
      return;
    }

    const title = renderTemplate(this.settings.noteTitleTemplate, sourceFile, mode, this.effectiveTranscriptionModel());
    const outputPath = await this.getAvailableOutputPath(title);
    const now = new Date().toISOString();
    const state: JobState = {
      title,
      sourcePath: sourceFile.path,
      mode,
      status: "in_progress",
      startedAt: now,
      updatedAt: now,
      transcriptionModel: this.effectiveTranscriptionModel(),
      summaryModel: this.settings.summaryModel.trim(),
      diarize: this.settings.diarize,
      chunksTotal: 0,
      chunksDone: 0,
      progress: [
        { label: "Created note", status: "done", detail: outputPath },
        { label: "Read source recording", status: "pending" },
        { label: "Prepare audio", status: "pending" },
        { label: "Transcribe audio", status: "pending" },
      ],
      transcriptChunks: [],
    };

    if (mode === "summarize") {
      state.progress.push({ label: "Summarize transcript", status: "pending" });
    }

    const outputFile = await this.app.vault.create(outputPath, renderJobNote(state));

    try {
      new Notice("Meeting Notes: transcription started.");
      await this.updateProgress(outputFile, state, "Read source recording", "running");
      const sourceData = await this.app.vault.readBinary(sourceFile);
      await this.updateProgress(outputFile, state, "Read source recording", "done", formatBytes(sourceData.byteLength));

      await this.updateProgress(outputFile, state, "Prepare audio", "running");
      const chunkPlans = await this.prepareChunkPlans(sourceFile, sourceData, outputFile, state);
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

        const result = await this.transcribeChunk(payload, priorTranscriptTail);
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

      if (mode === "summarize") {
        await this.updateProgress(outputFile, state, "Summarize transcript", "running", `Using ${state.summaryModel}`);
        state.summary = await this.summarizeTranscript(outputFile, state);
        await this.updateProgress(outputFile, state, "Summarize transcript", "done");
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

  private effectiveTranscriptionModel(): string {
    return this.settings.diarize ? "gpt-4o-transcribe-diarize" : this.settings.transcriptionModel.trim();
  }

  private async getAvailableOutputPath(rawTitle: string): Promise<string> {
    const folder = normalizePath(this.settings.outputFolder.trim());
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

  private async transcribeChunk(payload: AudioChunkPayload, priorTranscriptTail: string): Promise<TranscriptionResult> {
    const boundary = `meeting-notes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const form = new MultipartBuilder(boundary);
    const model = this.effectiveTranscriptionModel();

    form.appendField("model", model);

    if (this.settings.diarize) {
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

    return formatTranscriptionResponse(response.json, this.settings.diarize, payload.offsetSeconds);
  }

  private async summarizeTranscript(outputFile: TFile, state: JobState): Promise<string> {
    const transcript = state.transcriptChunks.map((chunk) => chunk.text).join("\n\n");
    const textChunks = splitTextForSummary(transcript);

    if (textChunks.length === 1) {
      return await this.requestSummary(textChunks[0], state.sourcePath);
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
      partialSummaries.push(await this.requestSummary(textChunks[index], `${state.sourcePath}, part ${index + 1}`));
    }

    await this.updateProgress(outputFile, state, "Summarize transcript", "running", "Combining partial summaries");
    return await this.requestSummary(partialSummaries.join("\n\n"), `${state.sourcePath}, combined partial summaries`);
  }

  private async requestSummary(transcript: string, sourceLabel: string): Promise<string> {
    const instructions = this.settings.summaryInstructions.trim() || DEFAULT_SETTINGS.summaryInstructions;
    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.summaryModel.trim() || DEFAULT_SETTINGS.summaryModel,
        instructions,
        input: `Source recording: ${sourceLabel}\n\nTranscript:\n${transcript}`,
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
    return text;
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

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Stored in this vault's plugin data.")
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
      .setName("Transcription model")
      .setDesc("Used when diarization is off.")
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
      .setDesc("Uses gpt-4o-transcribe-diarize and speaker-aware JSON output.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.diarize).onChange(async (value) => {
          this.plugin.settings.diarize = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Summary model")
      .setDesc("Any Responses API text model.")
      .addText((text) => {
        text
          .setPlaceholder("gpt-5.5")
          .setValue(this.plugin.settings.summaryModel)
          .onChange(async (value) => {
            this.plugin.settings.summaryModel = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Created if it does not exist.")
      .addText((text) => {
        text
          .setPlaceholder("Meeting Notes")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Note title template")
      .setDesc("Variables: {{file}}, {{stem}}, {{date}}, {{time}}, {{mode}}, {{model}}.")
      .addText((text) => {
        text
          .setPlaceholder("{{file}} transcript {{date}}")
          .setValue(this.plugin.settings.noteTitleTemplate)
          .onChange(async (value) => {
            this.plugin.settings.noteTitleTemplate = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Transcription prompt")
      .setDesc("Optional context for non-diarized transcription.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Names, acronyms, terminology, or language preferences")
          .setValue(this.plugin.settings.transcriptionPrompt)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("Summary instructions")
      .setDesc("Used for transcribe-and-summarize notes.")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.summaryInstructions)
          .onChange(async (value) => {
            this.plugin.settings.summaryInstructions = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
      });
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
  const lines: string[] = [
    "---",
    `source: "${yamlEscape(state.sourcePath)}"`,
    `status: ${state.status}`,
    `mode: ${state.mode}`,
    `transcription_model: "${yamlEscape(state.transcriptionModel)}"`,
    `summary_model: "${yamlEscape(state.summaryModel)}"`,
    `diarize: ${state.diarize}`,
    `started_at: "${state.startedAt}"`,
    `updated_at: "${state.updatedAt}"`,
    "---",
    "",
    `# ${state.title}`,
    "",
    "## Progress",
    "",
  ];

  for (const item of state.progress) {
    lines.push(`${progressPrefix(item.status)} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
  }

  if (state.error) {
    lines.push("", "## Error", "", state.error);
  }

  if (state.summary) {
    lines.push("", "## Summary", "", state.summary.trim());
  } else if (state.mode === "summarize") {
    lines.push("", "## Summary", "", "_Summary will appear here after transcription finishes._");
  }

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

function renderTemplate(template: string, file: TFile, mode: JobMode, model: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(":", "");

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

function formatTranscriptionResponse(responseJson: unknown, diarize: boolean, offsetSeconds: number): TranscriptionResult {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
