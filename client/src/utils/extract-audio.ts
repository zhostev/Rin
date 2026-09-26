/**
 * 从视频 Blob 中提取音轨：浏览器内解码 → 重采样为 16kHz 单声道 → WAV。
 *
 * 用途：AI Studio 转录。后端转录（Whisper）只接受纯音频资产，用户选视频时，
 * 在提交任务前先在本地把音轨抽出来，上传为新的音频资产，再用新资产 id 建任务。
 *
 * 注意：
 * - decodeAudioData 需要把整个文件读进内存，输入体积有上限（移动端尤其敏感）。
 * - 提取时长上限与后端转录上限对齐（60 分钟），避免产生无意义的大文件。
 */

export const EXTRACT_TARGET_SAMPLE_RATE = 16000;
/** 最多提取的音频时长（分钟），与后端转录 maxMinutes 硬上限对齐。 */
export const EXTRACT_MAX_MINUTES = 60;
/** 输入视频体积上限（decodeAudioData 全文件进内存，移动端再大容易崩标签页）。 */
export const EXTRACT_MAX_INPUT_BYTES = 500 * 1024 * 1024;

export type ExtractAudioErrorCode =
  | "empty"
  | "too_large"
  | "no_audio_track"
  | "decode_failed"
  | "unsupported";

export class ExtractAudioError extends Error {
  readonly code: ExtractAudioErrorCode;
  constructor(code: ExtractAudioErrorCode, message: string) {
    super(message);
    this.name = "ExtractAudioError";
    this.code = code;
  }
}

export interface ExtractAudioProgress {
  phase: "decode" | "render" | "encode";
  /** 0..1；解码/渲染阶段浏览器不给进度，为 null（indeterminate）。 */
  ratio: number | null;
}

export interface ExtractAudioOptions {
  maxMinutes?: number;
  onProgress?: (progress: ExtractAudioProgress) => void;
}

/**
 * 按 maxMinutes 计算实际保留时长（秒）。纯函数。
 */
export function cappedDurationSeconds(durationSec: number, maxMinutes: number = EXTRACT_MAX_MINUTES): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(durationSec, Math.max(0, maxMinutes) * 60);
}

/**
 * Float32 单声道采样 → 16-bit PCM WAV Blob。纯函数。
 */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function getAudioContextClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ?? null;
}

/**
 * 从视频 Blob 提取音轨，返回 16kHz 单声道 WAV Blob。
 * 抛 ExtractAudioError（code 可用于映射文案）。
 */
export async function extractAudioFromVideo(
  videoBlob: Blob,
  options: ExtractAudioOptions = {},
): Promise<Blob> {
  const { maxMinutes = EXTRACT_MAX_MINUTES, onProgress } = options;

  if (videoBlob.size === 0) {
    throw new ExtractAudioError("empty", "empty video blob");
  }
  if (videoBlob.size > EXTRACT_MAX_INPUT_BYTES) {
    throw new ExtractAudioError(
      "too_large",
      `video blob ${videoBlob.size} bytes exceeds ${EXTRACT_MAX_INPUT_BYTES} bytes`,
    );
  }
  const AC = getAudioContextClass();
  if (!AC) {
    throw new ExtractAudioError("unsupported", "Web Audio API not available");
  }

  onProgress?.({ phase: "decode", ratio: null });
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await videoBlob.arrayBuffer());
  } catch (error) {
    throw new ExtractAudioError(
      "decode_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    void ctx.close().catch(() => undefined);
  }

  if (decoded.numberOfChannels === 0 || !(decoded.duration > 0.1)) {
    throw new ExtractAudioError("no_audio_track", "decoded audio has no channels");
  }

  const seconds = cappedDurationSeconds(decoded.duration, maxMinutes);
  onProgress?.({ phase: "render", ratio: null });
  const targetFrames = Math.max(1, Math.ceil(seconds * EXTRACT_TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, targetFrames, EXTRACT_TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  onProgress?.({ phase: "encode", ratio: null });
  const mono = rendered.getChannelData(0).slice(0, targetFrames);
  return encodeWavBlob(mono, EXTRACT_TARGET_SAMPLE_RATE);
}
