import { describe, expect, it } from 'vitest';

import {
  modelDeletionNotice,
  promptModePresentation,
  selectableThinkingLevels,
  thinkingLevelToWire,
} from '@/lib/modelForm';

describe('modelDeletionNotice', () => {
  it('distinguishes permanent deletion from history-preserving archival', () => {
    expect(
      modelDeletionNotice({
        id: 'model-1',
        deleted: true,
        hidden: true,
        mode: 'HARD_DELETE',
        reason: null,
      }),
    ).toBe('PERMANENTLY_DELETED');
    expect(
      modelDeletionNotice({
        id: 'model-2',
        deleted: true,
        hidden: true,
        mode: 'ARCHIVED',
        reason: 'HISTORY_PRESERVED',
      }),
    ).toBe('HISTORY_PRESERVED');
  });
});

describe('selectableThinkingLevels', () => {
  it('shows only provider default and explicitly confirmed levels when evidence exists', () => {
    expect(selectableThinkingLevels(['OFF', 'HIGH', 'MAX'])).toEqual([
      'PROVIDER_DEFAULT',
      'OFF',
      'HIGH',
      'MAX',
    ]);
  });

  it('keeps manual choices available when the provider reports no levels', () => {
    expect(selectableThinkingLevels([])).toEqual([
      'PROVIDER_DEFAULT',
      'OFF',
      'MINIMAL',
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
    ]);
  });
});

describe('promptModePresentation', () => {
  it('provides Chinese labels and explanations for every system prompt mode', () => {
    expect(Object.keys(promptModePresentation)).toEqual(['NONE', 'PREPEND', 'REPLACE']);
    expect(
      Object.values(promptModePresentation).every(
        (item) => item.labelZh.length > 0 && item.descriptionZh.length > 0,
      ),
    ).toBe(true);
  });
});

describe('thinkingLevelToWire', () => {
  it('uses the public OpenAI-compatible spelling for off and confirmed efforts', () => {
    expect(thinkingLevelToWire('OFF')).toBe('none');
    expect(thinkingLevelToWire('XHIGH')).toBe('xhigh');
    expect(thinkingLevelToWire('MAX')).toBe('max');
    expect(thinkingLevelToWire('PROVIDER_DEFAULT')).toBeUndefined();
  });
});
