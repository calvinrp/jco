import { join, resolve } from "node:path";
import { execArgv } from "node:process";
import { deepStrictEqual, ok, strictEqual, fail } from "node:assert";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { fileURLToPath, pathToFileURL } from "url";

import { componentize } from "../src/api.js";

import { exec, jcoPath, getTmpDir, setupAsyncTest } from "./helpers.js";

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

    test("Transpile async (JSPI)", async () => {
      const { instance, cleanup } = await setupAsyncTest({
        component: {
          asyncMode: "jspi",
          name: "async_call",
          path: resolve("test/fixtures/components/async_call.component.wasm"),
          imports: {
            'something:test/test-interface': {
              callAsync: async () => "called async",
              callSync: () => "called sync",
            },
          },
        },
        jco: {
          transpile: {
            extraArgs: [
              "--async-imports=something:test/test-interface#call-async",
              "--async-exports=run-async",
            ],
          },
        },
      });

      strictEqual(instance.runSync instanceof AsyncFunction, false, "runSync() should be a sync function");
      strictEqual(instance.runAsync instanceof AsyncFunction, true, "runAsync() should be an async function");

      strictEqual(instance.runSync(), "called sync");
      strictEqual(await instance.runAsync(), "called async");

      await cleanup();
    });

    test("Transpile async (asyncify)", async () => {
      const { instance, cleanup } = await setupAsyncTest({
        component: {
          name: "async_call",
          path: resolve("test/fixtures/components/async_call.component.wasm"),
          imports: {
            'something:test/test-interface': {
              callAsync: async () => "called async",
              callSync: () => "called sync",
            },
          },
        },
        jco: {
          transpile: {
            extraArgs: [
              "--async-imports=something:test/test-interface#call-async",
              "--async-exports=run-async",
            ],
          }
        },
      });

      strictEqual(instance.runSync instanceof AsyncFunction, false, "runSync() should be a sync function");
      strictEqual(instance.runAsync instanceof AsyncFunction, true, "runAsync() should be an async function");

      strictEqual(instance.runSync(), "called sync");
      strictEqual(await instance.runAsync(), "called async");

      await cleanup();
    });

    // TODO: fill out `RequestOption` impl (browser-async/http/types)
    // TODO: allow `Pollable` to be re-used (when poll is called again?? how is this triggered?)
    // TODO: fill out browser-async sockets with "not implemented" errors (we don't have much choice but to trap here)

    test("Transpile async (asyncify)", async () => {
      const { instance, cleanup } = await setupAsyncTest({
        component: {
          name: "async_call",
          path: resolve("test/fixtures/components/async_call.component.wasm"),
          imports: {
            'something:test/test-interface': {
              callAsync: async () => "called async",
              callSync: () => "called sync",
            },
          },
        },
        jco: {
          transpile: {
            extraArgs: [
              "--async-imports=something:test/test-interface#call-async",
              "--async-exports=run-async",
            ],
          }
        },
      });

      strictEqual(instance.runSync instanceof AsyncFunction, false, "runSync() should be a sync function");
      strictEqual(instance.runAsync instanceof AsyncFunction, true, "runAsync() should be an async function");

      strictEqual(instance.runSync(), "called sync");
      strictEqual(await instance.runAsync(), "called async");

      await cleanup();
    });

  });
}

