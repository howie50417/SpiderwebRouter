import type { ProviderType, PublishedModel } from '@prisma/client';
import { AppError } from '../common/errors';

type JsonObject = Record<string, unknown>;

export function prepareRequestBody(
  source: JsonObject,
  operation: 'chat' | 'responses' | 'embeddings',
  model: PublishedModel,
  providerType: ProviderType,
): JsonObject {
  const body = stripClientThinking(structuredClone(source)) as JsonObject;
  body.model = model.upstreamModelId;
  if (operation === 'responses') body.store = false;
  applySystemPrompt(body, operation, model);
  applyThinking(body, operation, model.thinkingLevel, providerType);
  return body;
}

export function stripClientThinking(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...(value as JsonObject) };
  for (const key of [
    'reasoning',
    'reasoning_effort',
    'thinking',
    'thinking_config',
    'thinkingConfig',
    'think',
  ])
    delete result[key];
  return result;
}

function applySystemPrompt(
  body: JsonObject,
  operation: 'chat' | 'responses' | 'embeddings',
  model: PublishedModel,
): void {
  if (operation === 'embeddings' || model.promptMode === 'NONE' || !model.systemPrompt) return;
  if (operation === 'responses') {
    const existing = typeof body.instructions === 'string' ? body.instructions : '';
    body.instructions =
      model.promptMode === 'REPLACE' || !existing
        ? model.systemPrompt
        : `${model.systemPrompt}\n\n${existing}`;
    if (model.promptMode === 'REPLACE' && Array.isArray(body.input)) {
      body.input = body.input.filter((item) => {
        if (!item || typeof item !== 'object') return true;
        const role = (item as JsonObject).role;
        return role !== 'system' && role !== 'developer';
      });
    }
    return;
  }
  const messages = Array.isArray(body.messages) ? (body.messages as JsonObject[]) : [];
  const system = { role: 'system', content: model.systemPrompt };
  if (model.promptMode === 'REPLACE') {
    body.messages = [
      system,
      ...messages.filter((message) => message.role !== 'system' && message.role !== 'developer'),
    ];
  } else {
    body.messages = [system, ...messages];
  }
}

function applyThinking(
  body: JsonObject,
  operation: 'chat' | 'responses' | 'embeddings',
  level: PublishedModel['thinkingLevel'],
  providerType: ProviderType,
): void {
  if (operation === 'embeddings' || level === 'PROVIDER_DEFAULT') return;
  if (providerType === 'OLLAMA') {
    body.think = level === 'OFF' ? false : level.toLowerCase();
    return;
  }
  if (providerType === 'GEMINI') {
    body._serverThinkingLevel = level;
    return;
  }
  if (level === 'OFF') {
    const effort = providerType === 'OPENAI' ? 'minimal' : 'none';
    if (operation === 'responses') body.reasoning = { effort };
    else body.reasoning_effort = effort;
    return;
  }
  if (operation === 'responses') body.reasoning = { effort: level.toLowerCase() };
  else body.reasoning_effort = level.toLowerCase();
}

export function responsesToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  let pendingCalls: JsonObject[] = [];
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      const inputItem = item as JsonObject;
      if (inputItem.type === 'function_call' || inputItem.type === 'custom_tool_call') {
        const custom = inputItem.type === 'custom_tool_call';
        const rawArguments = custom
          ? JSON.stringify({ input: inputItem.input ?? '' })
          : typeof inputItem.arguments === 'string'
            ? inputItem.arguments
            : JSON.stringify(inputItem.arguments ?? {});
        pendingCalls.push({
          id: inputItem.call_id ?? inputItem.id,
          type: 'function',
          function: { name: inputItem.name, arguments: rawArguments },
        });
      } else if (
        inputItem.type === 'function_call_output' ||
        inputItem.type === 'custom_tool_call_output'
      ) {
        flushCalls();
        messages.push({
          role: 'tool',
          tool_call_id: inputItem.call_id,
          content: inputItem.output ?? '',
        });
      } else if (typeof inputItem.role === 'string') {
        flushCalls();
        messages.push({ role: inputItem.role, content: responseContentToChat(inputItem.content) });
      }
    }
    flushCalls();
  } else {
    throw new AppError('invalid_request_error', 400, 'The input field is required.', 'input');
  }
  return {
    model: body.model,
    messages,
    tools: responseToolsToChat(body.tools),
    tool_choice: responseToolChoiceToChat(body.tool_choice),
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens,
    response_format: responseTextFormatToChat(body.text),
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning_effort: (body.reasoning as JsonObject | undefined)?.effort,
    _serverThinkingLevel: body._serverThinkingLevel,
    think: body.think,
    stream: false,
  };
}

