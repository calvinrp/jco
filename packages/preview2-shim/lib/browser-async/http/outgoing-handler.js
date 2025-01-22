// wasi:http/outgoing-handler@0.2.0 interface

import { FutureIncomingResponse } from "./types.js";

/**
 * Polyfill for handling an outgoing wasi:http request (i.e. `wasi:http/outgoing-handler.handle`)
 *
 * Generally this is resolved by making an external request (`fetch`, XMLHTTPRequest)
 *
 * @param {OutgoingRequest} incomingRequest
 * @param {ResponseOutparam} responseOutparam
 * @returns void
 */
export const handle = (request, _options) => {
  return new FutureIncomingResponse(request);
};
