/** Yields one parsed JSON value per line as the response streams in. */
export async function* readNdjson(response: Response): AsyncGenerator<unknown> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    for (const line of (await response.text()).split('\n')) if (line.trim()) yield JSON.parse(line);
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield JSON.parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}
