import { resolve } from "node:path";
import { execArgv } from "node:process";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { fileURLToPath, pathToFileURL } from "url";
import { exec, jcoPath, getTmpDir } from "./helpers.js";

const multiMemory = execArgv.includes("--experimental-wasm-multi-memory")
  ? ["--multi-memory"]
  : [];

const AsyncFunction = (async () => {}).constructor;

export async function asyncTest(_fixtures) {
  suite("Async", () => {
    var tmpDir;
    var outDir;
    var outFile;
    suiteSetup(async function () {
      tmpDir = await getTmpDir();
      outDir = resolve(tmpDir, "out-component-dir");
      outFile = resolve(tmpDir, "out-component-file");

      const modulesDir = resolve(tmpDir, "node_modules", "@bytecodealliance");
      await mkdir(modulesDir, { recursive: true });
      await symlink(
        fileURLToPath(new URL("../packages/preview2-shim", import.meta.url)),
        resolve(modulesDir, "preview2-shim"),
        "dir"
      );
    });
    suiteTeardown(async function () {
      try {
        await rm(tmpDir, { recursive: true });
      } catch {}
    });

    teardown(async function () {
      try {
        await rm(outDir, { recursive: true });
        await rm(outFile);
      } catch {}
    });

    test("Transpile async", async () => {
      const name = "flavorful";
      const { stderr } = await exec(
        jcoPath,
        "transpile",
        `test/fixtures/components/${name}.component.wasm`,
        "--no-wasi-shim",
        "--name",
        name,
        "-o",
        outDir
      );
      strictEqual(stderr, "");
      const source = await readFile(`${outDir}/${name}.js`);
      ok(source.toString().includes("export { test"));
    });

    if (typeof WebAssembly.Suspending === 'function') {
      test("Transpile with Async Mode for JSPI", async () => {
        const name = "async_call";
        const { stderr } = await exec(
          jcoPath,
          "transpile",
          `test/fixtures/components/${name}.component.wasm`,
          `--name=${name}`,
          "--valid-lifting-optimization",
          "--tla-compat",
          "--instantiation=async",
          "--base64-cutoff=0",
          "--async-mode=jspi",
          "--async-imports=something:test/test-interface#call-async",
          "--async-exports=run-async",
          "-o",
          outDir
        );
        strictEqual(stderr, "");
        await writeFile(
          `${outDir}/package.json`,
          JSON.stringify({ type: "module" })
        );
        const m = await import(`${pathToFileURL(outDir)}/${name}.js`);
        const inst = await m.instantiate(
          undefined,
          {
            'something:test/test-interface': {
              callAsync: async () => "called async",
              callSync: () => "called sync",
            },
          },
        );
        strictEqual(inst.runSync instanceof AsyncFunction, false);
        strictEqual(inst.runAsync instanceof AsyncFunction, true);

        strictEqual(inst.runSync(), "called sync");
        strictEqual(await inst.runAsync(), "called async");
      });
    }

    test("Transpile async (asyncify)", async () => {
      const name = "async_call";
      const { stderr } = await exec(
        jcoPath,
        "transpile",
        `test/fixtures/components/${name}.component.wasm`,
        `--name=${name}`,
        "--valid-lifting-optimization",
        "--tla-compat",
        "--instantiation=async",
        "--base64-cutoff=0",
        "--async-mode=asyncify",
        "--async-imports=something:test/test-interface#call-async",
        "--async-exports=run-async",
        "-o",
        outDir
      );
      strictEqual(stderr, "");
      await writeFile(
        `${outDir}/package.json`,
        JSON.stringify({ type: "module" })
      );
      const m = await import(`${pathToFileURL(outDir)}/${name}.js`);
      const inst = await m.instantiate(
        undefined,
        {
          'something:test/test-interface': {
            callAsync: async () => "called async",
            callSync: () => "called sync",
          },
        },
      );
      strictEqual(inst.runSync instanceof AsyncFunction, false);
      strictEqual(inst.runAsync instanceof AsyncFunction, true);

      strictEqual(inst.runSync(), "called sync");
      strictEqual(await inst.runAsync(), "called async");
    });
  });
}
