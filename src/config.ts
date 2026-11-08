import { defaultTemporaryWavRoot } from "./tts/temp-wav.ts";
import { executableName, resolveToolPath } from "./tools.ts";

export type TalkPiShortcutConfig = {
  sendTranscriptKey: string;
  insertTranscriptKey: string;
  muteKey: string;
};

export type TalkPiPiperConfig = {
  binaryPath: string;
  modelPath: string;
  outputDir: string;
};

export type TalkPiWhisperConfig = {
  modelPath: string;
  modelUrl: string;
};

export type TalkPiConfig = {
  shortcuts: TalkPiShortcutConfig;
  piper: TalkPiPiperConfig;
  whisper: TalkPiWhisperConfig;
};

const DEFAULT_SHORTCUTS: TalkPiShortcutConfig = {
  sendTranscriptKey: "f9",
  insertTranscriptKey: "f10",
  muteKey: "f8",
};

const DEFAULT_WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function normalizedPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultPiperModelPath(env: NodeJS.ProcessEnv): string {
  return resolveToolPath(["piper", "models", "pt_BR-faber-medium.onnx"], { env });
}

function defaultWhisperModelPath(env: NodeJS.ProcessEnv): string {
  return resolveToolPath(["whisper", "models", "ggml-base.bin"], { env });
}

function resolveShortcuts(env: NodeJS.ProcessEnv): TalkPiShortcutConfig {
  const sendTranscriptKey = normalized(env.TALK_PI_SEND_TRANSCRIPT_KEY) ?? DEFAULT_SHORTCUTS.sendTranscriptKey;
  const insertTranscriptKey = normalized(env.TALK_PI_INSERT_TRANSCRIPT_KEY) ?? DEFAULT_SHORTCUTS.insertTranscriptKey;
  const muteKey = normalized(env.TALK_PI_MUTE_KEY) ?? DEFAULT_SHORTCUTS.muteKey;

  if (new Set([sendTranscriptKey, insertTranscriptKey, muteKey]).size !== 3) {
    console.warn(
      `[talk-pi] Shortcut conflict: TALK_PI_SEND_TRANSCRIPT_KEY, TALK_PI_INSERT_TRANSCRIPT_KEY and TALK_PI_MUTE_KEY must be distinct. Using defaults.`,
    );
    return DEFAULT_SHORTCUTS;
  }

  return {
    sendTranscriptKey,
    insertTranscriptKey,
    muteKey,
  };
}

export function loadTalkPiConfig(env: NodeJS.ProcessEnv = process.env): TalkPiConfig {
  return {
    shortcuts: resolveShortcuts(env),
    piper: {
      binaryPath: normalizedPath(env.TALK_PI_PIPER_BIN) ?? resolveToolPath(["piper", executableName("piper")], { env }),
      modelPath: normalizedPath(env.TALK_PI_PIPER_MODEL_PATH) ?? defaultPiperModelPath(env),
      outputDir: normalizedPath(env.TALK_PI_TTS_OUTPUT_DIR) ?? defaultTemporaryWavRoot(),
    },
    whisper: {
      modelPath: normalizedPath(env.TALK_PI_WHISPER_MODEL_PATH) ?? defaultWhisperModelPath(env),
      modelUrl: normalizedPath(env.TALK_PI_WHISPER_MODEL_URL) ?? DEFAULT_WHISPER_MODEL_URL,
    },
  };
}
