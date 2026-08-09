import { describe, expect, it, vi } from 'vitest';
import {
  extractUsage,
  ResponseNormalizerService,
} from '../src/gateway/response-normalizer.service';

describe('response normalization', () => {
  it('uses a conservative estimate for CJK content when upstream usage is absent', () => {
    const usage = extractUsage(
      { choices: [{ message: { content: '這是一段中文回答' } }] },
      { messages: [{ role: 'user', content: '請詳細解釋這個問題' }] },
    );
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(18);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(16);
  });

  it('hides upstream model, id, and fingerprint', async () => {
    const service = new ResponseNormalizerService();
    const result = await service.buffered(
      {
        response: new Response(
          JSON.stringify({
            id: 'upstream-request-id',
            model: 'secret-upstream-model',
            system_fingerprint: 'secret-provider-fingerprint',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
        wireFormat: 'openai-chat',
        requestedStream: false,
      },
      'chat',
      'public-alias',
      'request-12345678',
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    expect(result.json.model).toBe('public-alias');
    expect(result.json.id).not.toBe('upstream-request-id');
    expect(result.json.system_fingerprint).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, estimated: false });
  });

  it('rejects an upstream error hidden inside a success response', async () => {
    const service = new ResponseNormalizerService();
    await expect(
      service.buffered(
        {
          response: new Response(JSON.stringify({ error: { message: 'raw secret error' } })),
          wireFormat: 'openai-chat',
          requestedStream: false,
        },
        'chat',
        'alias',
        'request-12345678',
        {},
      ),
    ).rejects.toMatchObject({ name: 'ProviderError', category: 'protocol' });
  });

  it('preflights the first valid SSE event before exposing a stream', async () => {
    const service = new ResponseNormalizerService();
    const payload = `data: ${JSON.stringify({ id: 'private', model: 'private', choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    const ready = await service.preflight(
      {
        response: new Response(payload, { headers: { 'content-type': 'text/event-stream' } }),
        wireFormat: 'openai-chat',
        requestedStream: true,
      },
      'chat',
      'alias',
      'request-12345678',
      {},
    );
    expect(await ready.response.text()).toBe(payload);
  });

  it('uses one local response id across Responses created, delta, and completed events', async () => {
    const service = new ResponseNormalizerService();
    const frames = [
      {
        type: 'response.created',
        response: { id: 'upstream-id', object: 'response', model: 'private', output: [] },
      },
      {
        type: 'response.output_text.delta',
        response_id: 'upstream-id',
        item_id: 'keep-item',
        delta: 'hi',
      },
      {
        type: 'response.completed',
        response: {
          id: 'upstream-id',
          object: 'response',
          model: 'private',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
    const stream = service.stream(
      {
        response: new Response(frames, { headers: { 'content-type': 'text/event-stream' } }),
        wireFormat: 'openai-responses',
        requestedStream: true,
      },
      'responses',
      'public-model',
      'request-12345678',
      {},
      async () => undefined,
      async () => undefined,
    );
    const output = await new Response(stream).text();
    const payloads = output
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const created = payloads[0]?.response as Record<string, unknown>;
    const delta = payloads[1] as Record<string, unknown>;
    const completed = payloads[2]?.response as Record<string, unknown>;
    expect(created.id).toBe('resp_request12345678');
    expect(delta.response_id).toBe(created.id);
    expect(completed.id).toBe(created.id);
    expect(delta.item_id).toBe('keep-item');
  });
});
