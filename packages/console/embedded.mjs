// In-process bridge: delegates requests to the ORIGINAL upstream proxy-lib.
// A distinct createApp() instance (and therefore a distinct SessionPool) is
// allocated per authorized API key, to avoid cross-key conversation collision.
// No Microsoft credentials are handled by this module.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountRequest } from './account-manager.mjs';

const LOCAL = 'embedded://default';
let accountDataRoot=null,accountStore=null;
export function configureAccounts(root,store){ accountDataRoot=root; accountStore=store; }
const MAX_APPS = 256;
const IDLE_MS = 30 * 60 * 1000;
const instances = new Map();
let adapterPromise;

async function loadAdapter() {
  if (!adapterPromise) {
    adapterPromise = process.env.M365_CONSOLE_TEST_PROVIDER
      ? import(pathToFileURL(path.resolve(process.env.M365_CONSOLE_TEST_PROVIDER)).href)
      : import('@m365-copilot/proxy-lib');
  }
  return adapterPromise;
}

export function isEmbedded(upstream) { return upstream === LOCAL; }

async function getApp(keyId) {
  if (!keyId || typeof keyId !== 'string') throw new Error('An API key identity is required for embedded calls');
  const now = Date.now();
  for (const [id, state] of instances) if (state.lastUsed < now - IDLE_MS) instances.delete(id);
  if (instances.has(keyId)) {
    const v = instances.get(keyId); v.lastUsed = now; return v.app;
  }
  const { createApp } = await loadAdapter();
  const app = createApp();
  if (!app || typeof app.fetch !== 'function') throw new Error('Unexpected @m365-copilot/proxy-lib API: missing createApp().fetch');
  if (instances.size >= MAX_APPS) {
    const leastRecentlyUsed = [...instances.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0]?.[0];
    if (leastRecentlyUsed) instances.delete(leastRecentlyUsed);
  }
  instances.set(keyId,{app,lastUsed:now});
  return app;
}

export async function requestUpstream(channel, endpoint, options={}, keyId='internal-probe') {
  const method = options.method || 'GET';
  if (isEmbedded(channel.upstream)) {
    const app = await getApp(keyId);
    const req = new Request('http://m365-embedded.internal'+endpoint, {
      method,
      headers:{'Content-Type':'application/json', ...(options.headers||{})},
      body: options.body,
      signal: options.signal,
    });
    return app.fetch(req);
  }
  if (channel.upstream.startsWith('account://')) {
    const id=channel.upstream.slice('account://'.length);
    const account=accountStore?.one('SELECT * FROM accounts WHERE id=?',id);
    if(!account || channel.account_id!==id || !accountDataRoot) throw new Error('Account worker unavailable or channel binding mismatch');
    return accountRequest(accountDataRoot,account,endpoint,options,keyId);
  }
  return fetch(channel.upstream+endpoint, {
    ...options,
    method,
    headers: {'Content-Type':'application/json', ...(options.headers||{})},
    redirect:'manual',
  });
}

export function embeddedState() { return {activeKeyPools:instances.size,mode:'in-process proxy-lib'}; }
