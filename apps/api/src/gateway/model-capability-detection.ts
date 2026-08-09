import {
  MODEL_CAPABILITY_KEYS,
  type ModelCapabilityKey,
  type ScannedCapabilityState,
  type ScannedModelCapabilities,
} from './gateway.types';

type JsonObject = Record<string, unknown>;

export interface CapabilityEvidence {
  source: 'upstream_metadata' | 'router_emulation';
  path: string;
  state: ScannedCapabilityState;
  emulated?: true;
  via?: 'chat';
}

export interface ModelCapabilityDetection {
  capabilities: ScannedModelCapabilities;
  evidence: Partial<Record<ModelCapabilityKey, CapabilityEvidence[]>>;
  supportedThinkingLevels?: string[];
}

interface CandidateNode {
  path: string;
  value: JsonObject;
}

interface Assignment {
  state: ScannedCapabilityState;
  path: string;
}

const CAPABILITY_CONTAINER_KEYS = new Set([
  'capabilities',
  'capability',
  'features',
  'feature',
  'supported_capabilities',
  'supported_features',
  'supported_generation_methods',
  'interfaces',
  'endpoints',
]);

const TASK_KEYS = new Set(['task', 'tasks', 'pipeline_tag', 'model_type']);
const MODALITY_KEYS = new Set([
  'modalities',
  'input_modalities',
  'supported_modalities',
  'supported_input_modalities',
]);
const THINKING_LEVEL_KEYS = new Set([
  'supported_thinking_levels',
  'thinking_levels',
  'supported_reasoning_efforts',
  'reasoning_efforts',
  'supported_reasoning_effort_levels',
  'reasoning_effort_levels',
  'supported_effort_levels',
  'effort_levels',
]);

const CAPABILITY_ALIASES: Record<ModelCapabilityKey, ReadonlySet<string>> = {
  chat: new Set([
    'chat',
    'chats',
    'chat_completion',
    'chat_completions',
    'conversation',
    'conversational',
    'generate_content',
  ]),
  responses: new Set(['response', 'responses', 'responses_api']),
  embeddings: new Set([
    'embed',
    'embedding',
    'embeddings',
    'embed_content',
    'batch_embed_contents',
    'feature_extraction',
    'sentence_similarity',
  ]),
  vision: new Set([
    'vision',
    'image',
    'image_url',
    'image_input',
    'image_inputs',
    'image_to_text',
    'image_text_to_text',
    'visual_question_answering',
    'multimodal',
  ]),
  tools: new Set([
    'tool',
    'tools',
    'tool_call',
    'tool_calls',
    'tool_calling',
    'function_call',
    'function_calls',
    'function_calling',
  ]),
  structuredOutput: new Set([
    'structured_output',
    'structured_outputs',
    'json_mode',
    'json_schema',
    'response_format',
  ]),
  streaming: new Set([
    'stream',
    'streams',
    'streaming',
    'server_sent_events',
    'sse',
    'stream_generate_content',
  ]),
  reasoning: new Set([
    'reasoning',
    'reasoning_effort',
    'reasoning_efforts',
    'think',
    'thinking',
    'thinking_mode',
    'thinking_modes',
  ]),
};

const TRUE_STATES = new Set(['true', 'yes', 'supported', 'available', 'enabled', 'on']);
const FALSE_STATES = new Set(['false', 'no', 'unsupported', 'unavailable', 'disabled', 'off']);
const UNKNOWN_STATES = new Set(['unknown', 'unconfirmed', 'unspecified']);
const THINKING_LEVEL_ORDER = [
  'PROVIDER_DEFAULT',
  'OFF',
  'MINIMAL',
  'LOW',
  'MEDIUM',
  'HIGH',
  'XHIGH',
  'MAX',
];

/**
 * Reads only capability declarations supplied by the upstream. Model IDs are
 * intentionally never inspected: names are not a reliable feature contract.
 */
