const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');
const { createHindsightConfigLoader } = require('@vectorize-io/hindsight-librechat/loader');
const { loadYaml, redactConfigSecretMaps, createCustomConfigLoader } = require('@librechat/api');

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'librechat.yaml');

module.exports = createHindsightConfigLoader(
  createCustomConfigLoader,
  {
    loadLocal: loadYaml,
    defaultConfigPath,
    redactConfig: redactConfigSecretMaps,
  },
  { remote: axios, parseYaml: yaml.load },
);
