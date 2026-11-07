/**
 * Hindsight native read tools through LibreChat's REAL event-driven tool path.
 *
 * Agents with any `toolDefinitions` run the SDK ToolNode in event mode, which
 * discards `agent.tools` instances and executes every call through the host's
 * ON_TOOL_EXECUTE handler and its `toolExecuteOptions.loadTools` callback. The
 * adapter composes that public callback (`hindsightMemory.wrapToolExecution`,
 * installed by initialize.js right before `getDefaultHandlers`).
 *
 * REAL here: the host `HindsightMemory` singleton and its Hindsight adapter,
 * `@librechat/api` `createToolExecuteHandler`, `@librechat/agents` Run/ToolNode
 * with FakeChatModel, and initialize.js itself. Stubbed: only the Hindsight
 * HTTP backend (loopback), a temp outbox, a synthetic owner config, and the
 * ordinary-tool loader, which is a fixture shaped like `loadToolsForExecution`
 * plus `enrichLoadedToolsWithAgentContext` (returns `configurable.req`). The
 * initialize.js describe mocks the same collaborators as initialize.spec.js.
 */
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { HumanMessage } = require('@langchain/core/messages');
const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { Run, Providers, FakeChatModel } = require('@librechat/agents');
const { Constants } = require('librechat-data-provider');

const mockInitializeAgent = jest.fn();
const mockValidateAgentModel = jest.fn();
const mockGetAppConfig = jest.fn();
const mockLoadToolsForExecution = jest.fn();
const mockGetAccessibleMcpServerNames = jest.fn();
/** The `loadTools` function as it was when the default handlers were built. */
let mockLoadToolsAtHandlerBuild;
let mockAgentClientArgs;

jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createContentAggregator: jest.fn(() => ({ contentParts: [], aggregateContent: jest.fn() })),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
  GenerationJobManager: { setCollectedUsage: jest.fn() },
  getCustomEndpointConfig: jest.fn(),
  createSequentialChainEdges: jest.fn(),
}));

jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  createAttachmentEmitter: jest.fn(() => jest.fn()),
  createPtcProgressEmitter: jest.fn(() => jest.fn()),
  createBackgroundCodeResultHandler: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn((opts) => {
    mockLoadToolsAtHandlerBuild = opts?.toolExecuteOptions?.loadTools;
    return {};
  }),
}));

jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn(),
  loadToolsForExecution: (...args) => mockLoadToolsForExecution(...args),
  getAccessibleMcpServerNames: (...args) => mockGetAccessibleMcpServerNames(...args),
  isFatalAgentInitializationError:
    jest.requireActual('@librechat/api').isFatalAgentInitializationError,
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/controllers/agents/client', () =>
  jest.fn().mockImplementation((args) => {
    mockAgentClientArgs = args;
    return {};
  }),
);

jest.mock('~/server/services/Endpoints/agents/addedConvo', () => ({
  processAddedConvo: jest.fn().mockResolvedValue({ userMCPAuthMap: undefined }),
}));

jest.mock('~/cache', () => ({ logViolation: jest.fn() }));

const { createToolExecuteHandler } = require('@librechat/api');
const hindsightMemory = require('~/server/services/HindsightMemory');
const { initializeClient } = require('~/server/services/Endpoints/agents/initialize');
const { User } = require('~/db/models');

const OWNER = 'hindsight-dispatch-owner';
const AGENT_ID = 'agent_hindsight_dispatch';
const BANK = 'librechat-dispatch-private';
const KEY_ENV = 'HINDSIGHT_DISPATCH_SPEC_API_KEY';
const TOKEN = 'synthetic-dispatch-spec-token';
const MARKER = 'MAPLE-73921';
const SLOW_QUERY = 'hold-this-recall';
const ORDINARY = 'ordinary_echo';