export function detectModelCapabilities(
  item: JsonObject,
  options: { emulateResponsesFromChat?: boolean } = {},
): ModelCapabilityDetection {
  const assignments = Object.fromEntries(
    MODEL_CAPABILITY_KEYS.map((key) => [key, [] as Assignment[]]),
  ) as Record<ModelCapabilityKey, Assignment[]>;
  const levels: string[] = [];

  for (const node of candidateNodes(item)) {
    inspectNode(node, assignments, levels);
  }

  const evidence: ModelCapabilityDetection['evidence'] = {};
  const resolved = Object.fromEntries(
    MODEL_CAPABILITY_KEYS.map((key) => {
      const values = assignments[key];
      if (values.length) {
        evidence[key] = values.map(({ path, state }) => ({
          source: 'upstream_metadata',
          path,
          state,
        }));
      }
      return [key, resolveAssignments(values)];
    }),
  ) as Record<ModelCapabilityKey, ScannedCapabilityState>;

  // `responses` is the public Router capability. Track native support separately
  // so publishing an emulated capability cannot accidentally switch the adapter
  // from the Chat fallback to an unsupported upstream /responses endpoint.
  const nativeResponses = resolved.responses === true;
  if (options.emulateResponsesFromChat && resolved.chat === true && !nativeResponses) {
    resolved.responses = true;
    evidence.responses = [
      ...(evidence.responses ?? []),
      {
        source: 'router_emulation',
        path: 'router.responses_via_chat',
        state: true,
        emulated: true,
        via: 'chat',
      },
    ];
  }

  const supportedThinkingLevels = unique(levels).sort(
    (left, right) => THINKING_LEVEL_ORDER.indexOf(left) - THINKING_LEVEL_ORDER.indexOf(right),
  );
  if (supportedThinkingLevels.length && resolved.reasoning !== false) {
    resolved.reasoning = true;
    evidence.reasoning = [
      ...(evidence.reasoning ?? []),
      ...supportedThinkingLevels.map<CapabilityEvidence>((level) => ({
        source: 'upstream_metadata',
        path: `supportedThinkingLevels.${level}`,
        state: true,
      })),
    ];
  }

  return {
    capabilities: { ...resolved, nativeResponses },
    evidence,
    ...(supportedThinkingLevels.length ? { supportedThinkingLevels } : {}),
  };
}

function candidateNodes(item: JsonObject): CandidateNode[] {
  const nodes: CandidateNode[] = [{ path: '', value: item }];
  appendObject(nodes, item.metadata, 'metadata');
  appendObject(nodes, item.meta, 'meta');
  appendObject(nodes, item.info, 'info');
  const info = asObject(item.info);
  appendObject(nodes, info?.metadata, 'info.metadata');
  appendObject(nodes, info?.meta, 'info.meta');
  appendObject(nodes, item.details, 'details');
  appendObject(nodes, item.runtimeStatus, 'runtimeStatus');
  return nodes;
}

function appendObject(nodes: CandidateNode[], value: unknown, path: string): void {
  const object = asObject(value);
  if (object) nodes.push({ path, value: object });
}

function inspectNode(
  node: CandidateNode,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
  thinkingLevels: string[],
): void {
  for (const [rawKey, value] of Object.entries(node.value)) {
    const key = normalizeToken(rawKey);
    const path = joinPath(node.path, rawKey);

    if (CAPABILITY_CONTAINER_KEYS.has(key)) {
      inspectCapabilityContainer(value, path, assignments, thinkingLevels);
    }

    const capability = capabilityForToken(key);
    if (capability) {
      const state = supportState(value);
      if (state !== undefined) assignments[capability].push({ state, path });
      if (capability === 'reasoning') {
        thinkingLevels.push(...levelsFromCapabilityValue(value));
      }
    }

    if (TASK_KEYS.has(key)) inspectTokenList(value, path, assignments);
    if (MODALITY_KEYS.has(key)) inspectModalities(value, path, assignments);
    if (THINKING_LEVEL_KEYS.has(key)) thinkingLevels.push(...normalizeLevels(value));
  }
}

function inspectCapabilityContainer(
  value: unknown,
  path: string,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
  thinkingLevels: string[],
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const entryPath = `${path}[${index}]`;
      if (typeof entry === 'string') {
        assignToken(entry, true, entryPath, assignments);
        continue;
      }
      const object = asObject(entry);
      if (!object) continue;
      const label = firstString(object, ['key', 'name', 'id', 'type', 'capability', 'feature']);
      if (label) {
        assignToken(label, supportState(object) ?? true, entryPath, assignments);
        if (capabilityForToken(label) === 'reasoning') {
          thinkingLevels.push(...levelsFromCapabilityValue(object));
        }
      } else {
        inspectCapabilityObject(object, entryPath, assignments, thinkingLevels);
      }
    }
    return;
  }

  if (typeof value === 'string') {
    for (const token of splitTokens(value)) assignToken(token, true, path, assignments);
    return;
  }

  const object = asObject(value);
  if (object) inspectCapabilityObject(object, path, assignments, thinkingLevels);
}

function inspectCapabilityObject(
  object: JsonObject,
  path: string,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
  thinkingLevels: string[],
): void {
  for (const [rawKey, value] of Object.entries(object)) {
    const capability = capabilityForToken(rawKey);
    if (!capability) continue;
    const state = supportState(value);
    if (state !== undefined) assignments[capability].push({ state, path: joinPath(path, rawKey) });
    if (capability === 'reasoning') {
      thinkingLevels.push(...levelsFromCapabilityValue(value));
    }
  }
}

