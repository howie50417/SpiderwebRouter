import type { ThinkingLevel } from '@spiderwebrouter/contracts';

import { thinkingLevelToWire } from '@/lib/modelForm';
import type { ModelOption } from '@/types';

export function playgroundModelControls(
  mode: 'chat' | 'responses' | 'embeddings',
  model: ModelOption | undefined,
  temperature: number | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): Record<string, unknown> {
  if (mode === 'embeddings') return {};

  const result: Record<string, unknown> = {};
  if (temperature !== undefined && model?.parameterSupport.temperature !== false) {
    result.temperature = temperature;
  }

  if (
    model?.thinkingControlMode !== 'USER_SELECTABLE' ||
    !thinkingLevel ||
    !model.supportedThinkingLevels.includes(thinkingLevel)
  ) {
    return result;
  }

  const effort = thinkingLevelToWire(thinkingLevel);
  if (!effort) return result;
  if (mode === 'chat') result.reasoning_effort = effort;
  else result.reasoning = { effort };
  return result;
}