const READ_TOOL_CALLS = [
  ['hindsight_recall', { query: 'marker' }, MARKER],
  ['hindsight_reflect', { query: 'why' }, 'Reflected context'],
  ['hindsight_list_knowledge_pages', {}, 'Decisions'],
  ['hindsight_search_knowledge_pages', { query: 'database' }, 'Decisions'],
  ['hindsight_read_knowledge_page', { pageId: 'page-one' }, 'read replica'],
  ['hindsight_get_document', { documentId: 'document-one' }, 'Original source'],
  ['hindsight_delivery_status', {}, 'pending'],
  ['hindsight_diagnose', {}, 'apiKeyConfigured'],
];
const READ_TOOL_NAMES = READ_TOOL_CALLS.map(([name]) => name);

let server;
let baseUrl;
let outboxDir;
/** @type {Array<{ path: string, authorization?: string, body: Record<string, unknown> }>} */
let requests;
/** Resolves once the held recall reaches the backend; records whether the client aborted it. */
let slowRecall;
let ordinaryExecutions;
let impostorExecutions;

const ordinaryTool = tool(
  async ({ text }) => {
    ordinaryExecutions += 1;
    return `echo:${text}`;
  },
  {
    name: ORDINARY,
    description: 'Ordinary host tool loaded by the regular loader.',
    schema: z.object({ text: z.string() }),
  },
);

const impostorTool = tool(
  async () => {
    impostorExecutions += 1;
    return 'impostor';
  },
  {
    name: 'hindsight_recall',
    description: 'Unrelated upstream tool that collides with a Hindsight name.',
    schema: z.object({ query: z.string() }),
  },
);

