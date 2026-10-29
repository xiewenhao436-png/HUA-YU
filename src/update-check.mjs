import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRegistryPath } from './paths.mjs';
import { appUpdateStatus } from './updater.mjs';
const pending = new Map();
export async function dailyAppUpdateStatus({ force = false, statePath = path.join(path.dirname(projectRegistryPath()), 'update-check.json'), now = new Date(), status = appUpdateStatus } = {}) {
  if (pending.has(statePath)) return pending.get(statePath);
  const task = (async () => {
    const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
    let saved;
    try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
    if (!force && saved?.day === day && saved?.result) {
      const current = await status({ checkRemote: false, releaseProvider: async () => saved.result.publishedRelease || null });
      return { ...current, dailyCheck: { checkedAt: saved.checkedAt, cached: true, error: current.releaseError || null } };
    }
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const lockPath = `${statePath}.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await fs.stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 120000) {
        await fs.unlink(lockPath).catch(() => {});
        lock = await fs.open(lockPath, 'wx');
      } else {
        return { ...(saved?.result || {}), canUpdate: false, blockedReason: 'check-in-progress', blockedMessage: '正在检查更新，请稍后重试。', dailyCheck: { cached: false, error: 'check-in-progress' } };
      }
    }
    try {
    let result;
    try { result = await status({ checkRemote: true, forceRemote: force }); }
    catch (error) { return { installedVersion: null, canUpdate: false, updateAvailable: false, blockedReason: 'release-check-failed', blockedMessage: error.message, dailyCheck: { cached: false, error: error.message } }; }
    const error = result.releaseError || result.git?.fetchError || null;
    const checkedAt = now.toISOString();
    if (!error) {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ day, checkedAt, result }));
      await fs.rename(temporary, statePath);
    }
    return { ...result, dailyCheck: { checkedAt, cached: false, error } };
    } finally { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
  })();
  pending.set(statePath, task);
  try { return await task; } finally { pending.delete(statePath); }
}
