import { describe, expect, it } from 'vitest';

import { playgroundModelControls } from '@/lib/playgroundRequest';
import type { ModelOption } from '@/types';

const model: ModelOption = {
  id: 'grant-1',
  name: 'gpt-5.6-sol',
  capabilities: { chat: true, responses: true, reasoning: true },
  thinkingControlMode: 'USER_SELECTABLE',
  supportedThinkingLevels: ['OFF', 'LOW', 'HIGH'],
  parameterSupport: { temperature: false },
};

describe('playgroundModelControls', () => {
  it('omits unsupported temperature and emits the Chat reasoning field', () => {
    expect(playgroundModelControls('chat', model, 0.7, 'OFF')).toEqual({
      reasoning_effort: 'none',
    });
  });

  it('uses the nested Responses reasoning field', () => {
    expect(playgroundModelControls('responses', model, 0.7, 'HIGH')).toEqual({
      reasoning: { effort: 'high' },
    });
  });

  it('does not send unconfirmed levels or generation controls to embeddings', () => {
    expect(playgroundModelControls('chat', model, undefined, 'MAX')).toEqual({});
    expect(playgroundModelControls('embeddings', model, 0.7, 'LOW')).toEqual({});
  });
});
