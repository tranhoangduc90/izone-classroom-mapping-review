import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function createSpeakingCloudPolicy({ env, allowedOrigins,
  load = () => import('./exam-journal-runtime/adapters/speaking-homework.mjs'),
  onFailure = () => {}, clock = Date.now }) {
  const modeFile = env.SPEAKING_JOURNAL_CLOUD_BROWSER_MODE_FILE;
  const keyFile = env.SPEAKING_JOURNAL_CLOUD_APPEND_KEY_FILE;
  if (!modeFile && !keyFile) return null;
  let cloud;
  try {
    if (!modeFile || !keyFile || !isAbsolute(modeFile) || !isAbsolute(keyFile)) throw Error('invalid path');
    const value = (await readFile(keyFile, 'utf8')).trim();
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) throw Error('invalid key');
    const { createSpeakingHomeworkIntake } = await load();
    cloud = createSpeakingHomeworkIntake({ journal:{}, keys:{ 'spk-cloud-v1':key },
      currentKeyId:'spk-cloud-v1', allowedOrigins });
  } catch {
    onFailure('SPEAKING_CLOUD_POLICY_CONFIG_INVALID');
    return null;
  }
  let until = 0;
  let lane = 'collector';
  let reading;
  async function readLane() {
    if (clock() < until) return lane;
    reading ??= (async () => {
      try {
        const state = (await readFile(modeFile, 'utf8')).trim();
        if (state !== 'collector' && state !== 'cloud') throw Error('invalid mode');
        lane = state;
      } catch {
        lane = 'collector';
        onFailure('SPEAKING_CLOUD_BROWSER_MODE_UNAVAILABLE');
      } finally {
        until = clock() + 5000;
        reading = null;
      }
      return lane;
    })();
    return reading;
  }
  return async (owner, collectorGrant) => {
    if (await readLane() !== 'cloud') return { ...collectorGrant, archiveLane:'collector' };
    try {
      const grant = cloud.context(owner);
      if (grant.bindingId !== collectorGrant.bindingId) throw Error('scope mismatch');
      return { ...collectorGrant, archiveLane:'cloud', cloud:grant };
    } catch {
      onFailure('SPEAKING_CLOUD_GRANT_FAILED');
      return { ...collectorGrant, archiveLane:'collector' };
    }
  };
}
