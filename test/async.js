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
        }
      });

      strictEqual(instance.runSync instanceof AsyncFunction, false);
      strictEqual(instance.runAsync instanceof AsyncFunction, true);

      strictEqual(instance.runSync(), "called sync");
      strictEqual(await instance.runAsync(), "called async");

      await cleanup();
    });
  });
}

/**
 * Set up an async test to be run
 *
 * @param {object} args - Arguments for running the async test
 * @param {function} args.testFn - Arguments for running the async test
 * @param {object} args.jco - JCO-related confguration for running the async test
 * @param {object} [args.jcoBinPath] - path to the jco binary
 * @param {object} args.component - configuration for an existing component that should be transpiled
 * @param {object} args.component.name - JCO-related confguration for running the async test
 * @param {object} args.component.path - JCO-related confguration for running the async test
 * @param {object} args.component.import - JCO-related confguration for running the async test
 */
async function setupAsyncTest(args) {
const {
  asyncMethod: _asyncMethod,
  testFn,
  jco,
  component,
} = args;
  const asyncMethod = _asyncMethod || "asyncify";
  const jcoBinPath = jco?.binPath || jcoPath;

  let componentName = component.name;
  let componentPath = component.path;
  let componentImports = component.imports;

  if (component.path && component.build) {
    throw new Error("Both component.path and component.build should not be specified at the same time");
  }

  // If this component should be built "just in time" -- i.e. created when this test is run
  let componentBuildCleanup;
  if (component.build) {
    const { name, path, cleanup } = await componentBuildComponent(component.build);
    componentBuildCleanup = cleanup;
    componentName = name;
    componentPath = path;
  }

  if (!componentName) { throw new Error("invalid/missing component name"); }
  if (!componentPath) { throw new Error("invalid/missing component path"); }

  // Create temporary output directory
  const outputDir = await getTmpDir();

  // Build out the whole-test cleanup function
  let cleanup = async () => {
    if (componentBuildCleanup) {
      try {
      await componentBuildCleanup();
      } catch {}
    }
      try {
        await rm(outputDir, { recursive: true });
      } catch {}
  };

  // Return early if the test was intended to run on JSPI but JSPI is not enabled
  if (asyncMethod == "jspi" && typeof WebAssembly?.Suspending !== 'function') {
    await cleanup();
    throw new Error("JSPI async type skipped, but JSPI was not enabled -- please ensure test is run from an environment with JSPI integration (ex. node with the --experimental-wasm-jspi flag)");
  }

  // Perform transpilation
      const { stderr } = await exec(
        jcoBinPath,
        "transpile",
        componentPath,
        `--name=${componentName}`,
        "--valid-lifting-optimization",
        "--tla-compat",
        "--instantiation=async",
        "--base64-cutoff=0",
        "--async-mode=asyncify",
        "--async-imports=something:test/test-interface#call-async",
        "--async-exports=run-async",
        ...(jco?.extraArgs || []),
        "-o",
        outputDir
      );
      strictEqual(stderr, "", `failed to run jco transpile, STDERR:\n${stderr}`);

      // Write a minimal package.json
      await writeFile(
        `${outputDir}/package.json`,
        JSON.stringify({ type: "module" })
      );

      // Import the transpiled JS
      const module = await import(`${pathToFileURL(outputDir)}/${componentName}.js`);

      // Instantiate the module
      const instance = await module.instantiate(
        undefined,
        componentImports || {},
      );

  return {
    module,
    instance,
    cleanup,
  };
}

/**
 * Helper method for building a component just in time (e.g. to use in a test)
   *
   */
async function buildComponent(args) {
  const name = args?.name;
  const jsSource = args?.js?.source;
  const witSource = args?.wit?.source;
  const witWorld = args?.wit?.world;
  if (!name) { throw new Error("invalid/missing component name for in-test component build"); }
  if (!jsSource) { throw new Error("invalid/missing source for in-test component build"); }
  if (!witSource) { throw new Error("invalid/missing WIT for in-test component build"); }
  if (!witWorld) { throw new Error("invalid/missing WIT world for in-test component build"); }

  // Create temporary output directory
  const outputDir = await getTmpDir();

  // Write the component's JS and WIT
  const jsSourcePath = resolve(`${outputDir}/component.js`);
  const witSourcePath = resolve(`${outputDir}/component.wit`);
  await Promise.all([
    await writeFile(jsSourcePath, jsSource),
    await writeFile(witSourcePath, witSource),
  ]);

  // Build the output path to which we should write
  const outputWasmPath = join(outputDir, "component.wasm");

  // Componentize the given component
  await componentize(jsSourcePath, args.opts || {
    sourceName: "component",
    witPath: witSourcePath,
    worldName: witWorld,
    out: outputWasmPath,
  });

  return {
    name,
    path: outputWasmPath,
    cleanup: async () => {
      try {
        await rm(outputDir);
      } catch {}
    }
  };
}
