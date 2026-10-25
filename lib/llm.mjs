// Optional local language model. Ollama, llama.cpp (llama-server) and vLLM all expose the same
// OpenAI-style /v1/chat/completions endpoint, so switching engines is a .env change only.
// Off unless LLM_URL is set. Never throws: any failure (off, slow, bad JSON) returns null and
// the caller uses its non-AI path. The model only reads and writes text; code decides everything.
export const llmEnabled = () => !!process.env.LLM_URL;
export const llmModel = () => process.env.LLM_MODEL || 'gemma3:4b';

export async function ask({ system, prompt, schema, maxTokens = 400 }) {
  const base = process.env.LLM_URL;
  if (!base) return null;
  try {
    // A Vercel Function must use authenticated HTTPS inference. A private
    // Wi-Fi Ollama URL is valid for local development only.
    if (process.env.VERCEL && (new URL(base).protocol !== 'https:' || !process.env.LLM_API_KEY)) return null;
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } }
      }),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 15_000)
    });
    if (!response.ok) return null;
    const content = String((await response.json())?.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '') // Qwen3 "thinking" text, if left on
      .replace(/^```(?:json)?\s*|\s*```$/g, '')
      .trim();
    const value = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Numbers in a text, sorted. Devanagari (०-९) and Telugu (౦-౯) digits count as 0-9, and
// "2,000" is 2000. Used to reject a model's text that changed a date, price, phone or code.
export const numbersOf = text => (String(text)
  .replace(/[०-९]/g, ch => String(ch.charCodeAt(0) - 0x0966))
  .replace(/[౦-౯]/g, ch => String(ch.charCodeAt(0) - 0x0C66))
  .replace(/(\d),(?=\d)/g, '$1')
  .match(/\d+/g) || []).map(Number).sort((a, b) => a - b);
