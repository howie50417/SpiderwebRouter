import { Injectable } from '@nestjs/common';
import type { AdapterResult, GatewayOperation, TokenUsage } from './gateway.types';
import { ProviderError } from './provider-error';

type JsonObject = Record<string, unknown>;

export interface NormalizedBufferedResponse {
  json: JsonObject;
  usage: TokenUsage;
}

export interface StreamErrorWithUsage extends Error {
  partialUsage?: TokenUsage;
}

@Injectable()
export class ResponseNormalizerService {
  async preflight(
    result: AdapterResult,
    operation: GatewayOperation,
    alias: string,
    requestId: string,
    requestBody: JsonObject,
  ): Promise<AdapterResult> {
    if (!result.response.body)
      throw new ProviderError('Upstream response has no body', { category: 'protocol' });
    const contentType = result.response.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/event-stream') &&
      !contentType.includes('ndjson') &&
      !contentType.includes('stream')
    ) {
      await this.buffered(
        { ...result, response: result.response.clone() },
        operation,
        alias,
        requestId,
        requestBody,
      );
      return result;
    }

    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    const bufferedChunks: Uint8Array[] = [];
    let bufferedText = '';
    let bufferedSize = 0;
    try {
      while (bufferedSize <= 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done)
          throw new ProviderError('Upstream stream ended before its first event', {
            category: 'protocol',
          });
        bufferedChunks.push(value);
        bufferedSize += value.byteLength;
        bufferedText += decoder.decode(value, { stream: true });
        let pending = bufferedText;
        let extracted: ExtractedFrame | undefined;
        while ((extracted = extractFrame(pending, result.wireFormat === 'ollama-chat'))) {
          const frame = extracted.frame;
          pending = extracted.rest;
          const normalized = normalizeStreamFrame(
            result.wireFormat,
            frame,
            operation,
            alias,
            requestId,
          );
          if (normalized?.bytes.length) {
            const replay = replayStream(bufferedChunks, reader);
            return {
              ...result,
              response: new Response(replay, {
                status: result.response.status,
                statusText: result.response.statusText,
                headers: result.response.headers,
              }),
            };
          }
        }
      }
      throw new ProviderError('Upstream stream did not produce a valid event', {
        category: 'protocol',
      });
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Upstream stream failed before its first event', {
        category: 'connection',
        cause: error,
      });
    }
  }

  async buffered(
    result: AdapterResult,
    operation: GatewayOperation,
    alias: string,
    requestId: string,
    requestBody: JsonObject,
  ): Promise<NormalizedBufferedResponse> {
    const raw = await this.parseJson(result.response);
    let json: JsonObject;
    if (result.wireFormat === 'gemini-chat') json = normalizeGeminiChat(raw, alias, requestId);
    else if (result.wireFormat === 'gemini-embeddings')
      json = normalizeGeminiEmbeddings(raw, alias);
    else if (result.wireFormat === 'ollama-chat') json = normalizeOllamaChat(raw, alias, requestId);
    else if (result.wireFormat === 'openai-embeddings') json = normalizeEmbeddings(raw, alias);
    else if (result.wireFormat === 'openai-responses')
      json = normalizeOpenAiResponse(raw, alias, requestId);
    else json = normalizeOpenAiChat(raw, alias, requestId);

    if (operation === 'responses' && result.wireFormat !== 'openai-responses') {
      json = chatCompletionToResponse(json, alias, requestId, requestBody);
    }
    const usage = extractUsage(json, requestBody);
    if (operation === 'responses' && !json.usage) json.usage = responsesUsage(usage);
    return { json, usage };
  }

  stream(
    result: AdapterResult,
    operation: GatewayOperation,
    alias: string,
    requestId: string,
    requestBody: JsonObject,
    onComplete: (usage: TokenUsage) => Promise<void>,
    onFailure: (error: unknown, emittedBytes: boolean) => Promise<void>,
  ): ReadableStream<Uint8Array> {
    if (!result.response.body)
      throw new ProviderError('Upstream response has no body', { category: 'protocol' });
    const contentType = result.response.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/event-stream') &&
      !contentType.includes('ndjson') &&
      !contentType.includes('stream')
    ) {
      return this.syntheticStream(
        result,
        operation,
        alias,
        requestId,
        requestBody,
        onComplete,
        onFailure,
      );
    }

    const source = result.response.body;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let emittedBytes = false;
    let accumulatedText = '';
    let finalUsage: TokenUsage | undefined;
    let sawResponseTerminal = operation !== 'responses' || result.wireFormat !== 'openai-responses';
    let lastSequenceNumber = -1;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        reader = source.getReader();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let extracted: ExtractedFrame | undefined;
            while ((extracted = extractFrame(buffer, result.wireFormat === 'ollama-chat'))) {
              const frame = extracted.frame;
              buffer = extracted.rest;
              const normalized = normalizeStreamFrame(
                result.wireFormat,
                frame,
                operation,
                alias,
                requestId,
              );
              if (!normalized) continue;
              accumulatedText += normalized.text;
              if (normalized.usage) finalUsage = normalized.usage;
              if (normalized.completed) sawResponseTerminal = true;
              if (normalized.sequenceNumber !== undefined)
                lastSequenceNumber = Math.max(lastSequenceNumber, normalized.sequenceNumber);
              if (normalized.bytes.length) {
                emittedBytes = true;
                controller.enqueue(encoder.encode(normalized.bytes));
              }
            }
          }
          if (buffer.trim()) {
            const normalized = normalizeStreamFrame(
              result.wireFormat,
              buffer,
              operation,
              alias,
              requestId,
            );
            if (normalized) {
              accumulatedText += normalized.text;
              if (normalized.usage) finalUsage = normalized.usage;
              if (normalized.completed) sawResponseTerminal = true;
              if (normalized.sequenceNumber !== undefined)
                lastSequenceNumber = Math.max(lastSequenceNumber, normalized.sequenceNumber);
              if (normalized.bytes.length) {
                emittedBytes = true;
                controller.enqueue(encoder.encode(normalized.bytes));
              }
            }
          }
          if (!sawResponseTerminal) {
            throw new ProviderError('Upstream Responses stream ended before a terminal event', {
              category: 'protocol',
            });
          }
          const doneFrame = operation === 'chat' ? 'data: [DONE]\n\n' : '';
          if (doneFrame) controller.enqueue(encoder.encode(doneFrame));
          const usage = finalUsage ?? estimateUsage(requestBody, accumulatedText);
          await onComplete(usage);
          controller.close();
        } catch (error) {
          const failure = attachPartialUsage(
            error,
            emittedBytes ? (finalUsage ?? estimateUsage(requestBody, accumulatedText)) : undefined,
          );
          await onFailure(failure, emittedBytes);
          const safe = streamFailureFrame(operation, alias, requestId, lastSequenceNumber + 1);
          controller.enqueue(encoder.encode(safe));
          controller.close();
        }
      },
      cancel: async (reason) => {
        await reader?.cancel(reason).catch(() => undefined);
        await onFailure(
          attachPartialUsage(
            new Error('Client cancelled stream'),
            emittedBytes ? (finalUsage ?? estimateUsage(requestBody, accumulatedText)) : undefined,
          ),
          emittedBytes,
        );
      },
    });
  }

  private syntheticStream(
    result: AdapterResult,
    operation: GatewayOperation,
    alias: string,
    requestId: string,
    requestBody: JsonObject,
    onComplete: (usage: TokenUsage) => Promise<void>,
    onFailure: (error: unknown, emittedBytes: boolean) => Promise<void>,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const normalized = await this.buffered(result, operation, alias, requestId, requestBody);
          if (operation === 'responses') {
            const response = normalized.json;
            let sequenceNumber = 0;
            const sequence: JsonObject[] = [
              {
                type: 'response.created',
                sequence_number: sequenceNumber++,
                response: { ...response, status: 'in_progress', output: [] },
              },
            ];
            const output = Array.isArray(response.output) ? (response.output as JsonObject[]) : [];
            output.forEach((item, outputIndex) => {
              sequence.push({
                type: 'response.output_item.done',
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item,
              });
            });
            sequence.push({
              type: 'response.completed',
              sequence_number: sequenceNumber++,
              response,
            });
            for (const event of sequence)
              controller.enqueue(
                encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
              );
          } else {
            const completion = normalized.json;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`),
            );
          }
          await onComplete(normalized.usage);
          controller.close();
        } catch (error) {
          await onFailure(error, false);
          controller.error(error);
        }
      },
    });
  }

  private async parseJson(response: Response): Promise<JsonObject> {
    try {
      const value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected JSON object');
      const object = value as JsonObject;
      if (object.error) throw new Error('Upstream returned an embedded error');
      return object;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Upstream returned an invalid response', {
        category: 'protocol',
        cause: error,
      });
    }
  }
}

export function partialUsageFromError(error: unknown): TokenUsage | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as StreamErrorWithUsage).partialUsage;
}

function attachPartialUsage(error: unknown, usage?: TokenUsage): StreamErrorWithUsage {
  const result: StreamErrorWithUsage =
    error instanceof Error ? error : new Error('Upstream stream failed');
  if (usage) result.partialUsage = usage;
  return result;
}

function replayStream(
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        for (const chunk of bufferedChunks) controller.enqueue(chunk);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

interface ExtractedFrame {
  frame: string;
  rest: string;
}

function extractFrame(buffer: string, ndjson: boolean): ExtractedFrame | undefined {
  const match = (ndjson ? /\r?\n/ : /\r?\n\r?\n/).exec(buffer);
  if (!match || match.index === undefined) return undefined;
  const end = match.index + match[0].length;
  return { frame: buffer.slice(0, match.index), rest: buffer.slice(end) };
}

function normalizeOpenAiChat(raw: JsonObject, alias: string, requestId: string): JsonObject {
  if (!Array.isArray(raw.choices))
    throw new ProviderError('Missing choices in upstream response', { category: 'protocol' });
  const result: JsonObject = { ...raw, id: `chatcmpl_${compactId(requestId)}`, model: alias };
  delete result.system_fingerprint;
  return result;
}

function normalizeOpenAiResponse(raw: JsonObject, alias: string, requestId: string): JsonObject {
  if (!Array.isArray(raw.output))
    throw new ProviderError('Missing output in upstream response', { category: 'protocol' });
  const result = sanitizeResponseObject(raw, alias, requestId);
  result.id = `resp_${compactId(requestId)}`;
  result.model = alias;
  return result;
}

function normalizeEmbeddings(raw: JsonObject, alias: string): JsonObject {
  if (Array.isArray(raw.embeddings) && !raw.data) {
    raw.data = raw.embeddings.map((embedding, index) => ({
      object: 'embedding',
      embedding,
      index,
    }));
    delete raw.embeddings;
  }
  if (!Array.isArray(raw.data))
    throw new ProviderError('Missing embeddings in upstream response', { category: 'protocol' });
  return { ...raw, object: 'list', model: alias };
}

function normalizeGeminiEmbeddings(raw: JsonObject, alias: string): JsonObject {
  const embeddings = Array.isArray(raw.embeddings) ? (raw.embeddings as JsonObject[]) : [];
  return {
    object: 'list',
    model: alias,
    data: embeddings.map((item, index) => ({
      object: 'embedding',
      embedding: item.values ?? [],
      index,
    })),
    usage: { prompt_tokens: 0, total_tokens: 0, estimated: true },
  };
}

function normalizeGeminiChat(raw: JsonObject, alias: string, requestId: string): JsonObject {
  const candidates = Array.isArray(raw.candidates) ? (raw.candidates as JsonObject[]) : [];
  const choices = candidates.map((candidate, index) => {
    const content = candidate.content as JsonObject | undefined;
    const parts = Array.isArray(content?.parts) ? (content.parts as JsonObject[]) : [];
    const text = parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, callIndex) => {
        const call = part.functionCall as JsonObject;
        return {
          id: `call_${compactId(requestId)}_${callIndex}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        };
      });
    return {
      index,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: geminiFinishReason(candidate.finishReason),
    };
  });
  const metadata = (raw.usageMetadata ?? {}) as JsonObject;
  const result: JsonObject = {
    id: `chatcmpl_${compactId(requestId)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices,
  };
  if (Object.keys(metadata).length)
    result.usage = {
      prompt_tokens: number(metadata.promptTokenCount),
      completion_tokens: number(metadata.candidatesTokenCount),
      total_tokens: number(metadata.totalTokenCount),
    };
  return result;
}

function normalizeOllamaChat(raw: JsonObject, alias: string, requestId: string): JsonObject {
  const message = raw.message && typeof raw.message === 'object' ? (raw.message as JsonObject) : {};
  const result: JsonObject = {
    id: `chatcmpl_${compactId(requestId)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: message.content ?? '',
          tool_calls: message.tool_calls,
        },
        finish_reason: raw.done ? 'stop' : null,
      },
    ],
  };
  if (raw.prompt_eval_count !== undefined || raw.eval_count !== undefined)
    result.usage = {
      prompt_tokens: number(raw.prompt_eval_count),
      completion_tokens: number(raw.eval_count),
      total_tokens: number(raw.prompt_eval_count) + number(raw.eval_count),
    };
  return result;
}

