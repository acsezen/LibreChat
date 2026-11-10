const mockConstructed = [];

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {},
  registerShutdownTask: jest.fn(),
}));
jest.mock('~/models', () => ({}));
jest.mock('@vectorize-io/hindsight-librechat', () => {
  const actual = jest.requireActual('@vectorize-io/hindsight-librechat');
  return {
    ...actual,
    LibreChatMemory: function LibreChatMemory(getSecret, report) {
      mockConstructed.push(report);
      this.close = jest.fn();
    },
  };
});

const { logger, tenantStorage } = require('@librechat/data-schemas');
require('~/server/services/HindsightMemory');

/** The reporter HindsightMemory.js hands the adapter, called inside a request's log context. */
function reportDuring(event) {
  const calls = [];
  const capture = (level) => (message) =>
    calls.push({ level, message, context: tenantStorage.getStore() });
  const info = jest.spyOn(logger, 'info').mockImplementation(capture('info'));
  const warn = jest.spyOn(logger, 'warn').mockImplementation(capture('warn'));
  try {
    tenantStorage.run(
      {
        tenantId: 'tenant-a',
        userId: 'owner',
        requestId: 'req-1',
        requestMethod: 'POST',
        requestPath: '/api/agents',
      },
      () => mockConstructed[0](event),
    );
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
  return calls;
}

describe('HindsightMemory event logging', () => {
  it('passes the adapter one reporter', () => {
    expect(mockConstructed).toHaveLength(1);
  });

  it('logs a completed capture as info with its code, without the waking request', () => {
    expect(reportDuring({ code: 'capture_completed', operationId: 'op-1' })).toEqual([
      {
        level: 'info',
        message: '[hindsight-memory] capture_completed operation=op-1',
        context: { tenantId: 'tenant-a', userId: 'owner' },
      },
    ]);
  });

  it('logs a delivery failure as a warning without the waking request', () => {
    const [call] = reportDuring({
      code: 'capture_retry_pending',
      operationId: 'op-2',
      status: 503,
    });
    expect(call.level).toBe('warn');
    expect(call.message).toBe('[hindsight-memory] capture_retry_pending operation=op-2 status=503');
    expect(call.context).toEqual({ tenantId: 'tenant-a', userId: 'owner' });
  });

  it('keeps the request context for events that belong to the request', () => {
    const [call] = reportDuring({ code: 'retrieval_unavailable', status: 504 });
    expect(call).toMatchObject({
      level: 'warn',
      message: '[hindsight-memory] retrieval_unavailable status=504',
      context: { requestId: 'req-1', requestPath: '/api/agents', userId: 'owner' },
    });
  });
});
