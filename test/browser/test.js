import { platform } from 'node:process';

// import { browserWebIdlTest } from './webidl.js';
import { browserPreview2Test } from './preview2.js';

export async function browserTest() {
  if (platform !== 'win32') {
    // await browserWebIdlTest();
    await browserPreview2Test();
  }
}
