import { describe, expect, it } from "bun:test";
import {
  cappedDurationSeconds,
  encodeWavBlob,
  EXTRACT_MAX_MINUTES,
  ExtractAudioError,
} from "../extract-audio";

async function wavHeader(blob: Blob): Promise<DataView> {
  const buffer = await blob.arrayBuffer();
  return new DataView(buffer);
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

describe("extract-audio helpers", () => {
  it("caps the kept duration at maxMinutes", () => {
    expect(cappedDurationSeconds(30)).toBe(30);
    expect(cappedDurationSeconds(3600)).toBe(EXTRACT_MAX_MINUTES * 60);
    expect(cappedDurationSeconds(3600, 10)).toBe(600);
    expect(cappedDurationSeconds(0)).toBe(0);
    expect(cappedDurationSeconds(-5)).toBe(0);
    expect(cappedDurationSeconds(Number.NaN)).toBe(0);
  });

  it("writes a valid 16-bit mono PCM WAV header", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavBlob(samples, 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + samples.length * 2);

    const view = await wavHeader(blob);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
  });

  it("encodes sample values with clamping", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const view = await wavHeader(encodeWavBlob(samples, 16000));
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384); // 0.5 * 32767 rounded
    expect(view.getInt16(48, true)).toBe(-16383); // -0.5 * 32767 rounded
    expect(view.getInt16(50, true)).toBe(32767); // clamped
    expect(view.getInt16(52, true)).toBe(-32767); // clamped
  });

  it("ExtractAudioError carries its code", () => {
    const error = new ExtractAudioError("no_audio_track", "nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("no_audio_track");
  });
});