function responseContentToChat(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const value = part as JsonObject;
    if (value.type === 'input_text' || value.type === 'output_text')
      return { type: 'text', text: value.text };
    if (value.type === 'input_image')
      return { type: 'image_url', image_url: { url: value.image_url, detail: value.detail } };
    return value;
  });
}

function responseToolsToChat(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const value = tool as JsonObject;
    if (value.type === 'function') {
      return {
        type: 'function',
        function: {
          name: value.name,
          description: value.description,
          parameters: value.parameters,
          strict: value.strict,
        },
      };
    }
    if (value.type === 'custom') {
      return {
        type: 'function',
        function: {
          name: value.name,
          description: value.description,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      };
    }
    throw new AppError('unsupported_feature', 400, 'Hosted tools are not supported.', 'tools');
  });
}

function responseTextFormatToChat(text: unknown): unknown {
  if (!text || typeof text !== 'object') return undefined;
  const format = (text as JsonObject).format;
  if (!format || typeof format !== 'object') return undefined;
  const value = format as JsonObject;
  if (value.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: value.name,
        description: value.description,
        strict: value.strict,
        schema: value.schema,
      },
    };
  }
  if (value.type === 'json_object') return { type: 'json_object' };
  return undefined;
}

function responseToolChoiceToChat(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return choice;
  const value = choice as JsonObject;
  if ((value.type === 'function' || value.type === 'custom') && typeof value.name === 'string') {
    return { type: 'function', function: { name: value.name } };
  }
  return choice;
}

export function chatToGemini(body: JsonObject): JsonObject {
  const messages = Array.isArray(body.messages) ? (body.messages as JsonObject[]) : [];
  const systemParts: JsonObject[] = [];
  const contents: JsonObject[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = geminiParts(message.content);
    if (message.role === 'system' || message.role === 'developer') systemParts.push(...parts);
    else if (message.role === 'tool') {
      const callId = String(message.tool_call_id ?? '');
      const name =
        callNames.get(callId) ?? (typeof message.name === 'string' ? message.name : undefined);
      if (!name)
        throw new AppError(
          'invalid_request_error',
          400,
          'A tool output does not match a preceding tool call.',
          'input',
        );
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { result: message.content } } }],
      });
    } else {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls as JsonObject[]) {
          const fn = (toolCall.function ?? {}) as JsonObject;
          const id = String(toolCall.id ?? '');
          const name = String(fn.name ?? '');
          if (id && name) callNames.set(id, name);
          parts.push({ functionCall: { name, args: parseArguments(fn.arguments) } });
        }
      }
      contents.push({ role, parts });
    }
  }
  const generationConfig: JsonObject = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.response_format && typeof body.response_format === 'object') {
    const format = body.response_format as JsonObject;
    if (format.type === 'json_object' || format.type === 'json_schema')
      generationConfig.responseMimeType = 'application/json';
    if (format.type === 'json_schema')
      generationConfig.responseSchema = (format.json_schema as JsonObject | undefined)?.schema;
  }
  if (typeof body._serverThinkingLevel === 'string') {
    const level = body._serverThinkingLevel;
    generationConfig.thinkingConfig =
      level === 'OFF' ? { thinkingBudget: 0 } : { thinkingLevel: level };
  }
  const result: JsonObject = { contents, generationConfig };
  if (systemParts.length) result.systemInstruction = { parts: systemParts };
  if (Array.isArray(body.tools)) {
    result.tools = [
      {
        functionDeclarations: (body.tools as JsonObject[])
          .filter(
            (tool) =>
              tool.type === 'function' && tool.function && typeof tool.function === 'object',
          )
          .map((tool) => {
            const fn = tool.function as JsonObject;
            return { name: fn.name, description: fn.description, parameters: fn.parameters };
          }),
      },
    ];
  }
  return result;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { input: value };
  }
}

function geminiParts(content: unknown): JsonObject[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? '') }];
  return content.flatMap((part): JsonObject[] => {
    if (!part || typeof part !== 'object') return [];
    const value = part as JsonObject;
    if (value.type === 'text') return [{ text: value.text }];
    if (value.type === 'image_url' && value.image_url && typeof value.image_url === 'object') {
      const url = String((value.image_url as JsonObject).url ?? '');
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (match) return [{ inlineData: { mimeType: match[1], data: match[2] } }];
      return [{ fileData: { fileUri: url } }];
    }
    return [];
  });
}

export function embeddingToGemini(body: JsonObject): JsonObject {
  const input = body.input;
  const inputs = Array.isArray(input) ? input : [input];
  return {
    requests: inputs.map((value) => ({
      model: `models/${body.model}`,
      content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      outputDimensionality: body.dimensions,
    })),
  };
}
