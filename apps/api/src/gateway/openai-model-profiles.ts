import type {
  ModelCapabilityKey,
  ScannedCapabilityState,
  ScannedModelCapabilities,
} from './gateway.types';
import type { CapabilityEvidence, ModelCapabilityDetection } from './model-capability-detection';

export type CatalogThinkingLevel = 'OFF' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH' | 'MAX';

export type ParameterSupportState = boolean | 'unconfirmed';

export interface OpenAIModelProfile {
  id: string;
  match: readonly RegExp[];
  capabilities: Readonly<Record<ModelCapabilityKey, ScannedCapabilityState>> & {
    readonly nativeResponses: boolean;
  };
  supportedThinkingLevels: readonly CatalogThinkingLevel[];
  parameterSupport: Readonly<{ temperature: ParameterSupportState }>;
  thinkingWire: Readonly<{ off: 'minimal' | 'none' }>;
  sourceUrl: string;
  catalogRevision: string;
}

const CATALOG_REVISION = '2026-08-09';
const MODEL_CATALOG_URL = 'https://developers.openai.com/api/docs/models/all';
const GPT_56_URL = 'https://developers.openai.com/api/docs/models/gpt-5.6-sol';

const modernReasoning = capabilities({
  chat: true,
  responses: true,
  embeddings: false,
  vision: true,
  tools: true,
  structuredOutput: true,
  streaming: true,
  reasoning: true,
  nativeResponses: true,
});
const responsesReasoning = capabilities({
  chat: false,
  responses: true,
  embeddings: false,
  vision: true,
  tools: true,
  structuredOutput: true,
  streaming: true,
  reasoning: true,
  nativeResponses: true,
});
const modernNonReasoning = capabilities({
  chat: true,
  responses: true,
  embeddings: false,
  vision: true,
  tools: true,
  structuredOutput: true,
  streaming: true,
  reasoning: false,
  nativeResponses: true,
});
const embeddings = capabilities({
  chat: false,
  responses: false,
  embeddings: true,
  vision: false,
  tools: false,
  structuredOutput: false,
  streaming: false,
  reasoning: false,
  nativeResponses: false,
});
const unsupportedByRouter = capabilities({
  chat: false,
  responses: false,
  embeddings: false,
  vision: false,
  tools: false,
  structuredOutput: false,
  streaming: false,
  reasoning: false,
  nativeResponses: false,
});

/**
 * Versioned, passive catalog for model IDs owned by OpenAI. Every matcher is
 * anchored so vendor-prefixed, similarly named, and fine-tuned IDs do not
 * inherit an official capability contract by accident.
 */
