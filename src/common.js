import { normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { argv0 } from 'node:process';
import c from 'chalk-template';
import { platform } from 'node:process';

export const isWindows = platform === 'win32';

let _showSpinner = false;
export function setShowSpinner (val) {
  _showSpinner = val;
}
export function getShowSpinner () {
  const showSpinner = _showSpinner;
  _showSpinner = false;
  return showSpinner;
}

export function sizeStr (num) {
  num /= 1024;
  if (num < 1000)
    return `${fixedDigitDisplay(num, 4)} KiB`;
  num /= 1024;
  if (num < 1000)
    return `${fixedDigitDisplay(num, 4)} MiB`;
}

export function fixedDigitDisplay (num, maxChars) {
  const significantDigits = String(num).split('.')[0].length;
  let str;
  if (significantDigits >= maxChars - 1) {
    str = String(Math.round(num));
  } else {
    const decimalPlaces = maxChars - significantDigits - 1;
    const rounding = 10 ** decimalPlaces;
    str = String(Math.round(num * rounding) / rounding);
  }
  if (maxChars - str.length < 0)
    return str;
  return ' '.repeat(maxChars - str.length) + str;
}

export function table (data, align = []) {
  if (data.length === 0) return '';
  const colLens = data.reduce((maxLens, cur) => maxLens.map((len, i) => Math.max(len, cur[i].length)), data[0].map(cell => cell.length));
  let outTable = '';
  for (const row of data) {
    for (const [i, cell] of row.entries()) {
      if (align[i] === 'right')
        outTable += ' '.repeat(colLens[i] - cell.length) + cell;
      else
        outTable += cell + ' '.repeat(colLens[i] - cell.length);
    }
    outTable += '\n';
  }
  return outTable;
}

/**
 * Securely creates a temporary directory and returns its path.
 *
 * The new directory is created using `fsPromises.mkdtemp()`.
 */
export async function getTmpDir () {
  return await mkdtemp(normalize(tmpdir() + sep));
}

async function readFileCli (file, encoding) {
  try {
    return await readFile(file, encoding)
  }
  catch (e) {
    throw c`Unable to read file {bold ${file}}`;
  }
}
export { readFileCli as readFile }

/**
 * Spawn a command that performs executes a given binary with
 * binary output that is persisted to temporary disk
 *
 * Commands used with this command must take the form:
 * ```
 * cmd <input file> [OPTIONS] <outputFile>
 * ```
 *
 * This may mean that `opts` should be an array that ends with a switch like
 * "--output" or "-o".
 *
 * @param {string} cmd - Binary to execute
 * @param {Uint8Array} input - Binary input to temporarily persist to disk
 * @param {string[]} opts - Arguments that will be prepended between the input file and output file arguments
 */
export async function spawnIOTmp (cmd, input, opts) {
  let tmpDir, inFile, outFile;
  try {
    tmpDir = await getTmpDir();
    inFile = resolve(tmpDir, 'in.wasm');
    outFile = resolve(tmpDir, 'out.wasm');

    await writeFile(inFile, input);

    const cp = spawn(argv0, [cmd, inFile, ...opts, outFile], { stdio: 'pipe' });

    let stderr = '';
    const p = new Promise((resolve, reject) => {
      cp.stderr.on('data', data => stderr += data.toString());
      cp.on('error', e => {
        reject(e);
      });
      cp.on('exit', code => {
        if (code === 0)
          resolve();
        else
          reject(stderr);
      });
    });

    await p;
    var output = await readFile(outFile);
    return output;
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true });
    }
  }
}
