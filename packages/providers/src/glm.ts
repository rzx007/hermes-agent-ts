import type { HermesConfig } from '@hermes/core';
import type { Provider } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createGLMProvider(config: HermesConfig): Provider {
  return new OpenAICompatibleProvider({
    name: 'glm', apiKey: config.apiKey, baseURL: config.baseUrl,
  });
}

export function createProvider(config: HermesConfig): Provider {
  switch (config.provider) {
    case 'glm':
      return createGLMProvider(config);
    default:
      throw new Error(`未知的 provider: ${config.provider}（阶段1仅支持 glm）`);
  }
}
