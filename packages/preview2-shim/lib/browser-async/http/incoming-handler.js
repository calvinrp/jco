// wasi:http/incoming-handler@0.2.0 interface

import { IncomingRequest, ResponseOutparam } from "./types.js";

/**
 * Polyfill for handling an incoming wasi:http request (i.e. `wasi:http/incoming-handler.handle`)
 *
 * Generally browsers generally do not provide implementations of wasi:http/incoming-handler.handle,
 * so this
 *
 * @param {IncomingRequest} incomingRequest
 * @param {ResponseOutparam} responseOutparam
 * @returns void
 */
export const handle = async (incomingRequest, responseOutparam) => {
  throw new Error("Unimplemented - browsers generally do not provide implementations of wasi:http/incoming-handler.handle");
};

/**
 * Helper function that given a wasi:http compliant incoming-handler function,
 * calls the function with native Web platform `Request`s, waits for the response to be computed,
 * and returns the
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Request/Request
 * @param {Function} handle - A function that adheres to the WASI HTTP spec for incoming-handler
 * @returns void
 */
export const genHandler = (handle) => async (req) => {
  const responseOut = new ResponseOutparam();
  await handle(IncomingRequest.fromRequest(req), responseOut);
  const result = await responseOut.promise;
  if (result.tag !== "ok") {
    throw result; // error
  }
  return result.val.toResponse();
};
