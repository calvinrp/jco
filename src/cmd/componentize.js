import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import c from 'chalk-template';

/**
 * `jco componentize` CLI command implementation
 *
 * @param {string} sourcePath - Path to JS source code
 * @param {object} opts - ComponentizeJS options
 */
export async function componentize(sourcePath, opts) {
  const { componentize: componentizeFn } = await eval('import("@bytecodealliance/componentize-js")');
  if (opts.disable?.includes('all')) {
    opts.disable = ['stdio', 'random', 'clocks', 'http'];
  }
  const source = await readFile(sourcePath, 'utf8');
  const { component } = await componentizeFn(source, {
    enableAot: opts.aot,
    sourceName: basename(sourcePath),
    witPath: resolve(opts.wit),
    worldName: opts.worldName,
    disableFeatures: opts.disable,
    enableFeatures: opts.enable,
    preview2Adapter: opts.preview2Adapter,
  });
  await writeFile(opts.out, component);
  if (!opts.quiet) {
    console.log(c`{green OK} Successfully written {bold ${opts.out}}.`);
  }
}
