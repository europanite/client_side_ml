// frontend/app/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');

// >>> add this block <<<
config.server = config.server || {};
const wasmMime = 'application/wasm';
config.server.enhanceMiddleware = (middleware) => (req, res, next) => {
  if (req.url && req.url.endsWith('.wasm')) {
    res.setHeader('Content-Type', wasmMime);
  }
  return middleware(req, res, next);
};

module.exports = config;