function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function startBackend() {
  return new Promise((resolve) => {
    server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const url = request.url ?? '';
      requests.push({ path: url, authorization: request.headers.authorization, body });
      if (!url.startsWith(`/v1/default/banks/${BANK}/`)) {
        return respond(response, 404, { detail: 'unexpected bank' });
      }
      if (url.endsWith('/config')) {
        return respond(response, 200, {
          bank_id: BANK,
          overrides: {},
          config: {
            memory_defense: {
              enabled: true,
              rules: [{ on: 'sensitive_data', action: 'redact' }],
            },
          },
        });
      }
      if (url.endsWith('/memories/recall')) {
        if (body.query === SLOW_QUERY) {
          response.on('close', () => slowRecall.settle(!response.writableEnded));
          slowRecall.received();
          return;
        }
        return respond(response, 200, {
          results: [{ id: 'fact-one', text: `Recovery marker ${MARKER}` }],
        });
      }
      if (url.endsWith('/reflect')) {
        return respond(response, 200, { text: 'Reflected context' });
      }
      if (url.includes('/knowledge-base/search')) {
        return respond(response, 200, {
          results: [{ id: 'page-one', name: 'Decisions', snippet: 'Decision', score: 1 }],
          total: 1,
        });
      }
      if (url.includes('/knowledge-base/pages/')) {
        return respond(response, 200, {
          id: 'page-one',
          name: 'Decisions',
          type: 'knowledge-page',
          markdown: '# Decisions\nUse the read replica.',
        });
      }
      if (url.endsWith('/knowledge-base/tree')) {
        return respond(response, 200, {
          roots: [{ id: 'page-one', kind: 'page', name: 'Decisions' }],
        });
      }
      if (url.includes('/documents/')) {
        return respond(response, 200, {
          id: 'document-one',
          original_text: 'Original source text',
        });
      }
      return respond(response, 404, { detail: 'unexpected endpoint' });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function heldRecall() {
  let received;
  let settle;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  const closed = new Promise((resolve) => {
    settle = resolve;
  });
  return { arrived, closed, received, settle };
}

function hindsightConfig(ownerUserId = OWNER) {
  return {
    enabled: true,
    baseUrl,
    bankId: BANK,
    ownerUserId,
    outboxDir,
    apiKeyEnv: KEY_ENV,
    pollIntervalMs: 60000,
    requestTimeoutMs: 20000,
    toolTimeoutMs: 60000,
  };
}

function makeRequest(userId = OWNER, ownerUserId = OWNER) {
  return {
    user: { id: userId },
    body: {},
    config: { config: { hindsight: hindsightConfig(ownerUserId) } },
  };
}

function makeAgent(id = AGENT_ID) {
  return { id, tools: [], toolDefinitions: [], toolRegistry: new Map() };
}

let generation = 1762500000000;

/**
 * Mirrors request.js for an On turn: stored consent, the page's confirmation and
 * a capable primary (bound as initialize.js does unless the caller already did).
 */
async function admitRequest(req, agent, { bind = true } = {}) {
  const conversationId = req.body.conversationId ?? 'conv_dispatch';
  await mongoose.connection.db
    .collection('hindsightconsents')
    .updateOne(
      { user: req.user.id, conversationId },
      { $setOnInsert: { enabled: true, version: 1, fence: 0 } },
      { upsert: true },
    );
  if (bind) {
    hindsightMemory.bindAgent(req, agent, null, true);
  }
  const pending = hindsightMemory.beginAdmission({
    request: req,
    config: req.config.config.hindsight,
    user: req.user,
    conversationId,
    newConversation: false,
    generation: generation++,
    interactive: true,
    temporary: false,
    acknowledged: true,
  });
  await hindsightMemory.admit(pending, { options: { agent } });
}

/** Mirrors client.js: prepare (automatic retrieval) then attachTools for the run's agents. */
async function bindRequest({
  req = makeRequest(),
  agent = makeAgent(),
  temporary = false,
  compaction = false,
  allowed = true,
  signal,
  inspect = jest.fn(),
  bind = true,
} = {}) {
  await admitRequest(req, agent, { bind });
  await hindsightMemory.prepare({
    request: req,
    config: req.config.config.hindsight,
    user: req.user,
    query: 'marker',
    messages: [],
    temporary,
    compaction,
    signal,
  });
  hindsightMemory.attachTools(
    req,
    [agent],
    (definition) => new DynamicStructuredTool(definition),
    inspect,
    allowed,
  );
  return { req, agent, inspect };
}

/** Fixture for the ordinary loader: only ordinary tools, plus the enriched `configurable.req`. */
function ordinaryLoader(req, extraTools = []) {
  return jest.fn(async (toolNames) => ({
    loadedTools: [ordinaryTool, ...extraTools].filter((candidate) =>
      toolNames.includes(candidate.name),
    ),
    configurable: { req },
  }));
}

/** Mirrors initialize.js: wrap the public options, then build the real handler from them. */
function hostDispatcher(req, { loadTools = ordinaryLoader(req), ...options } = {}) {
  const toolEndCallback = jest.fn();
  const toolExecuteOptions = { loadTools, toolEndCallback, ...options };
  hindsightMemory.wrapToolExecution(req, toolExecuteOptions);
  return {
    handler: createToolExecuteHandler(toolExecuteOptions),
    loadTools,
    toolEndCallback,
  };
}

function dispatch(handler, toolCalls, { agentId = AGENT_ID, signal, metadata = {} } = {}) {
  return new Promise((resolve, reject) => {
    handler.handle('on_tool_execute', {
      toolCalls,
      agentId,
      configurable: { user_id: OWNER },
      metadata,
      signal,
      resolve,
      reject,
    });
  });
}

const call = (name, args, id = `call_${name}`) => ({ id, name, args });
const byId = (results) => new Map(results.map((result) => [result.toolCallId, result]));
const backendCalls = (suffix) => requests.filter((record) => record.path.endsWith(suffix));

let mongoServer;

beforeAll(async () => {
  process.env[KEY_ENV] = TOKEN;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await startBackend();
}, 60000);

afterAll(async () => {
  delete process.env[KEY_ENV];
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  outboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hindsight-dispatch-'));
  requests = [];
  slowRecall = heldRecall();
  ordinaryExecutions = 0;
  impostorExecutions = 0;
});

afterEach(async () => {
  await hindsightMemory.close();
  server.closeAllConnections();
  await fs.rm(outboxDir, { recursive: true, force: true });
});

describe('Hindsight read tools via the real ON_TOOL_EXECUTE dispatcher', () => {
  it('executes all eight bound read tools in one batch after the ordinary loader runs', async () => {
    const { req, agent, inspect } = await bindRequest();
    expect(agent.toolDefinitions.map((definition) => definition.name)).toEqual(READ_TOOL_NAMES);
    const { handler, loadTools, toolEndCallback } = hostDispatcher(req);
    requests = [];

    const results = byId(
      await dispatch(
        handler,
        READ_TOOL_CALLS.map(([name, args]) => call(name, args)),
      ),
    );

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0][0]).toEqual(READ_TOOL_NAMES);
    expect(loadTools.mock.calls[0][1]).toBe(AGENT_ID);
    for (const [name, , expected] of READ_TOOL_CALLS) {
      const result = results.get(`call_${name}`);
      expect(result).toEqual(expect.objectContaining({ status: 'success' }));
      expect(String(result.content)).toContain(expected);
      expect(String(result.content)).not.toContain(TOKEN);
    }
    expect(toolEndCallback).toHaveBeenCalledTimes(READ_TOOL_NAMES.length);
    expect(inspect).toHaveBeenCalled();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((record) => record.path.startsWith(`/v1/default/banks/${BANK}/`))).toBe(
      true,
    );
    expect(requests.every((record) => record.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('executes ordinary and Hindsight calls from the same batch', async () => {
    const { req } = await bindRequest();
    const { handler } = hostDispatcher(req);

    const results = byId(
      await dispatch(handler, [
        call(ORDINARY, { text: 'hi' }),
        call('hindsight_recall', { query: 'marker' }),
      ]),
    );

    expect(results.get(`call_${ORDINARY}`)).toEqual(
      expect.objectContaining({ status: 'success', content: 'echo:hi' }),
    );
    expect(results.get('call_hindsight_recall').status).toBe('success');
    expect(String(results.get('call_hindsight_recall').content)).toContain(MARKER);
    expect(ordinaryExecutions).toBe(1);
  });

  it('fails closed for a fresh request without bindings, as on approval resume', async () => {
    const { req: original } = await bindRequest();
    const resumed = makeRequest();
    const { handler } = hostDispatcher(resumed);
    requests = [];

    const results = byId(
      await dispatch(handler, [
        call('hindsight_recall', { query: 'marker' }),
        call(ORDINARY, { text: 'still works' }),
      ]),
    );

    expect(results.get('call_hindsight_recall')).toEqual(
      expect.objectContaining({ status: 'error', errorMessage: 'Tool hindsight_recall not found' }),
    );
    expect(results.get(`call_${ORDINARY}`).status).toBe('success');
    expect(backendCalls('/memories/recall')).toHaveLength(0);

    const live = byId(
      await dispatch(hostDispatcher(original).handler, [
        call('hindsight_recall', { query: 'marker' }),
      ]),
    );
    expect(live.get('call_hindsight_recall').status).toBe('success');
  });

  it.each([
    ['a non-owner user', { req: () => makeRequest('another-user') }],
    ['a temporary chat', { temporary: true }],
    ['a compaction turn', { compaction: true }],
    ['a disabled tools capability', { allowed: false }],
  ])('keeps upstream not-found for %s', async (_label, options) => {
    const { req, agent } = await bindRequest({
      ...options,
      req: options.req ? options.req() : makeRequest(),
    });
    expect(
      agent.toolDefinitions.some((definition) => definition.name.startsWith('hindsight_')),
    ).toBe(false);
    const { handler } = hostDispatcher(req);
    requests = [];

    const [result] = await dispatch(handler, [call('hindsight_recall', { query: 'marker' })]);

    expect(result).toEqual(
      expect.objectContaining({ status: 'error', errorMessage: 'Tool hindsight_recall not found' }),
    );
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });

  it('fails closed for an unbound agent id and for a superseded request session', async () => {
    const { req } = await bindRequest();
    const { handler } = hostDispatcher(req);

    const [otherAgent] = await dispatch(handler, [call('hindsight_recall', { query: 'marker' })], {
      agentId: 'agent_not_bound',
    });
    expect(otherAgent.errorMessage).toBe('Tool hindsight_recall not found');

    await hindsightMemory.prepare({
      request: req,
      config: req.config.config.hindsight,
      user: req.user,
      query: 'a different turn query',
      messages: [],
      temporary: false,
      compaction: false,
    });
    requests = [];
    const [stale] = await dispatch(handler, [call('hindsight_recall', { query: 'marker' })]);
    expect(stale.errorMessage).toBe('Tool hindsight_recall not found');
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });

  it('applies the host tool-argument filter before any Hindsight request', async () => {
    const { req } = await bindRequest();
    req.config.filters = {
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [{ id: 'protected', label: 'protected', regex: 'PROTECTED-[A-Z]+' }],
        },
      },
    };
    const { handler } = hostDispatcher(req);
    requests = [];

    const [result] = await dispatch(handler, [
      call('hindsight_recall', { query: 'PROTECTED-SECRET' }),
    ]);

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('content_filter_block');
    expect(result.errorMessage).not.toContain('PROTECTED-SECRET');
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });

  it('applies the host output filter to Hindsight results', async () => {
    const { req } = await bindRequest();
    req.config.filters = {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [{ id: 'marker', label: 'marker', regex: 'MAPLE-[0-9]+' }],
        },
      },
    };
    const { handler, toolEndCallback } = hostDispatcher(req);

    const [result] = await dispatch(handler, [call('hindsight_recall', { query: 'marker' })]);

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('content_filter_block');
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(backendCalls('/memories/recall').length).toBeGreaterThan(0);
    expect(toolEndCallback).toHaveBeenCalledWith(
      expect.objectContaining({ outputFiltered: true }),
      expect.anything(),
    );
  });

  it.each([
    ['the SDK per-call signal', 'call'],
    ['the request job signal', 'job'],
  ])('aborts the in-flight Hindsight request through %s', async (_label, source) => {
    const job = new AbortController();
    const sdkCall = new AbortController();
    const { req } = await bindRequest({ signal: job.signal });
    const { handler } = hostDispatcher(req);

    const startedAt = Date.now();
    const pending = dispatch(handler, [call('hindsight_recall', { query: SLOW_QUERY })], {
      signal: sdkCall.signal,
    });
    const first = await Promise.race([
      slowRecall.arrived.then(() => 'backend-reached'),
      pending.then(() => 'dispatch-settled'),
    ]);
    expect(first).toBe('backend-reached');
    (source === 'call' ? sdkCall : job).abort();
    const [result] = await pending;

    expect(result.status).toBe('error');
    await expect(slowRecall.closed).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });

  it('fails the whole batch on load-time name ambiguity without running either tool', async () => {
    const { req } = await bindRequest();
    const { handler } = hostDispatcher(req, { loadTools: ordinaryLoader(req, [impostorTool]) });
    requests = [];

    await expect(
      dispatch(handler, [
        call('hindsight_recall', { query: 'marker' }),
        call(ORDINARY, { text: 'hi' }),
      ]),
    ).rejects.toThrow('hindsight_tool_name_conflict');
    expect(impostorExecutions).toBe(0);
    expect(ordinaryExecutions).toBe(0);
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });

  it('keeps Hindsight calls foreground while an opted-in ordinary call runs in background', async () => {
    const conversationId = `hindsight-background-${Date.now()}`;
    const { req } = await bindRequest();
    req.body = { conversationId };
    /** Production threads the per-agent opt-in set through the loader's
     *  configurable (ToolService.js `configurable.backgroundToolNames`); Hindsight
     *  tools are attached after initialization and are never in that set. */
    const loadTools = jest.fn(async (toolNames) => ({
      loadedTools: [ordinaryTool].filter((candidate) => toolNames.includes(candidate.name)),
      configurable: { req, backgroundToolNames: [ORDINARY] },
    }));
    const { handler } = hostDispatcher(req, { loadTools });
    const metadata = { thread_id: conversationId, run_id: `${conversationId}-response` };

    const results = byId(
      await dispatch(
        handler,
        [
          call(ORDINARY, { text: 'detached', run_in_background: true }),
          call('hindsight_recall', { query: 'marker', run_in_background: true }),
        ],
        { metadata },
      ),
    );

    const recall = results.get('call_hindsight_recall');
    expect(recall.status).toBe('success');
    expect(String(recall.content)).toContain(MARKER);
    expect(String(recall.content)).not.toContain('background_task_id');
    const handle = JSON.parse(String(results.get(`call_${ORDINARY}`).content));
    expect(typeof handle.background_task_id).toBe('string');

    let polled;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [poll] = await dispatch(
        handler,
        [
          call(
            Constants.CHECK_BACKGROUND_TASK,
            { background_task_id: handle.background_task_id },
            `poll_${attempt}`,
          ),
        ],
        { metadata },
      );
      polled = JSON.parse(String(poll.content));
      if (polled.status === 'completed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(polled).toEqual(
      expect.objectContaining({ status: 'completed', result: 'echo:detached' }),
    );
    expect(ordinaryExecutions).toBe(1);
  });
});

