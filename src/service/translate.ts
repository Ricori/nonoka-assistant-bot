import axios from 'axios';
import { config } from '@/core/config';
import { logError } from '@/core/logger';

export async function translateText(text: string, lang = 'cn'): Promise<string | null> {
  const { baseUrl, apiKey } = config.nonokaService;
  if (!baseUrl || !apiKey) return null;
  try {
    const ret = await axios.post(
      `${baseUrl}/llm/translate?apikey=${apiKey}`,
      { text, lang },
      { timeout: 50000 },
    );
    return ret.data?.text ?? null;
  } catch (err) {
    logError('Translate', err instanceof Error ? err.message : String(err));
    return null;
  }
}
