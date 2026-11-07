/**
 * Hindsight consent routes through the REAL router, the REAL Hindsight adapter
 * singleton and its consent store on mongodb-memory-server, and the REAL
 * owner-scoped conversation lookup. Stubbed: JWT auth (a header picks the
 * user), app config (the Hindsight section), and generation job state.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockOwner = new mongoose.Types.ObjectId().toString();
const mockOther = new mongoose.Types.ObjectId().toString();
const mockJobs = new Map();
const mockBlocking = { ids: [] };

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    getJob: jest.fn(async (id) => mockJobs.get(id) ?? null),
    getCleanupBlockingJobIdsForConversations: jest.fn(async () => mockBlocking.ids),
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    const user = req.get('x-test-user');
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.user = { id: user };
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = {
      config: {
        hindsight: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:9',
          bankId: 'private',
          ownerUserId: mockOwner,
          outboxDir: '/unused-route-fixture',
        },
      },
    };
    next();
  },
}));

const { Conversation } = require('~/db/models');
const hindsightMemory = require('~/server/services/HindsightMemory');

describe('Hindsight consent routes', () => {
  let mongoServer;
  let app;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    app = express();
    app.use(express.json());
    app.use('/api/hindsight', require('../hindsight'));
  }, 60000);

  afterAll(async () => {
    await hindsightMemory.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await hindsightMemory.close();
    await mongoose.connection.dropDatabase();
    mockJobs.clear();
    mockBlocking.ids = [];
    await Conversation.create([
      { conversationId: 'owned', user: mockOwner, endpoint: 'agents', title: 'Owned' },
      { conversationId: 'temporary', user: mockOwner, endpoint: 'agents', isTemporary: true },
      { conversationId: 'not-mine', user: mockOther, endpoint: 'agents', title: 'Other' },
    ]);
  });

  const as = (user) => ({
    get: (path) => request(app).get(path).set('x-test-user', user),
    put: (path, body) => request(app).put(path).set('x-test-user', user).send(body),
  });
  const consents = () => mongoose.connection.db.collection('hindsightconsents');

  it('requires authentication on every route', async () => {
    for (const response of await Promise.all([
      request(app).get('/api/hindsight/availability'),
      request(app).get('/api/hindsight/consent/owned'),
      request(app).put('/api/hindsight/consent/owned').send({ enabled: true }),
    ])) {
      expect(response.status).toBe(401);
    }
  });

  it('reports availability only to the owner', async () => {
    expect((await as(mockOwner).get('/api/hindsight/availability')).body).toEqual({
      available: true,
    });
    expect((await as(mockOther).get('/api/hindsight/availability')).body).toEqual({
      available: false,
    });
  });

  it("switches the owner's conversation On and Off and reads it back", async () => {
    expect((await as(mockOwner).get('/api/hindsight/consent/owned')).body).toEqual({
      available: true,
      enabled: false,
    });
    const on = await as(mockOwner).put('/api/hindsight/consent/owned', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true });
    expect((await as(mockOwner).get('/api/hindsight/consent/owned')).body).toEqual({
      available: true,
      enabled: true,
    });
    expect(
      (await as(mockOwner).put('/api/hindsight/consent/owned', { enabled: false })).body,
    ).toEqual({
      enabled: false,
    });
    expect(await consents().findOne({ conversationId: 'owned' })).toMatchObject({
      user: mockOwner,
      enabled: false,
      version: 2,
    });
  });

  it.each([
    ['another user', mockOther, 'owned', { enabled: true }, 403, 'hindsight_unavailable'],
    [
      'a conversation owned by someone else',
      mockOwner,
      'not-mine',
      { enabled: true },
      404,
      'conversation_not_found',
    ],
    [
      'a missing conversation',
      mockOwner,
      'missing',
      { enabled: true },
      404,
      'conversation_not_found',
    ],
    [
      'a temporary chat',
      mockOwner,
      'temporary',
      { enabled: true },
      409,
      'conversation_unsupported',
    ],
    [
      'a non-boolean value',
      mockOwner,
      'owned',
      { enabled: 'true' },
      400,
      'invalid_consent_request',
    ],
    [
      'an unexpected field',
      mockOwner,
      'owned',
      { enabled: true, user: mockOther },
      400,
      'invalid_consent_request',
    ],
  ])('refuses %s', async (_label, user, conversationId, body, status, code) => {
    const response = await as(user).put(`/api/hindsight/consent/${conversationId}`, body);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code });
    expect(await consents().countDocuments({ enabled: true })).toBe(0);
  });

  it.each([
    ['running', () => mockJobs.set('owned', { status: 'running' })],
    ['paused for approval', () => mockJobs.set('owned', { status: 'requires_action' })],
    [
      'still persisting',
      () =>
        mockJobs.set('owned', {
          status: 'complete',
          metadata: { terminalPersistencePending: true },
        }),
    ],
    ['blocked by cleanup', () => (mockBlocking.ids = ['job-1'])],
  ])('refuses a change while a generation is %s', async (_label, arrange) => {
    arrange();
    const response = await as(mockOwner).put('/api/hindsight/consent/owned', { enabled: true });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'generation_active' });
    expect(await consents().countDocuments()).toBe(0);
  });

  it("does not reveal another user's conversation state", async () => {
    expect((await as(mockOwner).get('/api/hindsight/consent/not-mine')).body).toEqual({
      available: false,
      enabled: false,
    });
    expect((await as(mockOther).get('/api/hindsight/consent/owned')).body).toEqual({
      available: false,
      enabled: false,
    });
  });
});