describe('Hindsight read tools in a real SDK event-mode graph', () => {
  async function runScriptedTurn(handler, agent, onRun = () => {}) {
    const run = await Run.create({
      runId: `hindsight-dispatch-${Date.now()}`,
      graphConfig: {
        type: 'standard',
        agents: [
          {
            agentId: AGENT_ID,
            provider: Providers.OPENAI,
            clientOptions: { model: 'gpt-4o-mini', streaming: true, streamUsage: false },
            instructions: 'You are a helpful assistant.',
            maxContextTokens: 8000,
            toolDefinitions: agent.toolDefinitions,
          },
        ],
      },
      returnContent: true,
      customHandlers: { on_tool_execute: handler },
      tokenCounter: (text) => String(text ?? '').length,
      indexTokenCountMap: {},
    });
    run.Graph.overrideModel = new FakeChatModel({
      responses: ['Checking memory.', 'Done.'],
      toolCalls: [
        {
          name: 'hindsight_recall',
          args: { query: 'marker' },
          id: 'tc_hindsight',
          type: 'tool_call',
        },
      ],
    });
    onRun(run);
    await run.processStream(
      { messages: [new HumanMessage('What is the recovery marker?')] },
      {
        runName: 'AgentRun',
        configurable: { thread_id: `hindsight-dispatch-${Date.now()}`, user_id: OWNER },
        streamMode: 'values',
        version: 'v2',
      },
    );
    return (run.getRunMessages() ?? []).find((message) => message.tool_call_id === 'tc_hindsight');
  }

  it('round-trips a model-issued hindsight_recall through the event-mode ToolNode', async () => {
    const { req, agent } = await bindRequest();
    const { handler, loadTools } = hostDispatcher(req);

    const toolMessage = await runScriptedTurn(handler, agent);

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0].slice(0, 2)).toEqual([['hindsight_recall'], AGENT_ID]);
    expect(toolMessage).toBeDefined();
    expect(String(toolMessage.content)).toContain(MARKER);
    expect(toolMessage.status).not.toBe('error');
  });

  it('returns a not-found tool result in the graph for a request without bindings', async () => {
    const { agent } = await bindRequest();
    const { handler } = hostDispatcher(makeRequest());

    const toolMessage = await runScriptedTurn(handler, agent);

    expect(toolMessage).toBeDefined();
    expect(String(toolMessage.content)).toContain('Tool hindsight_recall not found');
    expect(String(toolMessage.content)).not.toContain(MARKER);
  });

  it('fails the whole turn when an upstream executable shares a bound Hindsight name', async () => {
    const { req, agent } = await bindRequest();
    const { handler } = hostDispatcher(req, { loadTools: ordinaryLoader(req, [impostorTool]) });
    requests = [];
    let run;

    await expect(
      runScriptedTurn(handler, agent, (created) => {
        run = created;
      }),
    ).rejects.toThrow('hindsight_tool_name_conflict');

    const messages = run.getRunMessages() ?? [];
    expect(messages.some((message) => message.tool_call_id === 'tc_hindsight')).toBe(false);
    expect(messages.some((message) => String(message.content).includes('Done.'))).toBe(false);
    expect(impostorExecutions).toBe(0);
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });
});

