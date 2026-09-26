// Orion LLM client: OpenAI-compatible chat completions with streaming.
// Works with OpenAI, or any OpenAI-compatible endpoint (Ollama, vLLM,
// OpenRouter, LiteLLM, …) as long as it speaks /chat/completions + SSE.
export const LLM_NOT_CONFIGURED =
  'LLM not configured — ask the admin to set it in the admin panel.';

/**
 * Stream a chat completion.
 * @returns {Promise<{content: string, toolCalls: Array<{id, type, function:{name, arguments}}>}>}
 * OpenAI streams tool calls in fragments keyed by `index`; we reassemble
 * id / name / arguments here so callers get whole calls.
 */
export async function streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  onToken,
  signal,
}) {
  if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);

  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools, stream: true }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Could not reach the LLM endpoint (${url}): ${e.message}`);
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        detail = JSON.parse(text)?.error?.message || text;
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      `LLM request failed (HTTP ${res.status})${detail ? ': ' + String(detail).slice(0, 500) : ''}`
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = []; // sparse, indexed by the provider's `index`

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return; // ignore malformed heartbeat lines
    }
    const delta = payload?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      try {
        onToken?.(delta.content);
      } catch {
        /* a throwing onToken must not kill the stream */
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: '', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }

  return {
    content,
    toolCalls: toolCalls
      .filter(Boolean)
      .map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
  };
}
