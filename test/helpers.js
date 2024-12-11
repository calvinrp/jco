import { argv, execArgv } from "node:process";
import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { normalize, sep } from "node:path";
import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { pathToFileURL } from "url";

export const jcoPath = "src/jco.js";

export async function exec(cmd, ...args) {
  let stdout = "",
    stderr = "";
  await new Promise((resolve, reject) => {
    const cp = spawn(argv[0], ["--no-warnings", ...execArgv, cmd, ...args], {
      stdio: "pipe",
    });
    cp.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    cp.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    cp.on("error", reject);
    cp.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error((stderr || stdout).toString()))
    );
  });
  return { stdout, stderr };
}

/**
 * Securely creates a temporary directory and returns its path.
 *
 * The new directory is created using `fsPromises.mkdtemp()`.
 */
export async function getTmpDir() {
  return await mkdtemp(normalize(tmpdir() + sep));
}

/**
 * Set up an async test to be run
 *
 * @param {object} args - Arguments for running the async test
 * @param {function} args.testFn - Arguments for running the async test
 * @param {object} args.jco - JCO-related confguration for running the async test
 * @param {object} [args.jcoBinPath] - path to the jco binary
 * @param {object} [args.transpile] - configuration related to transpilation
 * @param {object} [args.transpile.extraArgs] - arguments to pass along to jco transpilation
 * @param {object} args.component - configuration for an existing component that should be transpiled
 * @param {object} args.component.name - name of the component
 * @param {object} args.component.path - path to the WebAssembly binary for the existing component
 * @param {object} args.component.import - imports that should be provided to the module at instantiation time
 */
export async function setupAsyncTest(args) {
  const {
    asyncMode: _asyncMode,
    testFn,
    jco,
    component,
  } = args;
  const asyncMode = _asyncMode || "asyncify";
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
  if (asyncMode == "jspi" && typeof WebAssembly?.Suspending !== 'function') {
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
    `--async-mode=${asyncMode}`,
    ...(jco?.transpile?.extraArgs || []),
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
  const moduleSourcePath = `${pathToFileURL(outputDir)}/${componentName}.js`;
  const module = await import(moduleSourcePath);

  // Instantiate the module
  const instance = await module.instantiate(
    undefined,
    componentImports || {},
  );

  return {
    module,
    moduleSourcePath,
    instance,
    cleanup,
    component: {
      name: componentName,
      path: componentPath,
    }
  };
}

/**
 * Helper method for building a component just in time (e.g. to use in a test)
 *
 */
export async function buildComponent(args) {
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

/**
 * Test a browser page, at a given hash
 *
 * @param {object} args
 * @param {string} args.hash - Hash at which to perform tests
 * @param {object} args.browser - Puppeteer browser instance
 * @param {object} [args.path] - Path to the HTML file to use (ex. `test/browser.html`)
*/
export async function testBrowserPage(args) {
  const { browser, hash } = args;
  if (!browser) { throw new Error("missing puppeteer instance browser object"); }
  if (!hash) { throw new Error("missing hash for browser page"); }

  const page = await browser.newPage();
  const path = args.path ? args.path : 'test/browser.html';
  const serverPort = args.serverPort ? args.serverPort : 8080;

  ok((await page.goto(`http://localhost:${serverPort}/${path}#${hash}`)).ok());

  const body = await page.locator('body').waitHandle();

  let bodyHtml = await body.evaluate(el => el.innerHTML);
  while (bodyHtml === '<h1>Running</h1>') {
    bodyHtml = await body.evaluate(el => el.innerHTML);
  }
  strictEqual(bodyHtml, '<h1>OK</h1>');
  await page.close();
}

// Utility function for getting a random port
export async function getRandomPort() {
  return await new Promise((resolve) => {
    createServer(0, function () {
      resolve(this.address().port);
    });
  });
}

