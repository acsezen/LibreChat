const mongoose = require('mongoose');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { GenerationJobManager, registerShutdownTask } = require('@librechat/api');
const { LibreChatMemory, memoryLogEntry } = require('@vectorize-io/hindsight-librechat');
const db = require('~/models');

/**
 * One line per event: the console format drops log metadata. Delivery events come from
 * the owner's background worker, so they keep the tenant and user but not the request
 * that happened to wake the worker.
 */
function logHindsightEvent(event) {
  const { level, message, delivery } = memoryLogEntry(event);
  if (!delivery) {
    logger[level](message);
    return;
  }
  const { tenantId, userId } = tenantStorage.getStore() ?? {};
  tenantStorage.run({ tenantId, userId }, () => logger[level](message));
}

const hindsightMemory = new LibreChatMemory((name) => process.env[name], logHindsightEvent, {
  database: () => mongoose.connection.db,
  conversations: { get: (user, conversationId) => db.getConvo(user, conversationId) },
  generations: GenerationJobManager,
});

registerShutdownTask('Hindsight memory', () => hindsightMemory.close());

module.exports = hindsightMemory;
