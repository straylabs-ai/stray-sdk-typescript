// Exercise the published ESM output using each runtime's native fetch.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { StraylabsClient, StraylabsTimeoutError, StraylabsTransportError } from "../dist/index.js";

let redirectedRequests = 0;
let mutationRequests = 0;
const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 0, 255]);
const sink = createServer((_request, response) => { redirectedRequests++; response.end("unexpected"); });
sink.listen(0, "127.0.0.1");
await once(sink, "listening");
const server = createServer((request, response) => {
  assert.equal(request.headers["x-api-key"], "runtime-fixture-key");
  assert.equal(request.headers.authorization, undefined);
  if (request.url === "/api/me/organizations") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ id: "org", name: "Fixture", is_owner: true, tier: "enterprise" }]));
  } else if (request.url === "/api/organizations/redirect/projects") {
    response.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/stolen` }); response.end();
  } else if (request.url === "/api/organizations/slow/projects") {
    response.writeHead(200, { "Content-Type": "application/json" }); response.write("[");
  } else if (request.url.endsWith("/report.pdf")) {
    response.setHeader("Content-Type", "application/pdf"); response.end(pdf);
  } else if (request.url.endsWith("/start-scan")) {
    mutationRequests++; request.socket.destroy();
  } else { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const client = new StraylabsClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api/`, apiKey: "runtime-fixture-key", maxReadRetries: 0 });
  assert.equal((await client.organizations.list())[0].id, "org");
  const ref = { organizationId: "org", projectId: "project" };
  assert.deepEqual((await client.reports.download(ref, "report.pdf")).bytes, pdf);
  await assert.rejects(client.projects.list("redirect"), StraylabsTransportError);
  assert.equal(redirectedRequests, 0, "Redirect must not forward the key to another origin");
  await assert.rejects(client.projects.list("slow", { timeoutMs: 30 }), StraylabsTimeoutError);
  await assert.rejects(client.scans.start(ref), error => error instanceof StraylabsTransportError && error.outcomeUnknown);
  assert.equal(mutationRequests, 1);
  console.log(`Built ESM/native fetch smoke checks passed (${process.versions.bun ? "Bun " + process.versions.bun : "Node " + process.versions.node}).`);
} finally {
  server.closeAllConnections(); sink.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => sink.close(resolve))]);
}