function chatCompletionToResponse(
  chat: JsonObject,
  alias: string,
  requestId: string,
  requestBody: JsonObject,
): JsonObject {
  const choices = Array.isArray(chat.choices) ? (chat.choices as JsonObject[]) : [];
  const message = (choices[0]?.message ?? {}) as JsonObject;
  const content: JsonObject[] = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'output_text', text: message.content, annotations: [] });
  }
  const output: JsonObject[] = [
    {
      id: `msg_${compactId(requestId)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content,
    },
  ];
  const customToolNames = new Set(
    (Array.isArray(requestBody.tools) ? (requestBody.tools as JsonObject[]) : [])
      .filter((tool) => tool.type === 'custom' && typeof tool.name === 'string')
      .map((tool) => String(tool.name)),
  );
  if (Array.isArray(message.tool_calls)) {
    for (const callValue of message.tool_calls as JsonObject[]) {
      const fn = (callValue.function ?? {}) as JsonObject;
      const name = String(fn.name ?? '');
      if (customToolNames.has(name)) {
        const parsed = parseToolArguments(fn.arguments);
        output.push({
          id: `ctc_${compactId(requestId)}_${output.length}`,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: callValue.id ?? `call_${compactId(requestId)}_${output.length}`,
          name,
          input: typeof parsed.input === 'string' ? parsed.input : String(fn.arguments ?? ''),
        });
      } else {
        output.push({
          id: `fc_${compactId(requestId)}_${output.length}`,
          type: 'function_call',
          status: 'completed',
          call_id: callValue.id ?? `call_${compactId(requestId)}_${output.length}`,
          name,
          arguments: toolArgumentsString(fn.arguments),
        });
      }
    }
  }
  const usage =
    chat.usage && typeof chat.usage === 'object' ? (chat.usage as JsonObject) : undefined;
  const response: JsonObject = {
    id: `resp_${compactId(requestId)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: alias,
    output,
    output_text: typeof message.content === 'string' ? message.content : '',
  };
  if (usage)
    response.usage = {
      input_tokens: number(usage.prompt_tokens),
      output_tokens: number(usage.completion_tokens),
      total_tokens: number(usage.total_tokens),
      input_tokens_details: {
        cached_tokens: number(
          (usage.prompt_tokens_details as JsonObject | undefined)?.cached_tokens,
        ),
      },
      output_tokens_details: {
        reasoning_tokens: number(
          (usage.completion_tokens_details as JsonObject | undefined)?.reasoning_tokens,
        ),
      },
    };
  return response;
}

function normalizeStreamFrame(
  format: AdapterResult['wireFormat'],
  frame: string,
  operation: GatewayOperation,
  alias: string,
  requestId: string,
):
  | {
      bytes: string;
      text: string;
      usage?: TokenUsage;
      completed?: boolean;
      sequenceNumber?: number;
    }
  | undefined {
  if (!frame.trim()) return undefined;
  if (format === 'ollama-chat') {
    const raw = parseFrameJson(frame);
    const message = (raw.message ?? {}) as JsonObject;
    const text = typeof message.content === 'string' ? message.content : '';
    const chunk = {
      id: `chatcmpl_${compactId(requestId)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: alias,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text, tool_calls: message.tool_calls },
          finish_reason: raw.done ? 'stop' : null,
        },
      ],
      ...(raw.done
        ? {
            usage: {
              prompt_tokens: number(raw.prompt_eval_count),
              completion_tokens: number(raw.eval_count),
              total_tokens: number(raw.prompt_eval_count) + number(raw.eval_count),
            },
          }
        : {}),
    };
    const usage = raw.done ? extractUsage(chunk, {}) : undefined;
    return { bytes: `data: ${JSON.stringify(chunk)}\n\n`, text, usage };
  }

  const lines = frame.split(/\r?\n/);
  const dataLine = lines.find((line) => line.startsWith('data:'));
  if (!dataLine) return undefined;
  const payload = dataLine.slice(5).trim();
  if (!payload || payload === '[DONE]') return undefined;
  const raw = parseFrameJson(payload);
  if (raw.error || raw.type === 'response.failed' || raw.type === 'error') {
    throw new ProviderError('Upstream stream reported an error', {
      category: 'protocol',
      rawBody: payload,
    });
  }

  if (format === 'gemini-chat') {
    const completion = normalizeGeminiChat(raw, alias, requestId);
    const choice = (completion.choices as JsonObject[])[0] ?? {};
    const message = (choice.message ?? {}) as JsonObject;
    const text = typeof message.content === 'string' ? message.content : '';
    const chunk = {
      id: completion.id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model: alias,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text, tool_calls: message.tool_calls },
          finish_reason: choice.finish_reason,
        },
      ],
      usage: completion.usage,
    };
    return { bytes: `data: ${JSON.stringify(chunk)}\n\n`, text, usage: extractUsage(chunk, {}) };
  }

  if (format === 'openai-responses' && operation === 'responses') {
    const sanitized = sanitizeResponseEvent(raw, alias, requestId);
    const type = typeof sanitized.type === 'string' ? sanitized.type : 'response.output_text.delta';
    const text =
      typeof sanitized.delta === 'string' && type.includes('output_text') ? sanitized.delta : '';
    const terminal = type === 'response.completed' || type === 'response.incomplete';
    return {
      bytes: `event: ${type}\ndata: ${JSON.stringify(sanitized)}\n\n`,
      text,
      usage: terminal ? extractUsage(sanitized, {}) : undefined,
      completed: terminal,
      sequenceNumber:
        typeof sanitized.sequence_number === 'number' ? sanitized.sequence_number : undefined,
    };
  }

  raw.id = `chatcmpl_${compactId(requestId)}`;
  raw.model = alias;
  delete raw.system_fingerprint;
  const choices = Array.isArray(raw.choices) ? (raw.choices as JsonObject[]) : [];
  const delta = (choices[0]?.delta ?? {}) as JsonObject;
  const text = typeof delta.content === 'string' ? delta.content : '';
  return {
    bytes: `data: ${JSON.stringify(raw)}\n\n`,
    text,
    usage: raw.usage ? extractUsage(raw, {}) : undefined,
  };
}

function sanitizeResponseEvent(raw: JsonObject, alias: string, requestId: string): JsonObject {
  const result = sanitizeResponseObject(raw, alias, requestId);
  if (typeof result.response_id === 'string') result.response_id = `resp_${compactId(requestId)}`;
  if (result.response && typeof result.response === 'object') {
    result.response = sanitizeResponseObject(result.response as JsonObject, alias, requestId);
  }
  return result;
}

function sanitizeResponseObject(raw: JsonObject, alias: string, requestId: string): JsonObject {
  const result = structuredClone(raw) as JsonObject;
  if (typeof result.model === 'string') result.model = alias;
  if (typeof result.id === 'string' && String(result.object ?? '').includes('response'))
    result.id = `resp_${compactId(requestId)}`;
  delete result.system_fingerprint;
  delete result.request_id;
  return result;
}

export function extractUsage(response: JsonObject, requestBody: JsonObject): TokenUsage {
  const nestedResponse =
    response.response && typeof response.response === 'object'
      ? (response.response as JsonObject)
      : undefined;
  const usageValue = response.usage ?? nestedResponse?.usage;
  const usage =
    usageValue && typeof usageValue === 'object' ? (usageValue as JsonObject) : undefined;
  if (usage) {
    const input = number(usage.input_tokens ?? usage.prompt_tokens);
    const output = number(usage.output_tokens ?? usage.completion_tokens);
    const inputDetails = (usage.input_tokens_details ??
      usage.prompt_tokens_details ??
      {}) as JsonObject;
    const outputDetails = (usage.output_tokens_details ??
      usage.completion_tokens_details ??
      {}) as JsonObject;
    return {
      inputTokens: input,
      cachedInputTokens: number(inputDetails.cached_tokens),
      outputTokens: output,
      reasoningTokens: number(outputDetails.reasoning_tokens),
      estimated: usage.estimated === true || (input === 0 && output === 0),
    };
  }
  return estimateUsage(requestBody, extractOutputText(response));
}

function estimateUsage(requestBody: JsonObject, outputText: string): TokenUsage {
  const inputText = JSON.stringify({
    messages: requestBody.messages,
    input: requestBody.input,
    instructions: requestBody.instructions,
  });
  return {
    inputTokens: Math.max(1, conservativeTokenEstimate(inputText)),
    cachedInputTokens: 0,
    outputTokens: Math.max(outputText ? 1 : 0, conservativeTokenEstimate(outputText)),
    reasoningTokens: 0,
    estimated: true,
  };
}

function responsesUsage(usage: TokenUsage): JsonObject {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    estimated: usage.estimated,
  };
}

function conservativeTokenEstimate(value: string): number {
  let tokens = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    tokens += codePoint > 0x7f ? 2 : 1 / 3;
  }
  return Math.ceil(tokens);
}

function extractOutputText(response: JsonObject): string {
  if (typeof response.output_text === 'string') return response.output_text;
  const choices = Array.isArray(response.choices) ? (response.choices as JsonObject[]) : [];
  const message = (choices[0]?.message ?? {}) as JsonObject;
  return typeof message.content === 'string' ? message.content : '';
}

function parseFrameJson(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected object');
    return parsed as JsonObject;
  } catch (error) {
    throw new ProviderError('Upstream stream contained malformed JSON', {
      category: 'protocol',
      rawBody: value,
      cause: error,
    });
  }
}

function streamFailureFrame(
  operation: GatewayOperation,
  alias: string,
  requestId: string,
  sequenceNumber: number,
): string {
  if (operation === 'responses') {
    const event = {
      type: 'response.failed',
      sequence_number: Math.max(0, sequenceNumber),
      response: failedResponse(requestId, alias),
    };
    return `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`;
  }
  const error = {
    error: {
      message: 'The model service is temporarily unavailable.',
      type: 'server_error',
      param: null,
      code: 'provider_unavailable',
      request_id: requestId,
    },
  };
  return `data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`;
}

function failedResponse(requestId: string, model: string): JsonObject {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${compactId(requestId)}`,
    object: 'response',
    created_at: now,
    completed_at: now,
    status: 'failed',
    model,
    error: { code: 'server_error', message: 'The model service is temporarily unavailable.' },
    incomplete_details: null,
    instructions: null,
    output: [],
    output_text: '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: null,
  };
}

function geminiFinishReason(value: unknown): string | null {
  const reason = String(value ?? '').toUpperCase();
  if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return 'content_filter';
}

function compactId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function parseToolArguments(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function toolArgumentsString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
