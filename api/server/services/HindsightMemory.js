const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { GenerationJobManager, registerShutdownTask } = require('@librechat/api');
const { LibreChatMemory } = require('@vectorize-io/hindsight-librechat');
const db = require('~/models');

const hindsightMemory = new LibreChatMemory(
  (name) => process.env[name],
  (event) => logger.warn('[hindsight-memory]', event),
  {
    database: () => mongoose.connection.db,
    conversations: { get: (user, conversationId) => db.getConvo(user, conversationId) },
    generations: GenerationJobManager,
  },
);

registerShutdownTask('Hindsight memory', () => hindsightMemory.close());

module.exports = hindsightMemory;
