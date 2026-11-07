const express = require('express');
const { consentHandlers } = require('@vectorize-io/hindsight-librechat');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const hindsightMemory = require('~/server/services/HindsightMemory');

const router = express.Router();
const handlers = consentHandlers(hindsightMemory);

router.use(requireJwtAuth, configMiddleware);
router.get('/availability', (req, res) => handlers.availability(req, res));
router.get('/consent/:conversationId', (req, res) => handlers.read(req, res));
router.put('/consent/:conversationId', (req, res) => handlers.update(req, res));

module.exports = router;
