// import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdir, readFile, writeFile, rm, symlink, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve, normalize, sep, extname, dirname } from "node:path";
import { ok, strictEqual } from "node:assert";

import { fileURLToPath, pathToFileURL } from "url";
import mime from 'mime';
import puppeteer from "puppeteer";

import { transpile } from '../../src/api.js';
import { exec, jcoPath, testBrowserPage, getTmpDir, getRandomPort, setupAsyncTest } from "../helpers.js";

export async function browserPreview2Test() {
  suite("Browser preview2", () => {
    let tmpDir, outDir, outFile, outDirUrl;
    let server, browser, serverPort;

    suiteSetup(async function () {
      tmpDir = await getTmpDir();
      outDir = resolve(tmpDir, "out-component-dir");
      outDirUrl = pathToFileURL(outDir + '/');
      outFile = resolve(tmpDir, "out-component-file");

      const modulesDir = resolve(tmpDir, "node_modules", "@bytecodealliance");
      await mkdir(modulesDir, { recursive: true });
      await symlink(
        fileURLToPath(new URL("../packages/preview2-shim", import.meta.url)),
        resolve(modulesDir, "preview2-shim"),
        "dir"
      );

      // Run a local server on a random port
      const serverPort = await getRandomPort();
      server = createServer(async (req, res) => {
        let fileUrl;
        if (req.url.startsWith('/tmpdir/')) {
          fileUrl = new URL(`.${req.url.slice(7)}`, outDirUrl);
        } else {
          fileUrl = new URL(`../${req.url}`, import.meta.url);
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

    suiteTeardown(async function () {
      try {
        await rm(tmpDir, { recursive: true });
      } catch {}
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    });

    teardown(async function () {
      try {
        await rm(outDir, { recursive: true });
        await rm(outFile);
      } catch {}
    });

    test('[async] http/incoming-handler impl', async () => {
      // Build a component dynamically that uses incoming handler
      const { moduleSourcePath, cleanup } = await setupAsyncTest({
        component: {
          name: "browser_incoming_handler",
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

      await testBrowserPage({
        browser,
        serverPort,
        path: "test/preview2.html",
        hash: 'test:preview2-incoming-handler',
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
