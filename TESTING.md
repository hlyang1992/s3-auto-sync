# Testing

## Automated release checks

Version 0.1.5 passes **244 tests across six suites**. Production-code coverage is 98.23% statements, 93.71% branches, 97.88% functions, and 99.61% lines. Coverage gates remain 95% statements, 90% branches, 95% functions, and 98% lines.

| Suite | Tests | Main coverage |
| --- | ---: | --- |
| Model | 55 | Configuration, paths, manifest validation, hashing |
| S3 transport | 59 | SigV4, pagination, conditional writes, weak ETags, timeouts, probes, conditional GET |
| Sync engine | 33 | Concurrent clients, conflicts, deletion, rename, corruption, restart, incremental transfers |
| Scheduler | 9 | Startup barrier, debounce, polling, retries, serialization, stop |
| Vault adapter | 28 | File APIs, conflict copies, recovery, concurrent edits, hash cache, custom configuration directory protection |
| Plugin/UI | 60 | Manual default, settings, connection feedback, lifecycle, device state, automatic mode, incremental cache reuse |

Run with Node.js 22.12 or newer:

```sh
npm ci
npm run lint
npm run coverage
npm run package
npm run verify-package
```

Type checking uses the Obsidian 1.8.7 API, matching the minimum declared version. The official Obsidian ESLint plugin reports no errors. Current advisory warnings concern the newer declarative settings API (introduced after our minimum API) and platform-independent timeout helpers. The settings status interval uses its owning window and is cleaned up on hide/unload; scheduler and request timers are also cleared when their work ends or stops.

The package verifier checks the archive file list, compares bundled code and manifest byte/content identity, and evaluates the CommonJS entry point with only `obsidian` as an external module. CI runs these checks on Linux without S3 credentials. Lifecycle tests await the actual command/startup promises before advancing the scheduler clock, so native WebCrypto work is not mistaken for completed work on a slower runner.

## Live evidence and boundaries

macOS Obsidian 1.13.7 loading and the settings connection button have been tested with Cloudflare R2. The connection check verifies listing, write/read, matching conditional update, rejected conflicting updates/creates, and probe removal. Normal user synchronization has also completed on that installation.

The prior 0.1.3 incremental implementation was measured on an unchanged 44-file vault: a cold pass took about 1.31 seconds, and two warm read-only passes took 0.35 and 0.32 seconds with no file-content reads and a 304 index response. This is one local sample, not a performance guarantee. The benchmark did not upload, delete, or modify notes.

These results do **not** establish complete multi-device cloud or mobile compatibility. The full synthetic live suite requires an independent bucket; available credentials could not create one, so that suite remains unexecuted. Physical Windows, iOS, and Android testing is pending. Unit tests use an in-memory remote and mocked Obsidian APIs, including deterministic concurrent-client cases.

## Optional independent-bucket integration suite

Create a dedicated bucket named `s3-auto-sync-test-<suffix>`. Store test credentials in a local file outside version control with restrictive permissions:

```json
{
  "endpoint": "https://your-s3-endpoint.example",
  "bucket": "s3-auto-sync-test-example",
  "accessKeyId": "YOUR_TEST_ACCESS_KEY",
  "secretAccessKey": "YOUR_TEST_SECRET_KEY",
  "region": "us-east-1",
  "prefix": "",
  "pathStyle": true
}
```

```sh
S3_TEST_CONFIG='/absolute/path/test-config.json' npm run test:live
```

The script refuses buckets without the test-only prefix. It uses synthetic files in a unique run prefix, including a 2 MB attachment and 1,005 objects for pagination, and exercises conflicts, disconnection/recovery, baseline reload, and initial object indexing. It reads the explicitly supplied credential file and writes local scratch data under `.private/` and reports under `reports/`. Synthetic cloud data is retained for inspection. Never supply your note bucket.

The developer-only `create-test-bucket.ts` utility can create a test bucket using an explicitly supplied `REMOTELY_SAVE_CONFIG` path if those credentials permit bucket creation. It is not bundled or exposed in the plugin settings. Local installation-check and benchmark utilities require an explicit `OBSIDIAN_TEST_VAULT` and write private reports; they are not part of CI or the installed plugin.
