import { thinkingLevels, type PromptMode, type ThinkingLevel } from '@spiderwebrouter/contracts';

export interface DeleteModelResult {
  id: string;
  deleted: true;
  hidden: true;
  mode: 'HARD_DELETE' | 'ARCHIVED';
  reason: null | 'HISTORY_PRESERVED';
}

export function modelDeletionNotice(
  result: DeleteModelResult,
): 'PERMANENTLY_DELETED' | 'HISTORY_PRESERVED' {
  return result.mode === 'ARCHIVED' && result.reason === 'HISTORY_PRESERVED'
    ? 'HISTORY_PRESERVED'
    : 'PERMANENTLY_DELETED';
}

export const promptModePresentation: Record<
  PromptMode,
  {
    labelZh: string;
    labelEn: string;
    descriptionZh: string;
    descriptionEn: string;
  }
> = {
  NONE: {
    labelZh: '不套用',
    labelEn: 'None',
    descriptionZh: '不注入平台提示詞，保留客戶送出的 system、developer 與 instructions。',
    descriptionEn:
      'Do not inject a platform prompt; preserve customer system, developer, and instructions.',
  },
  PREPEND: {
    labelZh: '前置附加',
    labelEn: 'Prepend',
    descriptionZh: '將平台提示詞放在最前面，並保留客戶送出的所有指令。',
    descriptionEn:
      'Place the platform prompt first and preserve all instructions supplied by the customer.',
  },
  REPLACE: {
    labelZh: '取代',
    labelEn: 'Replace',
    descriptionZh:
      '移除客戶送出的 system、developer 與 instructions，只採用平台提示詞；user 與 tool 內容仍會保留。',
    descriptionEn:
      'Remove customer system, developer, and instructions and use only the platform prompt; user and tool content is preserved.',
  },
};

/**
 * Provider default is not an asserted thinking level; it means that the router
 * does not override the upstream. Once a provider reports concrete levels, the
 * picker hides every other unconfirmed level.
 */
export function selectableThinkingLevels(
  confirmedLevels: readonly ThinkingLevel[],
): ThinkingLevel[] {
  const confirmed = new Set(
    confirmedLevels.filter((level): level is ThinkingLevel => level !== 'PROVIDER_DEFAULT'),
  );
  if (!confirmed.size) return [...thinkingLevels];

  return thinkingLevels.filter((level) => level === 'PROVIDER_DEFAULT' || confirmed.has(level));
}

export function thinkingLevelToWire(level: ThinkingLevel): string | undefined {
  if (level === 'PROVIDER_DEFAULT') return undefined;
  return level === 'OFF' ? 'none' : level.toLowerCase();
}