export const OPENAI_MODEL_PROFILES: readonly OpenAIModelProfile[] = [
  profile(
    'gpt-5.6',
    [/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/],
    modernReasoning,
    ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'],
    false,
    GPT_56_URL,
    'none',
  ),
  profile(
    'gpt-5.5',
    [/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/],
    modernReasoning,
    ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
    'unconfirmed',
    MODEL_CATALOG_URL,
    'none',
  ),
  profile(
    'gpt-5.5-pro',
    [/^gpt-5\.5-pro(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...responsesReasoning, streaming: false }),
    ['MEDIUM', 'HIGH', 'XHIGH'],
  ),
  profile(
    'gpt-5.4',
    [/^gpt-5\.4(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/],
    modernReasoning,
    ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
    'unconfirmed',
    MODEL_CATALOG_URL,
    'none',
  ),
  profile(
    'gpt-5.4-pro',
    [/^gpt-5\.4-pro(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...responsesReasoning, structuredOutput: false }),
    ['MEDIUM', 'HIGH', 'XHIGH'],
  ),
  profile('gpt-5.3-codex', [/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/], responsesReasoning, [
    'LOW',
    'MEDIUM',
    'HIGH',
    'XHIGH',
  ]),
  profile('gpt-5.3-chat', [/^gpt-5\.3-chat-latest$/], modernNonReasoning, []),
  profile(
    'gpt-5.2',
    [/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/],
    modernReasoning,
    ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
    'unconfirmed',
    MODEL_CATALOG_URL,
    'none',
  ),
  profile(
    'gpt-5.2-pro',
    [/^gpt-5\.2-pro(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...responsesReasoning, structuredOutput: false }),
    ['MEDIUM', 'HIGH', 'XHIGH'],
  ),
  profile('gpt-5.2-codex', [/^gpt-5\.2-codex(?:-\d{4}-\d{2}-\d{2})?$/], responsesReasoning, [
    'LOW',
    'MEDIUM',
    'HIGH',
    'XHIGH',
  ]),
  profile('gpt-5.2-chat', [/^gpt-5\.2-chat-latest$/], modernNonReasoning, []),
  profile(
    'gpt-5.1',
    [/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/],
    modernReasoning,
    ['OFF', 'LOW', 'MEDIUM', 'HIGH'],
    'unconfirmed',
    MODEL_CATALOG_URL,
    'none',
  ),
  profile(
    'gpt-5.1-codex-max',
    [/^gpt-5\.1-codex-max(?:-\d{4}-\d{2}-\d{2})?$/],
    responsesReasoning,
    ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
  ),
  profile(
    'gpt-5.1-codex',
    [/^gpt-5\.1-codex(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/],
    responsesReasoning,
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile('gpt-5.1-chat', [/^gpt-5\.1-chat-latest$/], modernNonReasoning, []),
  profile('gpt-5', [/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/], modernReasoning, [
    'MINIMAL',
    'LOW',
    'MEDIUM',
    'HIGH',
  ]),
  profile('gpt-5-pro', [/^gpt-5-pro(?:-\d{4}-\d{2}-\d{2})?$/], responsesReasoning, ['HIGH']),
  profile(
    'gpt-5-codex',
    [/^(?:gpt-5-codex|codex-mini-latest)(?:-\d{4}-\d{2}-\d{2})?$/],
    responsesReasoning,
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile('gpt-5-chat', [/^gpt-5-chat-latest$/], modernNonReasoning, []),
  profile(
    'o3-pro',
    [/^o3-pro(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...responsesReasoning, streaming: false }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile('o3', [/^o3(?:-\d{4}-\d{2}-\d{2})?$/], modernReasoning, ['LOW', 'MEDIUM', 'HIGH']),
  profile(
    'o3-mini',
    [/^o3-mini(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...modernReasoning, vision: false }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile('o4-mini', [/^o4-mini(?:-\d{4}-\d{2}-\d{2})?$/], modernReasoning, [
    'LOW',
    'MEDIUM',
    'HIGH',
  ]),
  profile('o1', [/^o1(?:-\d{4}-\d{2}-\d{2})?$/], modernReasoning, ['LOW', 'MEDIUM', 'HIGH']),
  profile(
    'o1-preview',
    [/^o1-preview(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernReasoning,
      responses: false,
      vision: false,
      nativeResponses: false,
    }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile(
    'o1-mini',
    [/^o1-mini(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernReasoning,
      responses: false,
      vision: false,
      tools: false,
      structuredOutput: false,
      nativeResponses: false,
    }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile(
    'o1-pro',
    [/^o1-pro(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({ ...responsesReasoning, streaming: false }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile(
    'gpt-4.1',
    [/^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/],
    modernNonReasoning,
    [],
    true,
  ),
  profile('gpt-4o', [/^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/], modernNonReasoning, [], true),
  profile(
    'gpt-4.5-preview',
    [/^gpt-4\.5-preview(?:-\d{4}-\d{2}-\d{2})?$/],
    modernNonReasoning,
    [],
    true,
  ),
  profile('chat-latest', [/^chat-latest$/], modernNonReasoning, [], true),
  profile(
    'chatgpt-4o-latest',
    [/^chatgpt-4o-latest$/],
    capabilities({
      ...modernNonReasoning,
      tools: false,
      structuredOutput: false,
    }),
    [],
    true,
  ),
  profile(
    'gpt-search-preview',
    [/^gpt-4o(?:-mini)?-search-preview(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernNonReasoning,
      responses: false,
      vision: false,
      tools: false,
      structuredOutput: true,
      nativeResponses: false,
    }),
    [],
    true,
  ),
  profile(
    'gpt-4-turbo',
    [/^gpt-4-turbo$/, /^gpt-4-turbo-2024-04-09$/],
    capabilities({
      ...modernNonReasoning,
      structuredOutput: false,
    }),
    [],
    true,
  ),
  profile(
    'gpt-4-turbo-preview',
    [/^gpt-4-turbo-preview$/, /^gpt-4-(?:1106|0125)-preview$/],
    capabilities({
      ...modernNonReasoning,
      vision: false,
      structuredOutput: false,
    }),
    [],
    true,
  ),
  profile(
    'gpt-4',
    [/^gpt-4(?:-\d{4}|-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernNonReasoning,
      vision: false,
      tools: false,
      structuredOutput: false,
    }),
    [],
    true,
  ),
  profile(
    'gpt-3.5-turbo',
    [/^gpt-3\.5-turbo(?:-\d{4}|-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernNonReasoning,
      vision: false,
      tools: false,
      structuredOutput: false,
      streaming: false,
    }),
    [],
    true,
  ),
  profile(
    'embeddings',
    [/^(?:text-embedding-3-(?:large|small)|text-embedding-ada-002)$/],
    embeddings,
    [],
    false,
  ),
  profile(
    'deep-research',
    [/^(?:o3|o4-mini)-deep-research(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...responsesReasoning,
      chat: false,
      vision: true,
      tools: false,
      structuredOutput: false,
    }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile(
    'computer-use',
    [/^computer-use-preview(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...responsesReasoning,
      chat: false,
      structuredOutput: false,
      streaming: false,
    }),
    [],
  ),
  profile(
    'gpt-oss',
    [/^gpt-oss-(?:20b|120b)$/],
    capabilities({ ...responsesReasoning, vision: false }),
    ['LOW', 'MEDIUM', 'HIGH'],
  ),
  profile(
    'audio-chat',
    [
      /^gpt-audio(?:-1\.5)?(?:-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o(?:-mini)?-audio-preview(?:-\d{4}-\d{2}-\d{2})?$/,
    ],
    capabilities({
      ...modernNonReasoning,
      responses: false,
      vision: false,
      structuredOutput: false,
      nativeResponses: false,
    }),
    [],
    true,
  ),
  profile(
    'audio-chat-mini',
    [/^gpt-audio-mini(?:-\d{4}-\d{2}-\d{2})?$/],
    capabilities({
      ...modernNonReasoning,
      responses: false,
      vision: false,
      structuredOutput: false,
      streaming: false,
      nativeResponses: false,
    }),
    [],
    true,
  ),
  profile(
    'router-unsupported-specialists',
    [
      /^omni-moderation(?:-latest|-\d{4}-\d{2}-\d{2})$/,
      /^gpt-image-(?:1(?:\.5|-mini)?|2)(?:-\d{4}-\d{2}-\d{2})?$/,
      /^chatgpt-image-latest$/,
      /^gpt-realtime(?:-[a-z0-9.]+)*(?:-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o(?:-mini)?-realtime-preview(?:-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-live-transcribe(?:-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-(?:4o(?:-mini)?-)?transcribe(?:-diarize)?(?:-\d{4}-\d{2}-\d{2})?$/,
      /^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/,
      /^(?:tts-1(?:-hd)?|whisper-1)$/,
      /^sora-2(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/,
      /^dall-e-[23]$/,
      /^(?:babbage|davinci)-002$/,
      /^gpt-4-1106-vision-preview$/,
      /^gpt-3\.5-turbo-instruct(?:-0914)?$/,
      /^text-moderation-(?:latest|stable)$/,
    ],
    unsupportedByRouter,
    [],
    false,
  ),
] as const;

export function findOpenAIModelProfile(modelId: string): OpenAIModelProfile | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized || normalized.startsWith('ft:')) return undefined;
  return OPENAI_MODEL_PROFILES.find((profile) =>
    profile.match.some((matcher) => matcher.test(normalized)),
  );
}

export function resolveOpenAIModelProfile(
  providerType: string,
  modelId: string,
): OpenAIModelProfile | undefined {
  return providerType === 'OPENAI' ? findOpenAIModelProfile(modelId) : undefined;
}

export function enrichWithOpenAIOfficialProfile(
  detection: ModelCapabilityDetection,
  modelId: string,
): ModelCapabilityDetection {
  const profile = findOpenAIModelProfile(modelId);
  if (!profile) return detection;

  const capabilities: ScannedModelCapabilities = { ...detection.capabilities };
  const evidence = { ...detection.evidence };
  for (const key of Object.keys(profile.capabilities) as (keyof typeof profile.capabilities)[]) {
    if (key === 'nativeResponses') continue;
    if (capabilities[key] !== 'unconfirmed') continue;
    const state = profile.capabilities[key];
    capabilities[key] = state;
    evidence[key] = [
      ...(evidence[key] ?? []),
      officialEvidence(profile, `capabilities.${key}`, state),
    ];
  }

  if (detection.capabilities.responses === 'unconfirmed' && profile.capabilities.nativeResponses) {
    capabilities.nativeResponses = true;
  }

  const upstreamLevels = detection.supportedThinkingLevels;
  const supportedThinkingLevels = upstreamLevels?.length
    ? upstreamLevels
    : capabilities.reasoning === true
      ? [...profile.supportedThinkingLevels]
      : [];
  if (!upstreamLevels?.length && supportedThinkingLevels.length) {
    evidence.reasoning = [
      ...(evidence.reasoning ?? []),
      ...supportedThinkingLevels.map((level) =>
        officialEvidence(profile, `supportedThinkingLevels.${level}`, true),
      ),
    ];
  }

  return {
    capabilities,
    evidence,
    ...(supportedThinkingLevels.length ? { supportedThinkingLevels } : {}),
    parameterSupport: profile.parameterSupport,
    officialProfile: {
      id: profile.id,
      sourceUrl: profile.sourceUrl,
      catalogRevision: profile.catalogRevision,
    },
  };
}

function officialEvidence(
  profile: OpenAIModelProfile,
  path: string,
  state: ScannedCapabilityState,
): CapabilityEvidence {
  return {
    source: 'official_catalog',
    path: `openai.${profile.id}.${path}`,
    state,
    sourceUrl: profile.sourceUrl,
    catalogRevision: profile.catalogRevision,
  };
}

function capabilities(value: ScannedModelCapabilities): Readonly<
  Record<ModelCapabilityKey, ScannedCapabilityState>
> & {
  readonly nativeResponses: boolean;
} {
  return Object.freeze(value);
}

function profile(
  id: string,
  match: readonly RegExp[],
  capabilityMap: OpenAIModelProfile['capabilities'],
  supportedThinkingLevels: readonly CatalogThinkingLevel[],
  temperature: ParameterSupportState = 'unconfirmed',
  sourceUrl = MODEL_CATALOG_URL,
  offWireValue: 'minimal' | 'none' = 'minimal',
): OpenAIModelProfile {
  return Object.freeze({
    id,
    match,
    capabilities: capabilityMap,
    supportedThinkingLevels,
    parameterSupport: Object.freeze({ temperature }),
    thinkingWire: Object.freeze({ off: offWireValue }),
    sourceUrl,
    catalogRevision: CATALOG_REVISION,
  });
}
