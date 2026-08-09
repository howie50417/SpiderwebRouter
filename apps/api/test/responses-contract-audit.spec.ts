import type { PublishedModel } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProviderAdapterService } from '../src/gateway/provider-adapter.service';
import {
  chatToGemini,
  prepareRequestBody,
  responsesToChat,
} from '../src/gateway/request-transform';
import { ResponseNormalizerService } from '../src/gateway/response-normalizer.service';

type JsonObject = Record<string, unknown>;

function model(overrides: Partial<PublishedModel> = {}): PublishedModel {
  return {
    upstreamModelId: 'private-upstream-model',
    promptMode: 'NONE',
    systemPrompt: null,
    thinkingLevel: 'PROVIDER_DEFAULT',
    ...overrides,
  } as unknown as PublishedModel;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function parseSse(output: string): JsonObject[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n'),
    )
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as JsonObject);
}

describe('Responses request compatibility', () => {
  it('forces stateless upstream responses while preserving similarly named user payload fields', () => {
    const result = prepareRequestBody(
      {
        model: 'public-model',
        store: true,
        reasoning: { effort: 'xhigh' },
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'hello', reasoning: 'ordinary user data' }],
          },
        ],
      },
      'responses',
      model({ thinkingLevel: 'LOW' }),
      'OPENAI',
    );

    expect(result.store).toBe(false);
    expect(result.reasoning).toEqual({ effort: 'low' });
    expect(result.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'hello', reasoning: 'ordinary user data' }],
      },
    ]);
  });

  it('preserves function/custom call linkage when falling back to Chat Completions', () => {
    const result = responsesToChat({
      model: 'private-model',
      input: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"one"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'first result' },
        { type: 'custom_tool_call', id: 'ctc_2', call_id: 'call_2', name: 'shell', input: 'pwd' },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: 'D:/workspace' },
      ],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'custom', name: 'shell', description: 'Run a command' },
      ],
      parallel_tool_calls: true,
      text: {
        format: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object' } },
      },
    });

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"one"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'shell', arguments: '{"input":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'D:/workspace' },
    ]);
    expect(result.parallel_tool_calls).toBe(true);
    expect(result.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        description: undefined,
        strict: true,
        schema: { type: 'object' },
      },
    });
  });

  it('uses the preceding call id to recover Gemini function response names', () => {
    const chat = responsesToChat({
      model: 'private-model',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"one"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      ],
    });
    const gemini = chatToGemini(chat);
    const contents = gemini.contents as JsonObject[];
    const toolResultParts = contents[1]!.parts as JsonObject[];

    expect(toolResultParts[0]).toEqual({
      functionResponse: { name: 'lookup', response: { result: 'result' } },
    });
  });
});

describe('Responses streaming compatibility', () => {
  it('emits completed output items before the terminal event for buffered adapter fallbacks', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const stream = new ResponseNormalizerService().stream(
      {
        response: new Response(
          JSON.stringify({
            id: 'private-chat-id',
            model: 'private-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'working',
                  tool_calls: [
                    {
                      id: 'call_7',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"input":"pwd"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
        wireFormat: 'openai-chat',
        requestedStream: true,
      },
      'responses',
      'public-model',
      'request-contract',
      { tools: [{ type: 'custom', name: 'shell' }] },
      onComplete,
      vi.fn().mockResolvedValue(undefined),
    );

    const events = parseSse(await readStream(stream));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3]);
    expect((events[1]!.item as JsonObject).type).toBe('message');
    const toolItem = events[2]!.item as JsonObject;
    expect(toolItem).toMatchObject({
      id: expect.stringMatching(/^ctc_/),
      type: 'custom_tool_call',
      call_id: 'call_7',
      name: 'shell',
      input: 'pwd',
    });
    const followUp = responsesToChat({
      model: 'private-model',
      input: [
        toolItem,
        { type: 'custom_tool_call_output', call_id: toolItem.call_id, output: 'D:/workspace' },
      ],
    });
    expect(followUp.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_7',
            type: 'function',
            function: { name: 'shell', arguments: '{"input":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_7', content: 'D:/workspace' },
    ]);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 4,
        estimated: false,
      }),
    );
  });

  it('reads native Responses usage from the nested completed response', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const frames = [
      {
        type: 'response.created',
        sequence_number: 0,
        response: { id: 'upstream', object: 'response', model: 'private' },
      },
      {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'upstream',
          object: 'response',
          model: 'private',
          output: [],
          usage: {
            input_tokens: 31,
            input_tokens_details: { cached_tokens: 7 },
            output_tokens: 11,
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 42,
          },
        },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
    const stream = new ResponseNormalizerService().stream(
      {
        response: new Response(frames, { headers: { 'content-type': 'text/event-stream' } }),
        wireFormat: 'openai-responses',
        requestedStream: true,
      },
      'responses',
      'public-model',
      'request-usage',
      { input: 'hello' },
      onComplete,
      vi.fn().mockResolvedValue(undefined),
    );

    await readStream(stream);
    expect(onComplete).toHaveBeenCalledWith({
      inputTokens: 31,
      cachedInputTokens: 7,
      outputTokens: 11,
      reasoningTokens: 5,
      estimated: false,
    });
  });

  it('converts a clean EOF without response.completed into a safe terminal failure', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onFailure = vi.fn().mockResolvedValue(undefined);
    const created = {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'private', object: 'response', model: 'private' },
    };
    const stream = new ResponseNormalizerService().stream(
      {
        response: new Response(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
        wireFormat: 'openai-responses',
        requestedStream: true,
      },
      'responses',
      'public-model',
      'request-eof',
      { input: 'hello' },
      onComplete,
      onFailure,
    );

    const output = await readStream(stream);
    expect(output).toContain('event: response.failed');
    expect(output).not.toContain('private-model');
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), true);
  });
});

describe('Embeddings adapter compatibility', () => {
  it('does not send the unsupported stream parameter to OpenAI-compatible embeddings endpoints', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ object: 'list', data: [] })));
    const adapter = new ProviderAdapterService(
      { fetch } as never,
      { decryptSecret: vi.fn().mockReturnValue(undefined) } as never,
    );

    await adapter.execute(
      {
        type: 'OPENAI',
        baseUrl: 'https://api.openai.com/v1',
        authMode: 'NONE',
        encryptedSecret: null,
        timeoutMs: 30_000,
      } as never,
      model(),
      'embeddings',
      { model: 'private-upstream-model', input: ['one', 'two'], encoding_format: 'float' },
      false,
    );

    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'private-upstream-model',
      input: ['one', 'two'],
      encoding_format: 'float',
    });
  });
});
