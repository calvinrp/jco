import { env, argv, execArgv } from "node:process";
import { createServer } from "node:net";
import { join, resolve, normalize, sep, relative, dirname } from "node:path";
import { mkdtemp, writeFile, stat, mkdir, readFile } from "node:fs/promises";
import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { pathToFileURL } from "url";

import { transpile } from "../src/api.js";
import { componentize } from "../src/cmd/componentize.js";

// Path to the jco binary
export const jcoPath = "src/jco.js";

// Execute a NodeJS script
//
// Note: argv[0] is expected to be `node` (or some incantation that spawned this process)
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
 * @param {object} [args.jcoBinPath] - path to the jco binary (or a JS script)
 * @param {object} [args.transpile] - configuration related to transpilation
 * @param {object} [args.transpile.extraArgs] - arguments to pass along to jco transpilation
 * @param {object} args.component - configuration for an existing component that should be transpiled
 * @param {object} args.component.name - name of the component
 * @param {object} args.component.path - path to the WebAssembly binary for the existing component
 * @param {object} args.component.import - imports that should be provided to the module at instantiation time
 * @param {object} args.component.build - configuration for building an ephemeral component to be tested
 * @param {object} args.component.js.source - Javascript source code for a component
 * @param {object} args.component.wit.source - WIT definitions (inlined) for a component
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
    const { name, path, cleanup } = await buildComponent({name: componentName, ...component.build});
    componentBuildCleanup = cleanup;
    componentName = name;
    componentPath = path;
  }

  if (!componentName) { throw new Error("invalid/missing component name"); }
  if (!componentPath) { throw new Error("invalid/missing component path"); }

  // Use either a temporary directory or an subfolder in an existing directory,
  // creating it if it doesn't already exist
  const outputDir = component.outputDir ? component.outputDir : await getTmpDir();

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

  // Build a directory for the transpiled component output to be put in
  // (possibly inside the passed in outputDir)
  const moduleOutputDir = join(outputDir, component.name);
  try {
    await stat(moduleOutputDir);
  } catch (err) {
    if (err && err.code && err.code === 'ENOENT') {
      await mkdir(moduleOutputDir);
    }
  }

  const transpileOpts = {
    name: componentName,
    minify: true,
    validLiftingOptimization: true,
    tlaCompat: true,
    optimize: false,
    base64Cutoff: 0,
    instantiation: "async",
    asyncMode,
    wasiShim: true,
    output: moduleOutputDir,
    ...(jco?.transpile?.extraArgs || []),
  };

  // console.log("EXEC ARGS?", transpileExecArgs);
  // console.log(`EXECable\njco ${transpileExecArgs.join(" ")}`);
  // await new Promise(resolve => setTimeout(resolve, 60_000));

  const componentBytes = await readFile(componentPath);

  // Perform transpilation, write out files
  const { files } = await transpile(componentBytes, transpileOpts);
  await Promise.all(Object.entries(files).map(async ([name, file]) => {
    await mkdir(dirname(name), { recursive: true });
    await writeFile(name, file);
  }));

  // Write a minimal package.json
  await writeFile(
    `${moduleOutputDir}/package.json`,
    JSON.stringify({ type: "module" })
  );

  console.log("MODULE BUILT");

  // Import the transpiled JS
  const esModuleOutputPath = join(moduleOutputDir, `${componentName}.js`);
  const esModuleSourcePath = pathToFileURL(esModuleOutputPath);
  const module = await import(esModuleSourcePath);

  // Instantiate the module
  const instance = await module.instantiate(
    undefined,
    componentImports || {},
  );
  console.log("Module instantiated");

  return {
    module,
    esModuleSourcePath,
    esModuleRelativeSourcePath: relative(outputDir, esModuleOutputPath),
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
  if (!args) { throw new Error("missing args"); }
  const name = args.name;
  const jsSource = args.js?.source;
  const witSource = args.wit?.source;
  const witWorld = args.wit?.world;
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

  // Componentize the given component, using the code for `jco componentize`
  await componentize(jsSourcePath, {
    sourceName: "component",
    wit: witSourcePath,
    worldName: witWorld,
    out: outputWasmPath,
    quiet: true,
    // Add in optional raw options object to componentize
    ...(args.componentizeOpts || {}),
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
 * @param {object} args.browser - Puppeteer browser instance
 * @param {object} [args.path] - Path to the HTML file to use, with root at `test` (ex. `test/browser.html` would be just `browser.html`)
 * @param {string} args.hash - Hash at which to perform tests (used to identify specific tests)
*/
export async function testBrowserPage(args) {
  const { browser, hash } = args;
  if (!browser) { throw new Error("missing puppeteer instance browser object"); }
  if (!hash) { throw new Error("missing hash for browser page"); }

  const page = await browser.newPage();
  const path = args.path ? args.path : 'test/browser.html';
  const serverPort = args.serverPort ? args.serverPort : 8080;

  const hashURL = `http://localhost:${serverPort}/${path}#${hash}`;
  const hashTest = await page.goto(hashURL);
  ok(hashTest.ok(), `navigated to URL [${hashURL}]`);

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
    const server = createServer();
    server.listen(0, function() {
      const port = this.address().port;
      server.on('close', () => resolve(port));
      server.close();
    });
  });
}
