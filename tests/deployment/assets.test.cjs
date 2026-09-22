const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { unstable_startWorker } = require('wrangler');
const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'node_modules/wrangler/wrangler-dist/cli.js');
const publicFiles = ['index.html', 'app.js', 'data.js', 'price-view.js', 'styles.css', 'favicon.png'];

test('Workers deployment publishes only website assets', { timeout: 60000 }, async t => {
  // Isolate Wrangler's generated state and seed files that must never be public.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-assets-'));
  let worker;
  t.after(async () => {
    if (worker) await worker.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const file of [...publicFiles, '.assetsignore', 'wrangler.jsonc', 'package.json', 'package-lock.json', 'README.md']) {
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  const excluded = ['node_modules/workerd/bin/workerd', 'tests/private.txt', '.git/config', '.env', 'test-results/private.txt'];
  for (const file of excluded) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), 'not a website asset');
  }
  await fs.truncate(path.join(dir, excluded[0]), 26 * 1024 * 1024);
  const options = { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, timeout: 20000, maxBuffer: 1024 * 1024 };
  const dryRun = () => exec(process.execPath, [cli, 'deploy', '--dry-run'], options);
  // Prove the same preflight rejects an unfiltered oversized dependency.
  const ignore = await fs.readFile(path.join(dir, '.assetsignore'));
  await fs.unlink(path.join(dir, '.assetsignore'));
  await assert.rejects(dryRun(), error => /Asset too large/.test(error.stdout + error.stderr));
  await fs.writeFile(path.join(dir, '.assetsignore'), ignore);
  await dryRun();

  // The CLI's human-readable ready line is not an API. Disable watchers so
  // generated runtime state cannot trigger asset reload loops on Linux.
  worker = await unstable_startWorker({
    config: path.join(dir, 'wrangler.jsonc'),
    dev: { remote: false, watch: false, persist: false, server: { hostname: '127.0.0.1', port: 0 } },
  });
  await worker.ready;
  const address = (await worker.url).origin;
  for (const file of publicFiles) {
    const response = await fetch(address + (file === 'index.html' ? '/' : '/' + file));
    assert.equal(response.status, 200, file);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(path.join(root, file)), file);
  }
  for (const file of [...excluded, 'package.json', 'package-lock.json', 'README.md', 'wrangler.jsonc', '.assetsignore']) {
    const response = await fetch(address + '/' + file);
    assert.equal(response.status, 404, file);
    await response.arrayBuffer();
  }
});
