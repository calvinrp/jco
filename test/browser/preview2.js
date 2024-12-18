import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdir, readFile, writeFile, rm, symlink, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, normalize, sep, extname, dirname } from "node:path";

import { fileURLToPath, pathToFileURL } from "url";
import mime from 'mime';
import puppeteer from "puppeteer";

import { transpile } from '../../src/api.js';
import { exec, jcoPath, testBrowserPage, getTmpDir, getRandomPort, setupAsyncTest } from "../helpers.js";

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

export async function browserPreview2Test() {
  suite("Browser preview2", () => {
    let tmpDir, outDir, outFile, outDirUrl;
    let server, browser, serverPort;

    suiteSetup(async function () {
      tmpDir = await getTmpDir();
      outDir = resolve(tmpDir, "out-component-dir");
      outDirUrl = pathToFileURL(outDir + '/');
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
        "dir"
      );
    });

    // Suite teardown
    suiteTeardown(async function () {
      try {
        await rm(tmpDir, { recursive: true });
      } catch {}
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    });

    // Per-test setup
    setup(async function() {
      serverPort = await getRandomPort();

      server = createServer(async (req, res) => {
        let fileUrl;
        // Serve URLs  that start with /transpiled/ (normally requested by the browser page
        // while running a test) with the contents of a file in the output directory of this suite
        if (req.url.startsWith('/transpiled/')) {
          fileUrl = new URL(`./${req.url.slice('/transpiled/'.length)}`, outDirUrl);
        } else if (req.url.startsWith('/builtin/')) {
          fileUrl = new URL(`./${req.url.slice('/transpiled/'.length)}`, outDirUrl);
        } else {
          fileUrl = new URL(`../${req.url}`, import.meta.url);
          console.log("TRYING TO GET URL", fileUrl);
        }
        try {
          const html = await readFile(fileUrl);
          res.writeHead(200, { 'content-type': mime.getType(extname(req.url)) });
          res.end(html);
        } catch (e) {
          if (e.code === 'ENOENT') {
            res.writeHead(404);
            res.end(e.message);
          } else {
            res.writeHead(500);
            res.end(e.message);
          }
        }
      }).listen(serverPort);

      browser = await puppeteer.launch();
    });

    // Per-test teardown
    teardown(async function () {
      try {
        await rm(outDir, { recursive: true });
        await rm(outFile);
      } catch {}
    });

    test('[async] http/incoming-handler impl', async () => {
      // Build a component dynamically that uses incoming handler
      const { esModuleRelativeSourcePath, cleanup } = await setupAsyncTest({
        component: {
          name: "browser_incoming_handler",
          build: {
            wit: { source: TEST_WIT_INTERFACE, world: "component" },
            js: {
              source: `
export const test = {
  test: () => {
  console.log("yep");
  }
}
`,
            },
          },
          outputDir: outDir,
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

      // console.log("PORT?", serverPort);
      // console.log("MODULE OUTPUT TO", esModuleRelativeSourcePath);
      // await new Promise(resolve => setTimeout(resolve, 60_000));

      await testBrowserPage({
        browser,
        serverPort,
        path: "browser/browser-preview2.html",
        hash: `transpiled:${esModuleRelativeSourcePath}`,
      });

      await cleanup();
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
