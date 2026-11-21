import axios from 'axios';
import { config } from '@/core/config';
import { logError } from '@/core/logger';

export type TTSLang = 'ja' | 'zh';

export interface TTSOptions {
  lang?: TTSLang;
  speed?: number;
  seed?: number;
}

export interface TTSAudio {
  dataUri: string;
  fileName: string;
}

export const TTS_MAX_TEXT_LENGTH = 300;
export const TTS_MAX_TOTAL_LENGTH = 900;

const BREAK_PATTERNS = [/(?<=[。！？!?…；;\n])/, /(?<=[，,、：:])/];

function packBy(text: string, pattern: RegExp, limit: number) {
  const chunks: string[] = [];
  let buf = '';
  for (const unit of text.split(pattern)) {
    if (buf && buf.length + unit.length > limit) {
      chunks.push(buf);
      buf = '';
    }
    buf += unit;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function hardSlice(text: string, limit: number) {
  const chunks: string[] = [];
  let buf = '';
  for (const char of text) {
    if (buf.length + char.length > limit) {
      chunks.push(buf);
      buf = '';
    }
    buf += char;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function splitForTTS(text: string, limit = TTS_MAX_TEXT_LENGTH) {
  let chunks = [text.trim()];
  for (const pattern of BREAK_PATTERNS) {
    if (chunks.every((chunk) => chunk.length <= limit)) break;
    chunks = chunks.flatMap((chunk) => (chunk.length <= limit ? [chunk] : packBy(chunk, pattern, limit)));
  }
  return chunks
    .flatMap((chunk) => (chunk.length <= limit ? [chunk] : hardSlice(chunk, limit)))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function inferAudioExt(contentType?: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('ogg') || ct.includes('opus')) return 'ogg';
  if (ct.includes('silk')) return 'silk';
  return 'wav';
}

export async function getTTSAudio(text: string, options: TTSOptions = {}): Promise<TTSAudio | null> {
  const input = text.trim();
  if (!input || input.length > TTS_MAX_TEXT_LENGTH) return null;

  const { baseUrl, apiKey } = config.nonokaService;
  if (!baseUrl || !apiKey) return null;

  try {
    const response = await axios.post(
      `${baseUrl}/v1/audio/speech`,
      { input, ...options },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 180000,
      },
    );
    const ext = inferAudioExt(String(response.headers['content-type'] ?? ''));
    const base64Audio = Buffer.from(response.data).toString('base64');
    return { dataUri: `base64://${base64Audio}`, fileName: `tts.${ext}` };
  } catch (err) {
    logError('TTS', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function sendSegmentedVoice(
  text: string,
  send: (audio: TTSAudio) => Promise<unknown>,
  options: TTSOptions = {},
): Promise<{ sent: number; rest: string }> {
  const input = text.trim();
  if (!input) return { sent: 0, rest: '' };
  if (input.length > TTS_MAX_TOTAL_LENGTH) return { sent: 0, rest: input };

  const chunks = splitForTTS(input);
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31) + 1;

  for (let i = 0; i < chunks.length; i += 1) {
    const audio = await getTTSAudio(chunks[i], { ...options, seed });
    if (!audio) return { sent: i, rest: chunks.slice(i).join('') };
    await send(audio);
  }
  return { sent: chunks.length, rest: '' };
}
