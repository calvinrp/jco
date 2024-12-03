import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import c from 'chalk-template';

/**
 * `jco componentize` CLI command implementation
 *
 * @param {string} sourcePath - Path to JS source code
 * @param {object} opts - ComponentizeJS options
 * @param {string} opts.wit - Path to a WIT file or directory to use
 * @param {string} [opts.worldName] - Name of the WIT world to target
 * @param {string} [opts.aot] - Whether to use AoT (via Weval)
 * @param {string} [opts.engine] - Use a custom engine build (SpiderMonkey/StarlingMonkey) when componentizing
 * @param {string[]} [opts.disable] - A list of features (i.e. WASI) to disable when building
 * @param {string} [opts.preview2Adapter] - Path to a custom preview2 adapter
 * @param {string} opts.out - Path to which to write the WebAssembly component output
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
    engine: opts.engine,
  });
  await writeFile(opts.out, component);
  if (!opts.quiet) {
    console.log(c`{green OK} Successfully written {bold ${opts.out}}.`);
  }
}