function inspectTokenList(
  value: unknown,
  path: string,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
): void {
  const values = Array.isArray(value) ? value : [value];
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string') continue;
    assignToken(
      values[index],
      true,
      Array.isArray(value) ? `${path}[${index}]` : path,
      assignments,
    );
  }
}

function inspectModalities(
  value: unknown,
  path: string,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
): void {
  const tokens: string[] = [];
  collectStrings(value, tokens);
  if (tokens.some((token) => capabilityForToken(token) === 'vision')) {
    assignments.vision.push({ state: true, path });
  }
}

function assignToken(
  rawToken: string,
  state: ScannedCapabilityState,
  path: string,
  assignments: Record<ModelCapabilityKey, Assignment[]>,
): void {
  const capability = capabilityForToken(rawToken);
  if (capability) assignments[capability].push({ state, path });
}

function capabilityForToken(rawValue: string): ModelCapabilityKey | undefined {
  let token = normalizeToken(rawValue);
  token = token.replace(/^(?:supports?|has|can|is)_/, '').replace(/_supported$/, '');

  for (const key of MODEL_CAPABILITY_KEYS) {
    if (CAPABILITY_ALIASES[key].has(token)) return key;
  }

  // Endpoint declarations are still explicit metadata, but may include a version
  // prefix or leading slash that an ordinary alias does not have.
  if (/(?:^|_)chat_completions?$/.test(token)) return 'chat';
  if (/(?:^|_)responses?$/.test(token)) return 'responses';
  if (/(?:^|_)embeddings?$/.test(token)) return 'embeddings';
  return undefined;
}

function supportState(value: unknown): ScannedCapabilityState | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const state = normalizeToken(value);
    if (TRUE_STATES.has(state)) return true;
    if (FALSE_STATES.has(state)) return false;
    if (UNKNOWN_STATES.has(state)) return 'unconfirmed';
    return undefined;
  }
  if (Array.isArray(value)) return value.length ? true : undefined;
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of ['supported', 'enabled', 'available', 'value', 'status']) {
    if (object[key] === undefined) continue;
    const state = supportState(object[key]);
    if (state !== undefined) return state;
  }
  if (levelsFromCapabilityValue(object).length) return true;
  return undefined;
}

function resolveAssignments(values: Assignment[]): ScannedCapabilityState {
  if (!values.length) return 'unconfirmed';
  const runtimeValues = values.filter(({ path }) => path.startsWith('runtimeStatus.'));
  const authoritative = runtimeValues.length ? runtimeValues : values;
  const states = new Set(authoritative.map(({ state }) => state));
  return states.size === 1 ? authoritative[0]!.state : 'unconfirmed';
}

function levelsFromCapabilityValue(value: unknown): string[] {
  const object = asObject(value);
  if (!object) return [];
  for (const [rawKey, candidate] of Object.entries(object)) {
    const key = normalizeToken(rawKey);
    if (
      THINKING_LEVEL_KEYS.has(key) ||
      key === 'levels' ||
      key === 'efforts' ||
      key === 'supported_levels'
    ) {
      return normalizeLevels(candidate);
    }
  }
  return [];
}

function normalizeLevels(value: unknown): string[] {
  const raw: string[] = [];
  if (Array.isArray(value)) {
    collectStrings(value, raw);
  } else if (typeof value === 'string') {
    raw.push(...splitTokens(value));
  } else {
    const object = asObject(value);
    if (object) {
      for (const [key, enabled] of Object.entries(object)) {
        if (supportState(enabled) === true) raw.push(key);
      }
    }
  }
  return raw.map(normalizeThinkingLevel).filter((level): level is string => Boolean(level));
}

function normalizeThinkingLevel(value: string): string | undefined {
  const normalized = normalizeToken(value);
  if (['provider_default', 'default', 'auto'].includes(normalized)) return 'PROVIDER_DEFAULT';
  if (['off', 'none', 'disabled'].includes(normalized)) return 'OFF';
  if (normalized === 'minimal') return 'MINIMAL';
  if (normalized === 'low') return 'LOW';
  if (normalized === 'medium') return 'MEDIUM';
  if (normalized === 'high') return 'HIGH';
  if (['xhigh', 'x_high', 'extra_high'].includes(normalized)) return 'XHIGH';
  if (normalized === 'max') return 'MAX';
  return undefined;
}

function collectStrings(value: unknown, result: string[]): void {
  if (typeof value === 'string') {
    result.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
    return;
  }
  const object = asObject(value);
  if (!object) return;
  for (const [key, nested] of Object.entries(object)) {
    if (nested === true) result.push(key);
    else collectStrings(nested, result);
  }
}

function firstString(value: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function splitTokens(value: string): string[] {
  return value
    .split(/[\s,|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
