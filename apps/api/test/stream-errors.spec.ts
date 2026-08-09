import { describe, expect, it, vi } from 'vitest';
import { ResponseNormalizerService } from '../src/gateway/response-normalizer.service';
import { safeStreamFailure } from '../src/gateway/v1.controller';

const decoder = new TextDecoder();

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result;
    result += decoder.decode(value, { stream: true });
  }
}

function responseStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function eventPayload(output: string, event: string): Record<string, unknown> {
  const block = output.split('\n\n').find((item) => item.startsWith(`event: ${event}\n`));
  if (!block) throw new Error(`Missing ${event} event`);
  const data = block.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`Missing ${event} data`);
  return JSON.parse(data.slice(6)) as Record<string, unknown>;
}

describe('controller safe stream failure frames', () => {
  it('creates an OpenAI Responses response.failed typed event', () => {
    const output = safeStreamFailure('responses', 'req-unsafe/<id>');
    const payload = eventPayload(output, 'response.failed');

    expect(payload).toMatchObject({
      type: 'response.failed',
      sequence_number: 0,
      response: {
        id: 'resp_requnsafeid',
        object: 'response',
        status: 'failed',
        error: {
          code: 'server_error',
          message: 'The model service is temporarily unavailable.',
        },
      },
    });
    expect(output).not.toContain('provider name');
    expect(output).not.toContain('upstream model');
  });

  it('creates a safe Chat Completions error followed by DONE', () => {
    const output = safeStreamFailure('chat', 'req-chat');
    const firstData = output.split('\n').find((line) => line.startsWith('data: {'));
    const payload = JSON.parse(firstData!.slice(6)) as Record<string, unknown>;

    expect(payload).toEqual({
      error: {
        message: 'The model service is temporarily unavailable.',
        type: 'server_error',
        param: null,
        code: 'provider_unavailable',
        request_id: 'req-chat',
      },
    });
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('normalizer stream failures', () => {
  it('emits only a system-owned response.failed event after Responses output has begun', async () => {
    const onComplete = vi.fn();
    const onFailure = vi.fn().mockResolvedValue(undefined);
    const upstreamDelta = {
      type: 'response.output_text.delta',
      sequence_number: 1,
      delta: 'partial',
      response_id: 'upstream-id',
    };
    const upstreamFailure = {
      type: 'response.failed',
      error: {
        message: 'provider name, original model and credential sk-exampleCredential123456',
      },
    };
    const result = new ResponseNormalizerService().stream(
      {
        response: responseStream([
          `event: response.output_text.delta\ndata: ${JSON.stringify(upstreamDelta)}\n\n`,
          `event: response.failed\ndata: ${JSON.stringify(upstreamFailure)}\n\n`,
        ]),
        wireFormat: 'openai-responses',
        requestedStream: true,
      },
      'responses',
      'public-alias',
      'req-response',
      { input: 'private prompt' },
      onComplete,
      onFailure,
    );

    const output = await readStream(result);

    expect(output).toContain('partial');
    expect(output).toContain('event: response.failed');
    expect(eventPayload(output, 'response.failed')).toMatchObject({
      sequence_number: 2,
      response: { error: { code: 'server_error' } },
    });
    expect(output).not.toContain('provider name');
    expect(output).not.toContain('original model');
    expect(output).not.toContain('sk-exampleCredential123456');
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), true);
  });

  it('emits a safe Responses failure even when upstream fails before its first valid frame', async () => {
    const onFailure = vi.fn().mockResolvedValue(undefined);
    const result = new ResponseNormalizerService().stream(
      {
        response: responseStream(['event: error\ndata: {not-json-and-private-provider-info}\n\n']),
        wireFormat: 'openai-responses',
        requestedStream: true,
      },
      'responses',
      'public-alias',
      'req-before-first-byte',
      { input: 'private prompt' },
      vi.fn(),
      onFailure,
    );

    const output = await readStream(result);

    expect(output).toContain('event: response.failed');
    expect(eventPayload(output, 'response.failed')).toMatchObject({
      sequence_number: 0,
      response: { error: { code: 'server_error' } },
    });
    expect(output).not.toContain('private-provider-info');
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), false);
  });

  it('emits a safe Chat error and DONE after a partial chunk', async () => {
    const onFailure = vi.fn().mockResolvedValue(undefined);
    const valid = {
      id: 'upstream-id',
      model: 'private-model',
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
    };
    const result = new ResponseNormalizerService().stream(
      {
        response: responseStream([
          `data: ${JSON.stringify(valid)}\n\n`,
          'data: {"error":{"message":"private upstream diagnostic"}}\n\n',
        ]),
        wireFormat: 'openai-chat',
        requestedStream: true,
      },
      'chat',
      'public-alias',
      'req-chat-stream',
      { messages: [{ role: 'user', content: 'private prompt' }] },
      vi.fn(),
      onFailure,
    );

    const output = await readStream(result);

    expect(output).toContain('partial');
    expect(output).toContain('provider_unavailable');
    expect(output).toContain('data: [DONE]');
    expect(output).not.toContain('private upstream diagnostic');
    expect(output).not.toContain('private-model');
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), true);
  });
});
