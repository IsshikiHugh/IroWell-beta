// Optional engine: a machine using only Codex can start the daemon without this SDK.
let sdk, unavailable = '';
try { sdk = await import('@anthropic-ai/claude-agent-sdk'); } catch (e) {
  unavailable = e.message;
}
const requireSdk = () => {
  if (!sdk) throw new Error(`Claude SDK is unavailable on this host: ${unavailable}`);
  return sdk;
};
export const query = (...args) => requireSdk().query(...args);
export const listSessions = (...args) => sdk ? sdk.listSessions(...args) : Promise.resolve([]);
export const getSessionMessages = (...args) => requireSdk().getSessionMessages(...args);
export const getSessionInfo = (...args) => requireSdk().getSessionInfo(...args);
export const renameSession = (...args) => requireSdk().renameSession(...args);
