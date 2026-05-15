# Meeting Notes

Meeting Notes is an Obsidian plugin for existing audio files in your vault. Right-click a supported recording and choose either:

- **Transcribe to note**
- **Transcribe and summarize to note**

The plugin creates the Markdown note immediately, then rewrites it with live progress as it prepares the file, calls OpenAI, finishes each chunk, and optionally creates the summary.

## Supported audio files

The OpenAI Audio API supports `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, and `webm`. Files below the upload limit are sent as-is. Larger files are decoded in Obsidian and split into 16 kHz mono WAV chunks before upload.

## OpenAI models

Settings let you choose:

- Transcription model: `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, or `whisper-1`.
- Diarization: when enabled, the plugin uses `gpt-4o-transcribe-diarize` with `response_format=diarized_json` and `chunking_strategy=auto`.
- Summary model: any Responses API text model, defaulting to `gpt-5.5`.

## Privacy and API key

Your OpenAI API key is stored in this plugin's Obsidian settings data for the vault. Audio recordings and transcript text are sent to OpenAI when you run a transcription or summary action. The plugin does not collect telemetry.

## Submission notes

This plugin is designed for existing files only. It does not record audio, run in the background, or watch folders. It adds commands to the file context menu for supported audio extensions.

## Development

```bash
npm install
npm run build
```

For local testing, copy or symlink this folder into:

```text
<vault>/.obsidian/plugins/meeting-notes
```

Then enable the plugin in Obsidian settings.
