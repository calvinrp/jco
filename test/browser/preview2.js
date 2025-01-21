import { env } from "node:process";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  mkdtemp,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
  normalize,
  sep,
  extname,
  dirname,
  relative,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extract } from "tar";

import mime from "mime";
import puppeteer from "puppeteer";

import { transpile } from "../../src/api.js";
import {
  log,
  exec,
  jcoPath,
  loadTestPage,
  getTmpDir,
  getRandomPort,
  setupAsyncTest,
} from "../helpers.js";

// Path to the fixutres
const FIXTURES_WASI_0_2_2_DIR = fileURLToPath(
  new URL("../fixtures/wasi/0.2.2", import.meta.url),
);
const FIXTURES_COMPONENTS_JS_DIR = fileURLToPath(
  new URL("../fixtures/components/js", import.meta.url),
);

// WIT interface for a testable component (possibly dynamically generated)
// Normally the component that adheres to this interface is expected to
// be called from the browser (see browser-preview2.html)
const TEST_WIT_INTERFACE = `
package examples:test;

interface test {
  test: func();
}

world component {
  export test;
}
`;

// TODO: take an argument for JSPI vs asyncify as the mode
export async function browserPreview2Test() {
  suite("Browser preview2", () => {
    let tmpDir, outDir, outFile, outDirUrl;
    let server, browser, serverPort;

    suiteSetup(async function () {
      tmpDir = await getTmpDir();
      outDir = resolve(tmpDir, "out-component-dir");
      outDirUrl = pathToFileURL(outDir + "/");
      await mkdir(outDir);
      outFile = resolve(tmpDir, "out-component-file");

      // Link the local preview2 shim directory into node_modules inside
      // the output directory, to enable components to access preview2 shim
      // imports when they are imported
      const modulesDir = resolve(tmpDir, "node_modules", "@bytecodealliance");
      await mkdir(modulesDir, { recursive: true });
      await symlink(
        fileURLToPath(new URL("../packages/preview2-shim", import.meta.url)),
        resolve(modulesDir, "preview2-shim"),
        "dir",
      );
    });

    // Suite teardown
    suiteTeardown(async function () {
      // Close the browser
      await browser.close();
      // Close the ephemeral server
      await new Promise((resolve) => server.close(resolve));

      // Remove temporary directory
      try {
        if (env.TEST_DEBUG_NO_CLEANUP) {
          log(`skipping cleanup, not removing temp dir [${tmpDir}]`);
        } else {
          await rm(tmpDir, { recursive: true });
        }
      } catch {}
    });

    // Per-test setup
    setup(async function () {
      serverPort = await getRandomPort();

      server = createServer(async (req, res) => {
        let fileUrl;
        // Serve special import-mapped URLs, usually on the request of the browser
        //
        // - /transpiled/ points to the built code in the course of the test (e.g. a transpiled component)
        // - /builtin/ points to the project itself (i.e. browser shims)
        // - all other files are served from one folder up
        //
        if (req.url.startsWith("/transpiled/")) {
          // Generated
          fileUrl = new URL(
            `./${req.url.slice("/transpiled/".length)}`,
            outDirUrl,
          );
        } else if (req.url.startsWith("/builtin/")) {
          // From the project
          fileUrl = new URL(
            `../../${req.url.slice("/builtin/".length)}`,
            import.meta.url,
          );
        } else {
          fileUrl = new URL(`../${req.url}`, import.meta.url);
        }

        // Attempt to read the file
        try {
          const html = await readFile(fileUrl);
          res.writeHead(200, {
            "content-type": mime.getType(extname(req.url)),
          });
          res.end(html);
        } catch (e) {
          if (e.code === "ENOENT") {
            log(`failed to find file [${fileUrl}]`);
            res.writeHead(404);
            res.end(e.message);
          } else {
            res.writeHead(500);
            res.end(e.message);
          }
        }
      }).listen(serverPort);

      browser = await puppeteer.launch();
      // TODO: puppeteer enable origin flag for JSPI
    });

    // Per-test teardown
    teardown(async function () {
      try {
        await rm(outDir, { recursive: true });
        await rm(outFile);
      } catch {}
    });

    // Build a component dynamically that uses incoming handler
    //
    // While the browser can't actualy use the incoming handler,
    // we can write a test component that *does* implement an incoming
    // handler and pass it to the browser shim.
    //
    // This test is special because as browsers (which serve as host environments) normally do not *provide*
    // an wasi:http/incoming-handler implementation, they deal with components that *export* one.
    //
    // In this case, the browser (host environment) must be able to convert a Web platform request into
    // the necessary WASI compliant shims in order for the component that is doing the exporting
    // to use it.
    test("[async] guest http/incoming-handler export ", async () => {
      const componentName = "browser-incoming-handler";
      const tarball = await extract({
        cwd: outDir, // Output directory for this test
        f: join(
          FIXTURES_COMPONENTS_JS_DIR,
          componentName,
          "transpiled-async.tar.gz",
        ),
      });
      const moduleName = componentName.toLowerCase().replaceAll("-", "_");
      const moduleRelPath = `${moduleName}/${moduleName}.js`;

      // Load the test page in the browser, which will trigger tests against
      // the component and/or related browser polyfills
      const {
        page,
        output: { json },
      } = await loadTestPage({
        browser,
        serverPort,
        path: "fixtures/browser/test-pages/wasi-http-incoming-handler.guest-export.async.preview2.html",
        hash: `transpiled:${moduleRelPath}`,
      });

      // Check the output expected to be returned from handle of the
      // guest export (this depends on the component)
      deepStrictEqual(json, { responseText: "Hello from Javascript!" });

      await page.close();
    });

    // test('[async] wasi:http/types impl', async () => {
    // });

    // test('[async] wasi:io/error impl', async () => {
    // });

    // test('[async] wasi:io/poll impl', async () => {
    // });

    // test('[async] wasi:io/streams impl', async () => {
    // });

    // test('[async] wasi:random/random impl', async () => {
    // });

    // test('[async] wasi:random/insecure impl', async () => {
    // });
  });
}
