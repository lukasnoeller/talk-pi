import path from "node:path";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui";
import { insertTranscriptIntoEditor } from "./src/input/editor-insert.ts";
import { runVoiceShortcut } from "./src/input/voice-shortcut-interrupt.ts";
import { createShortcutDebounce } from "./src/input/f5-shortcut.ts";
import { createMuteState } from "./src/ui/mute-state.ts";
import { openUnifiedTalkMenu } from "./src/ui/unified-talk-menu.ts";
import { formatFooterStatusFromState } from "./src/ui/footer-status.ts";
import { extractAssistantReplyText } from "./src/tts/assistant-reply.ts";
import { createPlaybackQueue } from "./src/tts/playback-queue.ts";
import { resolvePiperRuntimeConfig, resolvePiperVoiceSelection, setPiperOutputKind, setPiperVoiceModel, friendlyModelLabel, type PiperPreferenceResolution } from "./src/tts/piper-preferences.ts";
import { transcribeAudioFile } from "./src/voice/offline-whisper.ts";
import { createVoiceCaptureSession } from "./src/voice/voice-capture.ts";
import { loadTalkPiConfig } from "./src/config.ts";
import { loadVoiceSettingsStartupState, persistVoiceSettingsMute } from "./src/voice-settings.ts";
import { ensurePiperTool } from "./src/tools-bootstrap.ts";

type ExtensionContext = {
  ui: {
    setStatus(id: string, value: string): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(title: string, options: string[], opts?: { overlay?: boolean }): Promise<string | undefined>;
    pasteToEditor(text: string): void;
    isIdle?: () => boolean;
    getEditorText?: () => string;
    setEditorText?: (text: string) => void;
    custom?: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => {
        render(width: number): string[];
        handleInput?(data: string): void;
        invalidate?(): void;
      },
      options?: { overlay?: boolean },
    ) => Promise<T>;
    setEditorComponent?: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown) => unknown,
    ) => void;
  };
};

