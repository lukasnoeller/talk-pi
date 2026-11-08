import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveToolPath } from "../tools.ts";

type WhisperModule = typeof import("whisper-cpp-node");

let whisperModule: WhisperModule | undefined;

function loadWhisperModule(): WhisperModule {
  if (!whisperModule) {
    try {
      whisperModule = createRequire(import.meta.url)("whisper-cpp-node") as WhisperModule;
    } catch {
      throw new Error("whisper-cpp-node not installed. Install dependencies to use voice transcription.");
    }
  }
  return whisperModule;
}

const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

export type WhisperResult = {
  text: string;
  language?: string;
  segments: Array<{ start: string; end: string; text: string }>;
};

export type WhisperConfig = {
  modelPath?: string;
  modelUrl?: string;
  language?: string;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
};

function defaultModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TALK_PI_WHISPER_MODEL_PATH ?? resolveToolPath(["whisper", "models", "ggml-base.bin"], { env });
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.unlink(targetPath).catch(() => undefined);

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);
    const cleanup = () => void fsp.unlink(targetPath).catch(() => undefined);
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        file.close(cleanup);
        downloadFile(nextUrl, targetPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close(cleanup);
        reject(new Error(`Model download failed: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.once("finish", () => {
        file.close((error) => {
          if (error) {
            cleanup();
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    request.on("error", (error) => {
      file.close(cleanup);
      reject(error);
    });

    file.on("error", (error) => {
      request.destroy(error);
      cleanup();
      reject(error);
    });
  });
}

export async function ensureWhisperModel(options: WhisperConfig = {}): Promise<string> {
  const env = options.env ?? process.env;
  const modelPath = options.modelPath?.trim() || defaultModelPath(env);
  const modelUrl = options.modelUrl?.trim() || env.TALK_PI_WHISPER_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
  try {
    const stats = await fsp.stat(modelPath);
    if (stats.size > 0) return modelPath;
  } catch {
    // download below
  }

  options.onNotify?.(`Talk-pi: Downloading 📥 Whisper model`, "info");
  await downloadFile(modelUrl, modelPath);
  return modelPath;
}

let cachedContext: ReturnType<WhisperModule["createWhisperContext"]> | undefined;
let cachedModelPath: string | undefined;

async function createContextWithRetry(modelPath: string, options: WhisperConfig, retry = true): Promise<ReturnType<WhisperModule["createWhisperContext"]>> {
  const { createWhisperContext } = loadWhisperModule();
  try {
    return createWhisperContext({ model: modelPath, use_gpu: false, no_prints: true });
  } catch (error) {
    if (!retry) throw error;
    await fsp.unlink(modelPath).catch(() => undefined);
    options.onNotify?.(`Talk-pi: Downloading 📥 Whisper model`, "info");
    const refreshedPath = await ensureWhisperModel(options);
    return createContextWithRetry(refreshedPath, options, false);
  }
}

async function transcribeWithAddon(filePath: string, options: WhisperConfig): Promise<WhisperResult> {
  const modelPath = await ensureWhisperModel(options);
  const { transcribeAsync } = loadWhisperModule();

  if (!cachedContext || cachedModelPath !== modelPath) {
    cachedContext?.free?.();
    cachedContext = await createContextWithRetry(modelPath, options);
    cachedModelPath = modelPath;
  }

  const result = await transcribeAsync(cachedContext, {
    fname_inp: filePath,
    language: options.language?.trim().toLowerCase() || "pt",
    no_timestamps: false,
  });

  const segments = (result?.segments ?? []).map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: String(segment.text ?? "").trim(),
  }));
  const text = String(segments.map((segment) => segment.text).join(" ")).trim();
  return { text, language: result?.language, segments };
}

function resolveWhisperCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TALK_PI_WHISPER_CLI?.trim();
  if (explicit) return explicit;
  return resolveToolPath(["whisper", "whisper-cli"], { env });
}

async function runWhisperCli(cliPath: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`whisper-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

async function transcribeWithCli(filePath: string, options: WhisperConfig): Promise<WhisperResult> {
  const env = options.env ?? process.env;
  const modelPath = await ensureWhisperModel(options);
  const cliPath = options.cliPath?.trim() || resolveWhisperCliPath(env);
  const language = options.language?.trim().toLowerCase() || "pt";
  const threads = env.TALK_PI_WHISPER_THREADS?.trim() || "2";
  const outputBase = path.join(os.tmpdir(), `talk-pi-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outputJson = `${outputBase}.json`;

  options.onNotify?.(`Talk-pi: Transcribing with whisper-cli…`, "info");

  await runWhisperCli(cliPath, [
    "-m", modelPath,
    "-f", filePath,
    "-l", language,
    "-t", threads,
    "-oj",
    "-of", outputBase,
  ], 600000);

  let raw: string;
  try {
    raw = await fsp.readFile(outputJson, "utf8");
  } catch (error) {
    throw new Error(`whisper-cli did not produce ${outputJson}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fsp.unlink(outputJson).catch(() => undefined);
  }

  const parsed = JSON.parse(raw) as {
    result?: { language?: string };
    transcription?: Array<{
      text?: string;
      offsets?: { from?: number; to?: number };
      timestamps?: { from?: string; to?: string };
    }>;
  };

  const segments = (parsed.transcription ?? []).map((segment) => ({
    start: segment.offsets?.from != null ? String(segment.offsets.from) : (segment.timestamps?.from ?? ""),
    end: segment.offsets?.to != null ? String(segment.offsets.to) : (segment.timestamps?.to ?? ""),
    text: String(segment.text ?? "").trim(),
  }));
  const text = segments.map((segment) => segment.text).join(" ").trim();
  return { text, language: parsed.result?.language, segments };
}

export async function transcribeAudioFile(filePath: string, options: WhisperConfig = {}): Promise<WhisperResult> {
  try {
    return await transcribeWithAddon(filePath, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("whisper-cpp-node") ||
      message.includes("Unsupported platform") ||
      message.includes("Native binary not found") ||
      message.includes("Failed to load native addon")
    ) {
      return await transcribeWithCli(filePath, options);
    }
    throw error;
  }
}
