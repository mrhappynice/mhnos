// src/system/llmClient.js
export async function streamChat({
  provider,
  model,
  apiKey,
  baseURL,
  messages,
  onDelta,
  onDone,
  onError
}) {
  const url = `${baseURL}/v1/chat/completions`;

  const headers = {
    "Content-Type": "application/json"
  };

  if (provider === "openai" || provider === "openrouter") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "OS App Builder";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      messages
    })
  });

  if (!res.ok) {
    onError?.(await res.text());
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      if (line === "data: [DONE]") {
        onDone?.();
        return;
      }

      try {
        const json = JSON.parse(line.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {}
    }
  }
}