type ExtensionAPI = {
  on(event: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void;
  registerCommand?(name: string, command: { description: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }): void;
};

export default function (pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | undefined;
  const config = loadTalkPiConfig();
  const shortcutConfig = config.shortcuts;
  let muteState = createMuteState();
  let piperSelection: PiperPreferenceResolution | undefined;

  const voiceSession = createVoiceCaptureSession(
    (message, level) => {
      activeCtx?.ui.notify(message, level);
    },
    {
      insertTranscriptKey: shortcutConfig.insertTranscriptKey,
      transcribe: (filePath: string) => transcribeAudioFile(filePath, {
        ...config.whisper,
        language: process.env.TALK_PI_WHISPER_LANGUAGE ?? piperSelection?.whisperLanguage ?? "pt",
        onNotify: (message, level) => activeCtx?.ui.notify(message, level ?? "info"),
      }),
    },
  );

  let speechStatus = "";
  const sendTranscriptDebounce = createShortcutDebounce();
  const insertTranscriptDebounce = createShortcutDebounce();
  const muteDebounce = createShortcutDebounce();

  const playbackQueue = createPlaybackQueue({
    isRecordingBlocked: () => voiceSession.status !== "idle",
    onNotify: (message, level) => {
      activeCtx?.ui.notify(message, level);
    },
    onStatus: (message) => {
      speechStatus = message;
      if (activeCtx) {
        syncStatus(activeCtx);
      }
    },
    piper: async () => ({
      ...(await resolvePiperRuntimeConfig({
        ...config.piper,
        modelPath: piperSelection?.modelPath ?? config.piper.modelPath,
        env: process.env,
      })),
      onNotify: (message: string, level?: "info" | "warning" | "error") => activeCtx?.ui.notify(message, level ?? "info"),
    }),
  });

  const getFooterStatusText = (): string => formatFooterStatusFromState({
    voiceStatus: voiceSession.status,
    voiceMessage: voiceSession.message,
    speechStatus,
    muted: muteState.isMuted(),
    playing: playbackQueue.isPlaying(),
  });

  const getMenuStatusText = (): string => {
    const base = getFooterStatusText();
    const modelLabel = piperSelection?.activeModel?.label ?? path.basename(config.piper.modelPath);
    const outputLabel = piperSelection?.outputLabel ?? "Portuguese";
    return `${base} | Voice Language: ${outputLabel} | Piper: ${modelLabel} | ${shortcutConfig.sendTranscriptKey.toUpperCase()} sends directly | ${shortcutConfig.insertTranscriptKey.toUpperCase()} inserts / toggles voice`;
  };

  const syncStatus = (ctx: ExtensionContext) => {
    const status = voiceSession.status;
    void playbackQueue.setRecordingBlocked(status !== "idle");
    if (playbackQueue.isMuted() !== muteState.isMuted()) {
      void playbackQueue.setMuted(muteState.isMuted());
    }
    ctx.ui.setStatus("talk-pi", getFooterStatusText());
  };

  const setMuteState = async (muted: boolean, ctx: ExtensionContext): Promise<void> => {
    if (muted) {
      muteState.mute();
    } else {
      muteState.unmute();
    }
    await persistVoiceSettingsMute(muted);
    await playbackQueue.setMuted(muted);
    syncStatus(ctx);
  };

  const toggleMute = async (ctx: ExtensionContext): Promise<void> => {
    const nextMuted = !muteState.isMuted();
    await setMuteState(nextMuted, ctx);
    ctx.ui.notify(nextMuted ? "Extension muted" : "Extension unmuted", "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    const startupState = await loadVoiceSettingsStartupState();
    piperSelection = startupState.selection;
    muteState = startupState.muteState;
    await playbackQueue.setMuted(muteState.isMuted());
    syncStatus(ctx);

    void ensurePiperTool({
      env: process.env,
      onNotify: (message, level) => ctx.ui.notify(message, level ?? "info"),
    }).then(async () => {
      piperSelection = await resolvePiperVoiceSelection();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
      console.error(error);
    });

    ctx.ui.setEditorComponent?.((tui, theme, keybindings) => {
      class PushToTalkEditor extends CustomEditor {
        private recording = false;
        private recordingShortcut: "send" | "insert" | undefined;

        constructor() {
          super(tui as never, theme as never, keybindings as never);
        }

        private toggleVoiceCapture(shortcut: "send" | "insert"): void {
          if (!this.recording) {
            this.recording = true;
            this.recordingShortcut = shortcut;
            void voiceSession
              .start()
              .then(() => syncStatus(activeCtx ?? ctx))
              .catch((error) => {
                this.recording = false;
                this.recordingShortcut = undefined;
                activeCtx?.ui.notify(error instanceof Error ? error.message : "Start failed", "error");
                syncStatus(activeCtx ?? ctx);
              });
            return;
          }

          this.recording = false;
          const currentShortcut = this.recordingShortcut;
          this.recordingShortcut = undefined;
          const stopPromise = voiceSession.stop();
          syncStatus(activeCtx ?? ctx);
          void stopPromise
            .then((text) => {
              const transcript = String(text ?? "").trim();
              if (transcript) {
                if (currentShortcut === "send") {
                  const deliverAs = activeCtx?.isIdle?.() === false ? { deliverAs: "followUp" as const } : undefined;
                  pi.sendUserMessage(transcript, deliverAs);
                  activeCtx?.ui.notify(`Transcript sent`, "info");
                } else if (!insertTranscriptIntoEditor(activeCtx ?? ctx, transcript)) {
                  activeCtx?.ui.pasteToEditor(transcript);
                  activeCtx?.ui.notify(`Transcript inserted`, "info");
                } else {
                  activeCtx?.ui.notify(`Transcript inserted`, "info");
                }
              }
              syncStatus(activeCtx ?? ctx);
            })
            .catch((error) => {
              activeCtx?.ui.notify(error instanceof Error ? error.message : "Stop failed", "error");
              syncStatus(activeCtx ?? ctx);
            });
        }

        handleInput(data: string): void {
          if (isKeyRelease(data) || data.includes(":2")) {
            return;
          }

          if (matchesKey(data, "escape") && playbackQueue.isPlaying()) {
            void playbackQueue.stop().then(() => syncStatus(activeCtx ?? ctx));
            return;
          }

          if (matchesKey(data, shortcutConfig.muteKey) && muteDebounce.allow()) {
            void toggleMute(activeCtx ?? ctx);
            return;
          }

          const isInsertTranscript = matchesKey(data, shortcutConfig.insertTranscriptKey) && insertTranscriptDebounce.allow();
          const isSendTranscript = matchesKey(data, shortcutConfig.sendTranscriptKey) && sendTranscriptDebounce.allow();
          if (isInsertTranscript) {
            void runVoiceShortcut("insert", {
              isPlaybackPlaying: () => playbackQueue.isPlaying(),
              stopPlayback: () => playbackQueue.stop().then(() => syncStatus(activeCtx ?? ctx)),
              toggleVoiceCapture: (shortcut) => this.toggleVoiceCapture(shortcut),
            });
            return;
          }
          if (isSendTranscript) {
            void runVoiceShortcut("send", {
              isPlaybackPlaying: () => playbackQueue.isPlaying(),
              stopPlayback: () => playbackQueue.stop().then(() => syncStatus(activeCtx ?? ctx)),
              toggleVoiceCapture: (shortcut) => this.toggleVoiceCapture(shortcut),
            });
            return;
          }

          super.handleInput(data);
        }
      }

      return new PushToTalkEditor();
    });
  });

  pi.on("message_end", async (event) => {
    const text = extractAssistantReplyText(event?.message);
    if (text) {
      void playbackQueue.enqueue(text);
    }
  });

  pi.registerCommand?.("talk-pi", {
    description: "Open the unified talk menu",
    handler: async (_args, ctx) => {
      activeCtx = ctx;
      syncStatus(ctx);
      await openUnifiedTalkMenu(ctx, {
        isMuted: () => muteState.isMuted(),
        setMuted: async (nextMuted) => {
          await setMuteState(nextMuted, ctx);
        },
        getStatusText: () => getMenuStatusText(),
        chooseVoiceLanguage: async () => {
          const selection = piperSelection ?? await resolvePiperVoiceSelection();
          if (!selection.models.length) {
            ctx.ui.notify("No Piper models found", "warning");
            return;
          }

          const englishModels = selection.models.filter((model) => model.language === "english");
          const portugueseModels = selection.models.filter((model) => model.language !== "english");
          const portugueseModel = portugueseModels[0] ?? selection.activeModel ?? selection.models[0];
          const isActivePortuguese = selection.activeOutputKind === "default";
          const choices = [
            ...englishModels.map((model) => {
              const isActive = selection.activeOutputKind === "english" && selection.activeModel?.id === model.id;
              return { label: `English - ${friendlyModelLabel(model.path)}${isActive ? " (active)" : ""}`, kind: "english" as const, model };
            }),
            ...portugueseModels.map((model) => {
              const isActive = isActivePortuguese && (selection.activeModel?.id === model.id || portugueseModels.length === 1);
              return { label: `Portuguese - ${friendlyModelLabel(model.path)}${isActive ? " (active)" : ""}`, kind: "default" as const, model };
            }),
          ].filter((choice) => Boolean(choice.model));

          if (!choices.length) {
            choices.push({ label: `Portuguese${isActivePortuguese ? " (active)" : ""}`, kind: "default" as const, model: portugueseModel! });
          }

          const labels = choices.map((choice) => choice.label);
          const choice = await ctx.ui.select("Choose Voice Language", labels, { overlay: true });
          const index = labels.indexOf(String(choice ?? ""));
          const selected = index >= 0 ? choices[index] : undefined;
          if (!selected || !selected.model) return;

          await setPiperVoiceModel(selected.model.id);
          await setPiperOutputKind(selected.kind);
          piperSelection = await resolvePiperVoiceSelection();
          const notifyLabel = selected.kind === "english" ? `English - ${friendlyModelLabel(selected.model.path)}` : `Portuguese - ${friendlyModelLabel(selected.model.path)}`;
          ctx.ui.notify(`Voice language set to ${notifyLabel}`, "info");
          syncStatus(ctx);
        },
      });
      syncStatus(ctx);
    },
  });
}
