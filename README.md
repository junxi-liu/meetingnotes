# Meeting Notes

Meeting Notes is an Obsidian plugin for existing audio and Markdown files in your vault. Right-click a supported recording to transcribe or summarize it, or right-click a Markdown transcript to generate meeting notes from existing text.

The plugin creates the Markdown note immediately, then rewrites it with live progress as it prepares the file, calls OpenAI, finishes each chunk, and optionally creates the summary.

Progress updates are event-based plus a configurable heartbeat while long prepare, transcription, or summary requests are running. The OpenAI transcription request itself is synchronous; the plugin is not polling a separate OpenAI status endpoint.

## Right-click actions

The file context menu can show any combination of these actions:

- **Generate meeting notes**: uses your preset transcription model, diarization, summary, section, and note-creation settings.
- **Transcribe**
- **Transcribe (diarize)**
- **Transcribe and summary**
- **Transcribe and summary (diarize)**
- **Summary**: transcribes internally, then writes a summary-only note.
- **Summarize note**: appears on Markdown files, extracts the `## Transcript` section when present, and writes a summary from existing text. It can create a new note or rewrite the current Markdown note while keeping the original content at the end.

You can hide or show each action in settings.

## Note creation

The default note title is `{{date}}`. The date can come from the source file creation date or today's date, and the date format is configurable with tokens such as `YYYY-MM-DD` or `YYYYMMDD`.

Notes can be saved to the configured output folder or beside the source file. If enabled, the source recording is moved to the system trash after an audio note is generated successfully.

Generated notes are ordered as summary, transcript, error if any, progress, then properties. Metadata is rendered as a Markdown section at the end rather than YAML frontmatter at the top.

## Summary workflow

Summary generation uses a separate summary model setting, independent of the transcription model. By default, the plugin sends the full transcript to the summary model in one request, which is the recommended setting for long-context models such as `gpt-5.5`.

If a summary request is too large or fails, enable **Split transcript before summary**. That older workflow summarizes transcript parts first, then asks the summary model to combine the partial summaries.

The default summary prompt is generated from section toggles:

- Summary
- What was discussed
- Decisions made
- Next steps
- Task to do

Default summaries use Markdown subheaders for each selected section. List-style content is formatted as ordered lists, and **Task to do** items are formatted as Markdown checkboxes such as `- [ ] Follow up with Alex`. **Next steps** is meant for generalized guidance, while **Task to do** is meant for specific tasks.

Each default summary section can be renamed in settings. The prompt settings show the plugin default prompt and the current prompt built from your toggles and section names.

If you enter a custom **Summary prompt**, that prompt overrides the section toggles.

## Supported audio files

The OpenAI Audio API supports `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, and `webm`. Files below the upload limit are sent as-is. Larger files are decoded in Obsidian and split into 16 kHz mono WAV chunks before upload.

## OpenAI models

Settings let you choose:

- Transcription model: `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, or `whisper-1`.
- Diarization: when enabled, the plugin uses `gpt-4o-transcribe-diarize` with `response_format=diarized_json` and `chunking_strategy=auto`.
- Summary model: a general text or reasoning model for the Responses API, defaulting to `gpt-5.5`. The summary model dropdown can be refreshed from OpenAI's `GET /v1/models` endpoint using your API key, and filters out special-purpose models such as transcription, computer-use, search, image, embedding, Codex, and dated snapshot models.

Generated notes include transcription and summary usage in the final Properties section. Cost is estimated from usage returned by OpenAI and the plugin's built-in price table for known models; unknown model pricing is shown as unavailable.

## Privacy and API key

Your OpenAI API key is stored in this plugin's Obsidian settings data for the vault. Audio recordings and transcript text are sent to OpenAI when you run a transcription or summary action. The plugin does not collect telemetry.

## Submission notes

This plugin is designed for existing files only. It does not record audio, run in the background, or watch folders. It adds commands to the file context menu for supported audio extensions and Markdown transcript files.

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
