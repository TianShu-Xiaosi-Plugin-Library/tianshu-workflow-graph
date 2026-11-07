const sdk = globalThis.__tianshuTPI;
if (!sdk || typeof sdk.defineTianshuPlugin !== 'function') {
  throw new Error('TPI host SDK is unavailable. Load this plugin from Tianshu or the local test host.');
}
export const { defineTianshuPlugin } = sdk;
