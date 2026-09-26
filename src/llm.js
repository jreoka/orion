// Orion LLM client: OpenAI-compatible chat completions with streaming.
// Works with OpenAI, or any OpenAI-compatible endpoint (Ollama, vLLM,
// OpenRouter, LiteLLM, …) as long as it speaks /chat/completions + SSE.
export const LLM_NOT_CONFIGURED =
  'LLM not configured — ask the admin to set it in the admin panel.';

const STALL_TIMEOUT_MS = 90 * 1000; // no SSE data for this long → abort
const RETRY_DELAYS_MS = [2000, 8000]; // before 2nd and 3rd attempts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream a chat completion.
 * @returns {Promise<{content: string, toolCalls: Array<{id, type, function:{name, arguments}}>}>}
 * OpenAI streams tool calls in fragments keyed by `index`; we reassemble
 * id / name / arguments here so callers get whole calls.
 *
 * Reliability: the initial POST is retried up to 2 extra times on 429/5xx
 * with backoff. If the stream stalls (no data for 90s) the fetch is
 * aborted and an LLMStallError is thrown. Thrown errors carry
 * `partialContent` with whatever text arrived before the failure so the
 * caller can persist it.
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
  const body = JSON.stringify({ model, messages, tools, stream: true });

  let res;
  let attempt = 0;

  // Chain the caller's signal with our own stall abort BEFORE the fetch so
  // both a client disconnect and a stream stall actually cancel the request.
  const stallCtrl = new AbortController();
  const onExternalAbort = () => stallCtrl.abort();
  if (signal) {
    if (signal.aborted) stallCtrl.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  for (;;) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: stallCtrl.signal,
      });
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (e.name === 'AbortError') throw e;
      throw new Error(`Could not reach the LLM endpoint (${url}): ${e.message}`);
    }

    if (res.ok && res.body) break;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      try {
        await res.body?.cancel?.();
      } catch {
        /* ignore */
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt++;
      continue;
    }
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
  let lastDataAt = Date.now();
  let stalled = false;
  const toolCalls = []; // sparse, indexed by the provider's `index`

  const stallTimer = setInterval(() => {
    if (Date.now() - lastDataAt > STALL_TIMEOUT_MS && !stalled) {
      stalled = true;
      stallCtrl.abort();
    }
  }, 5000);
  stallTimer.unref?.();

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
      lastDataAt = Date.now();
      content += delta.content;
      try {
        onToken?.(delta.content);
      } catch {
        /* a throwing onToken must not kill the stream */
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      lastDataAt = Date.now();
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

  try {
    for (;;) {
      let read;
      try {
        read = await reader.read();
      } catch (e) {
        if (stalled || stallCtrl.signal.aborted) break;
        e.partialContent = content;
        throw e;
      }
      if (read.done) break;
      if (stalled) break;
      buf += decoder.decode(read.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
  } finally {
    clearInterval(stallTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  if (stalled) {
    throw Object.assign(
      new Error('The model stopped responding (no data for 90s)'),
      { name: 'LLMStallError', partialContent: content }
    );
  }

  return {
    content,
    toolCalls: toolCalls
      .filter(Boolean)
      .map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
  };
}
