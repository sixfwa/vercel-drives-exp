// Deletes the demo drives so the next `npm run demo:with` starts from an empty cache.
import { APIError, Drive } from '@vercel/sandbox';
import { SIZES, log } from './shared.js';

// `demo-cache` is the name the very first version of this demo used; keep deleting it too.
const names = [...Object.keys(SIZES).map((size) => `demo-cache-${size}`), 'demo-cache'];
for (const name of names) {
  try {
    const drive = await Drive.get({ name });
    log(`deleting drive "${drive.name}" (${drive.driveId})`);
    await drive.delete();
    log(`drive "${name}" deleted`);
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) {
      log(`drive "${name}" does not exist, nothing to delete`);
    } else {
      throw error;
    }
  }
}