describe('initialize.js composes the public loader before building handlers', () => {
  const PRIMARY_ID = 'agent_primary';
  let ownerId;

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    mockLoadToolsAtHandlerBuild = undefined;
    mockAgentClientArgs = undefined;
    const user = await User.create({
      email: 'hindsight-dispatch@example.com',
      name: 'Hindsight Dispatch',
      username: 'hindsightdispatch',
      role: 'USER',
    });
    ownerId = user._id.toString();
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockInitializeAgent.mockResolvedValue({
      id: PRIMARY_ID,
      endpoint: 'agents',
      edges: [],
      /** Real initializeAgent always returns an array (packages/api/src/agents/initialize.ts). */
      tools: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      resendFiles: true,
      maxContextTokens: 4096,
      codeExecutionContext: {
        baseUrl: 'https://code-default.example.com',
        codeSessionKey: 'execute_code',
        executionProfile: 'default',
        statefulSessions: false,
      },
    });
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [], configurable: {} });
  });

  async function initialize(req, tools = ['hindsight']) {
    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: {
        agent: Promise.resolve({
          id: PRIMARY_ID,
          name: 'Primary',
          provider: 'openai',
          model: 'gpt-4',
          /** The saved agent's Tool Library entry: initialize.js binds it as capable. */
          tools,
        }),
        model_parameters: { model: 'gpt-4' },
        endpoint: 'agents',
      },
    });
    return mockAgentClientArgs.agent;
  }

  function initializeRequest() {
    return {
      user: { id: ownerId, role: 'USER' },
      body: { conversationId: 'conv_hindsight', files: [] },
      resolvedConversation: null,
      config: { endpoints: {}, config: { hindsight: hindsightConfig(ownerId) } },
      _resumableStreamId: null,
    };
  }

  it('serves bound tools through the initialize loadTools callback the handler captured', async () => {
    const req = initializeRequest();
    const runtimeAgent = await initialize(req);
    expect(typeof mockLoadToolsAtHandlerBuild).toBe('function');
    await bindRequest({ req, agent: runtimeAgent, bind: false });

    const result = await mockLoadToolsAtHandlerBuild(['hindsight_recall'], PRIMARY_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ req, toolNames: ['hindsight_recall'] }),
    );
    expect(result.loadedTools.map((loaded) => loaded.name)).toEqual(['hindsight_recall']);
    expect(result.configurable.req).toBe(req);

    const handler = createToolExecuteHandler({ loadTools: mockLoadToolsAtHandlerBuild });
    const [executed] = await dispatch(handler, [call('hindsight_recall', { query: 'marker' })], {
      agentId: PRIMARY_ID,
    });
    expect(executed.status).toBe('success');
    expect(String(executed.content)).toContain(MARKER);
  });

  it('binds only a primary whose server-loaded tools carry the Hindsight entry', async () => {
    const req = initializeRequest();
    const runtimeAgent = await initialize(req, ['web_search']);
    await bindRequest({ req, agent: runtimeAgent, bind: false });

    expect(runtimeAgent.tools).toEqual([]);
    const result = await mockLoadToolsAtHandlerBuild(['hindsight_recall'], PRIMARY_ID);
    expect(result.loadedTools).toEqual([]);
    expect(backendCalls('/memories/recall')).toHaveLength(0);
  });

  it('leaves the callback upstream-only for a resumed request that never bound tools', async () => {
    const original = initializeRequest();
    await bindRequest({ req: original, agent: await initialize(original), bind: false });
    const resumed = initializeRequest();
    await initialize(resumed);

    const result = await mockLoadToolsAtHandlerBuild(['hindsight_recall'], PRIMARY_ID);

    expect(result.loadedTools).toEqual([]);
  });
});
