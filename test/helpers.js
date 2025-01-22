import { env, argv, execArgv } from "node:process";
import { createServer } from "node:net";
import {
  basename,
  join,
  isAbsolute,
  resolve,
  normalize,
  sep,
  relative,
  dirname,
} from "node:path";
import {
  cp,
  mkdtemp,
  writeFile,
  stat,
  mkdir,
  readFile,
} from "node:fs/promises";
import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { pathToFileURL } from "url";

import { transpile } from "../src/api.js";
import { componentize } from "../src/cmd/componentize.js";

// Path to the jco binary
export const jcoPath = "src/jco.js";

// Simple debug logging for tests
export function log(args, ..._rest) {
  if (!env.TEST_DEBUG) {
    return;
  }
  if (typeof args === "string") {
    args = { msg: args };
  }
  if (typeof args !== "object") {
    return;
  }
  if (args.extra || _rest.length > 0) {
    console.log(`[${args.level || "debug"}] ${args.msg}`, {
      ...args.extra,
      _rest,
    });
  } else {
    console.log(`[${args.level || "debug"}] ${args.msg}`);
  }
}

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
      code === 0 ? resolve() : reject(new Error((stderr || stdout).toString())),
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
 * @param {string} [args.jcoBinPath] - path to the jco binary (or a JS script)
 * @param {object} [args.transpile] - configuration related to transpilation
 * @param {string[]} [args.transpile.extraArgs] - arguments to pass along to jco transpilation
 * @param {object} args.component - configuration for an existing component that should be transpiled
 * @param {string} args.component.name - name of the component
 * @param {string} args.component.path - path to the WebAssembly binary for the existing component
 * @param {object[]} args.component.import - imports that should be provided to the module at instantiation time
 * @param {object} args.component.build - configuration for building an ephemeral component to be tested
 * @param {object} args.component.js.source - Javascript source code for a component
 * @param {object} args.component.wit.source - WIT definitions (inlined) for a component
 * @param {object[]} args.component.wit.deps - Dependencies (ex. WASI) that should be included during component build
 */
