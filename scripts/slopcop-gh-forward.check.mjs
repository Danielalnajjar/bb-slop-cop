import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeRequest, decodeReply, forward } from "./slopcop-gh-forward";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "slopcop-forward-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wrapper = join(directory, "wrapper.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const files = argv.filter(x => x.startsWith("body=@")).map(x => readFileSync(x.slice(6)).toString("base64"));
process.stdout.write(JSON.stringify({ argv, files, stdin: readFileSync(0).toString("base64") }));
process.stderr.write("error stream\\r\\n\\u001b[31m literal escape");
process.exitCode = 7;
`, { mode: 0o700 });
  const bb = join(directory, "bb.mjs");
  writeFileSync(bb, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync(args[args.indexOf("--") + 1], args.slice(args.indexOf("--") + 2), { maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(JSON.stringify({ hostId: "host_dmmpcn4wuu", observation: "exited", exitCode: result.status, truncated: false, output: result.stdout.toString("utf8") }));
`, { mode: 0o700 });
  return { directory, wrapper, bb };
}

test("argv, body file and stdin cross the command boundary as bytes, without shell execution", (t) => {
  const f = fixture(t);
  const body = Buffer.from("José\n' \" ` $(touch not-a-command) \\ \r\n\u0000\u001b[31m", "utf8");
  const path = join(f.directory, "body with ' spaces.md");
  writeFileSync(path, body);
  const sentinel = join(f.directory, "must-not-exist");
  const argv = ["api", "repos/acme/repo/pulls/1/comments", "-F", `body=@${path}`, "", `$(touch ${sentinel})`];
  const input = Buffer.from([0, 255, 13, 10, 27, 1]);
  const request = { ...makeRequest(argv, input), wrapper: f.wrapper };
  const result = forward(request, f.bb);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr.toString(), "error stream\r\n\u001b[31m literal escape");
  const received = JSON.parse(result.stdout);
  assert.deepEqual(received.stdin, input.toString("base64"));
  assert.deepEqual(received.files, [body.toString("base64")]);
  assert.deepEqual(received.argv.slice(4), argv.slice(4));
  assert.ok(!existsSync(sentinel));
  assert.ok(!existsSync(received.argv[3].slice(6)), "remote temporary file must be removed");
});

test("file-bearing gh flags are transferred, raw fields and @- retain their semantics", () => {
  const argv = ["api", "x", "--field=body=@a", "-Fother=@b", "--input", "c", "--body-file=d", "-f", "literal=@not-a-file", "-F", "stdin=@-"];
  const request = makeRequest(argv, Buffer.from("stdin"), path => Buffer.from(`bytes:${path}`));
  assert.deepEqual(request.files.map(f => [f.index, f.prefix, Buffer.from(f.base64, "base64").toString()]), [
    [2, "--field=body=@", "bytes:a"], [3, "-Fother=@", "bytes:b"], [5, "", "bytes:c"], [6, "--body-file=", "bytes:d"],
  ]);
  assert.deepEqual(request.argv, argv);
});

test("missing body file fails the CLI before a remote write can run", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [resolve("scripts/slopcop-gh-forward"), "api", "x", "-F", `body=@${f.directory}/missing`], { input: "", encoding: "utf8", env: { ...process.env, BB_CLI: f.bb } });
  assert.equal(result.status, 125);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ENOENT/);
});

test("incomplete, truncated and malformed replies are never a successful post", () => {
  const reply = { protocol: "slopcop-forward-v1", exitCode: 0, stdout: "", stderr: "" };
  const result = { hostId: "host_dmmpcn4wuu", observation: "exited", exitCode: 0, truncated: false, output: JSON.stringify(reply) };
  for (const value of [
    "not JSON", JSON.stringify({ ok: false, error: { code: "offline" } }),
    JSON.stringify({ ...result, observation: "timed-out", terminalId: "term_1234567890" }),
    JSON.stringify({ ...result, truncated: true }),
    JSON.stringify({ ...result, output: "not JSON" }),
    JSON.stringify({ ...result, output: JSON.stringify({ ...reply, stdout: "!bad" }) }),
  ]) assert.throws(() => decodeReply(value));
});

test("dry run reconstructs a would-post body without invoking the wrapper", (t) => {
  const f = fixture(t);
  const body = Buffer.from("would-post: α\n`quoted` and $(not executable)");
  const request = makeRequest(["api", "x", "-F", "body=@local.md"], Buffer.alloc(0), () => body);
  request.wrapper = join(f.directory, "does-not-exist");
  request.dryRun = true;
  const result = forward(request, f.bb);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).files, [{ index: 3, base64: body.toString("base64") }]);
});


test("short body-file options on pr commands transfer the local file rather than a Pro path", () => {
  for (const argv of [["pr", "comment", "1", "-F", "local.md"], ["pr", "comment", "1", "-Flocal.md"]]) {
    const request = makeRequest(argv, Buffer.alloc(0), () => Buffer.from("body"));
    assert.equal(request.files.length, 1);
    assert.equal(Buffer.from(request.files[0].base64, "base64").toString(), "body");
  }
});

test("a BB timeout exits nonzero and preserves the terminal identity for recovery", (t) => {
  const f = fixture(t);
  writeFileSync(f.bb, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ observation: "timed-out", exitCode: null, terminalId: "term_1234567890", output: "", truncated: false }));
process.exitCode = 124;
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [resolve("scripts/slopcop-gh-forward"), "slopcop-login"], { input: "", encoding: "utf8", env: { ...process.env, BB_CLI: f.bb } });
  assert.equal(result.status, 125);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /term_1234567890/);
});


test("credential and arbitrary extension commands are not forwarded", () => {
  for (const argv of [["auth", "token"], ["extension", "exec", "x"], ["alias", "set", "x", "!env"]]) {
    assert.throws(() => makeRequest(argv, Buffer.alloc(0)), /only api/);
  }
});


test("body envelopes larger than one BB argument retain their bytes across chunks", (t) => {
  const f = fixture(t);
  const body = Buffer.from("line with quotes \" $(literal) α\r\n".repeat(600));
  const request = makeRequest(["api", "x", "-F", "body=@large.md"], Buffer.alloc(0), () => body);
  request.wrapper = f.wrapper;
  const received = JSON.parse(forward(request, f.bb).stdout);
  assert.deepEqual(received.files, [body.toString("base64")]);
});


test("stdin-bearing flags require input even when the caller has a TTY", () => {
  const body = Buffer.from("{\"body\":\"stdin remains data\"}\n");
  for (const argv of [["api", "x", "--input", "-"], ["api", "x", "--input=-"], ["api", "x", "-F", "body=@-"], ["pr", "comment", "1", "--body-file", "-"]]) {
    const request = makeRequest(argv, needsStdin => needsStdin ? body : Buffer.alloc(0));
    assert.deepEqual(Buffer.from(request.stdin, "base64"), body);
  }
  const request = makeRequest(["api", "x", "-f", "literal=@-"], needsStdin => needsStdin ? body : Buffer.alloc(0));
  assert.equal(request.stdin, "");
});