export async function setupAsyncTest(args) {
  const { asyncMode: _asyncMode, testFn, jco, component } = args;
  const asyncMode = _asyncMode || "asyncify";
  const jcoBinPath = jco?.binPath || jcoPath;

  let componentName = component.name;
  let componentPath = component.path;
  let componentImports = component.imports;

  if (component.path && component.build) {
    throw new Error(
      "Both component.path and component.build should not be specified at the same time",
    );
  }

  // If this component should be built "just in time" -- i.e. created when this test is run
  let componentBuildCleanup;
  if (component.build) {
    // Optionally use a custom pre-optimized StarlingMonkey engine
    if (env.TEST_CUSTOM_ENGINE_JIT_PATH || env.TEST_CUSTOM_ENGINE_AOT_PATH) {
      log("detected custom engine JIT path");
      if (component.build.componentizeOpts?.aot) {
        log("detected AOT config");
        component.build.engine = env.TEST_CUSTOM_ENGINE_AOT_PATH;
      } else {
        log("detected JIT config");
        component.build.engine = env.TEST_CUSTOM_ENGINE_JIT_PATH;
      }
    }

    // Build the component
    const { name, path, cleanup } = await buildComponent({
      name: componentName,
      ...component.build,
    });

    componentBuildCleanup = cleanup;
    componentName = name;
    componentPath = path;
  }

  if (!componentName) {
    throw new Error("invalid/missing component name");
  }
  if (!componentPath) {
    throw new Error("invalid/missing component path");
  }

  // Use either a temporary directory or an subfolder in an existing directory,
  // creating it if it doesn't already exist
  const outputDir = component.outputDir
    ? component.outputDir
    : await getTmpDir();

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
  if (asyncMode == "jspi" && typeof WebAssembly?.Suspending !== "function") {
    await cleanup();
    throw new Error(
      "JSPI async type skipped, but JSPI was not enabled -- please ensure test is run from an environment with JSPI integration (ex. node with the --experimental-wasm-jspi flag)",
    );
  }

  // Build a directory for the transpiled component output to be put in
  // (possibly inside the passed in outputDir)
  const moduleOutputDir = join(outputDir, component.name);
  try {
    await stat(moduleOutputDir);
  } catch (err) {
    if (err && err.code && err.code === "ENOENT") {
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
    outDir: moduleOutputDir,
    ...(jco?.transpile?.extraArgs || []),
  };

  // If we used a pre-optimized build, then we can set that before transpiling
  if (["yes", "true"].includes(env.TEST_CUSTOM_ENGINE_PREOPTIMIZED)) {
    log("using preoptimized engine build!");
    transpileOpts.preoptimized = true;
  }

  // log("EXEC ARGS?", transpileExecArgs);
  // log(`EXECable\njco ${transpileExecArgs.join(" ")}`);
  // await new Promise(resolve => setTimeout(resolve, 60_000));

  const componentBytes = await readFile(componentPath);

  // Perform transpilation, write out files
  const { files } = await transpile(componentBytes, transpileOpts);
  await Promise.all(
    Object.entries(files).map(async ([name, file]) => {
      await mkdir(dirname(name), { recursive: true });
      await writeFile(name, file);
    }),
  );

  // Write a minimal package.json
  await writeFile(
    `${moduleOutputDir}/package.json`,
    JSON.stringify({ type: "module" }),
  );

  // TODO: DEBUG module import not working, file is missing!
  // log("WROTE EVERYTHING:", moduleOutputDir);
  // await new Promise(resolve => setTimeout(resolve, 60_000));

  // Import the transpiled JS
  const esModuleOutputPath = join(moduleOutputDir, `${componentName}.js`);
  const esModuleSourcePath = pathToFileURL(esModuleOutputPath);
  const module = await import(esModuleSourcePath);

  // TODO: DEBUG module import not working, file is missing!
  // log("PRE INSTANTIATION", { moduleOutputDir });
  // await new Promise(resolve => setTimeout(resolve, 60_000_000));

  // Optionally instantiate the module
  //
  // It's useful to be able to skip instantiation of the instantiation should happen
  // elsewhere (ex. in a browser window)
  let instance = null;
  if (!component.skipInstantiation) {
    instance = await module.instantiate(undefined, componentImports || {});
  }

  return {
    module,
    esModuleSourcePath,
    esModuleRelativeSourcePath: relative(outputDir, esModuleOutputPath),
    instance,
    cleanup,
    component: {
      name: componentName,
      path: componentPath,
    },
  };
}

/**
 * Helper method for building a component just in time (e.g. to use in a test)
 *
 */
export async function buildComponent(args) {
  if (!args) {
    throw new Error("missing args");
  }
  const name = args.name;
  const jsSource = args.js?.source;
  const witDeps = args.wit?.deps;
  const witSource = args.wit?.source;
  const witWorld = args.wit?.world;
  if (!name) {
    throw new Error(
      "invalid/missing component name for in-test component build",
    );
  }
  if (!jsSource) {
    throw new Error("invalid/missing source for in-test component build");
  }
  if (!witSource) {
    throw new Error("invalid/missing WIT for in-test component build");
  }
  if (!witWorld) {
    throw new Error("invalid/missing WIT world for in-test component build");
  }

  // Create temporary output directory
  const outputDir = await getTmpDir();

  // Write the component's JS and WIT
  const jsSourcePath = join(outputDir, "component.js");
  const witOutputPath = join(outputDir, "wit");
  await mkdir(join(witOutputPath, "deps"), { recursive: true });
  const witSourcePath = join(witOutputPath, "component.wit");

  // Write the appropriate
  await Promise.all([
    await writeFile(jsSourcePath, jsSource),
    await writeFile(witSourcePath, witSource),
  ]);

  // Copy in additional WIT dependency files if provided
  if (witDeps) {
    for (const dep of witDeps) {
      if (!dep.srcPath) {
        throw new Error("Invalid wit dep object, missing srcPath");
      }
      if (!isAbsolute(dep.srcPath)) {
        throw new Error("Only absolute source paths are allowed");
      }
      if (dep.destPath && isAbsolute(dep.destPath)) {
        throw new Error(
          "Only relative dest paths are allowed (into the wit/deps directory)",
        );
      }

      const srcFileStats = await stat(dep.srcPath);
      const destPath =
        dep.destPath || (srcFileStats.isFile() ? basename(dep.srcPath) : ".");
      const outputPath = resolve(`${outputDir}/wit/deps/${destPath}`);

      if (srcFileStats.isFile()) {
        await writeFile(outputPath, await readFile(dep.srcPath));
      } else if (srcFileStats.isDirectory()) {
        await cp(dep.srcPath, outputPath, { recursive: true });
      } else {
        throw new Error(
          "unrecognized file type for WIT dep, neither file nor directory",
        );
      }
    }
  }

  // Build the output path to which we should write
  const outputWasmPath = join(outputDir, "component.wasm");

  // Build options for componentizing
  const wit = witDeps ? witOutputPath : witSourcePath;
  const options = {
    sourceName: "component",
    // If there were wit deps specified, we should use the whole wit dir
    // otherwise we can use just the single WIT source file
    wit,
    worldName: witWorld,
    out: outputWasmPath,
    quiet: true,
    // Add in optional raw options object to componentize
    ...(args.componentizeOpts || {}),
  };

  // Use a custom engine if specified
  if (args.engine) {
    const enginePath = resolve(args.engine);
    const engine = await stat(enginePath);
    if (engine.isFile()) {
      options.engine = enginePath;
    }
  }

  // Perform componentization
  await componentize(jsSourcePath, options);

  return {
    name,
    path: outputWasmPath,
    cleanup: async () => {
      try {
        await rm(outputDir);
      } catch {}
    },
  };
}

/**
 * Load a browser page, usually triggering test output that is written
 * to the HTML body of the page
 *
 * @param {object} args
 * @param {object} args.browser - Puppeteer browser instance
 * @param {object} [args.path] - Path to the HTML file to use, with root at `test` (ex. `test/browser.html` would be just `browser.html`)
 * @param {string} args.hash - Hash at which to perform tests (used to identify specific tests)
 */
export async function loadTestPage(args) {
  const { browser, hash } = args;
  if (!browser) {
    throw new Error("missing puppeteer instance browser object");
  }
  if (!hash) {
    throw new Error("missing hash for browser page");
  }

  const page = await browser.newPage();

  // Pass along all output to test
  if (env.TEST_DEBUG) {
    page
      .on("console", (message) =>
        log(
          `[browser] ${message.type().substr(0, 3).toUpperCase()} ${message.text()}`,
        ),
      )
      .on("pageerror", ({ message }) => log(`[browser] ${message}`))
      .on("response", (response) =>
        log(`[browser] ${response.status()} ${response.url()}`),
      )
      .on("requestfailed", (request) =>
        log(`[browser] ${request.failure().errorText} ${request.url()}`),
      );
  }

  const path = args.path ? args.path : "test/browser.html";
  const serverPort = args.serverPort ? args.serverPort : 8080;

  const hashURL = `http://localhost:${serverPort}/${path}#${hash}`;
  const hashTest = await page.goto(hashURL);
  ok(hashTest.ok(), `navigated to URL [${hashURL}]`);

  const body = await page.locator("body").waitHandle();

  let bodyHTML = await body.evaluate((el) => el.innerHTML);
  // If the body HTML uses "Running" to show state, wait until it changes
  if (bodyHTML == "<h1>Running</h1>") {
    while (bodyHTML === "<h1>Running</h1>") {
      bodyHTML = await body.evaluate((el) => el.innerHTML);
    }
  }

  // Attempt to parse the HTML body content as JSON
  const raw = bodyHTML;
  let testOutputJSON;
  try {
    testOutputJSON = JSON.parse(raw);
  } catch (err) {
    log(`failed to parse JSON for body HTML: ${e}`);
  }

  return {
    page,
    body,
    output: {
      raw,
      json: testOutputJSON,
    },
  };
}

// Utility function for getting a random port
export async function getRandomPort() {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, function () {
      const port = this.address().port;
      server.on("close", () => resolve(port));
      server.close();
    });
  });
}
