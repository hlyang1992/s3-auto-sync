# S3 Auto Sync

Sync Obsidian notes and attachments with your own S3-compatible storage, including Cloudflare R2. **Manual sync is the default.** Enable automatic sync when you want a startup pull followed by continuous synchronization.

The settings interface is currently in Chinese. Requires Obsidian 1.8.7 or newer.

## Getting started

1. Install **S3 Auto Sync** from the community directory when available, or download the files from [Releases](https://github.com/hlyang1992/s3-auto-sync/releases). For manual installation, put `main.js`, `manifest.json`, and `styles.css` in `<vault>/<configuration directory>/plugins/s-three-auto-sync/`, then enable the plugin. The usual configuration directory is `.obsidian`.
2. Enter your HTTPS **Endpoint**, **Bucket**, **Access Key**, and **Secret Key**. Advanced settings provide Region, remote prefix, and path-style addressing. R2 region is handled automatically.
3. Click **检查连接** (Check connection). It tests the current fields without saving them or synchronizing notes.
4. Click **保存 S3 配置** (Save S3 configuration). Saving switches this device to manual mode and makes no network request.
5. Disable Remotely Save / Remotely Sync for the same sync location on all participating devices, then click **立即同步** (Sync now). A ribbon button and command provide the same operation.
6. Optionally enable **自动同步** (Automatic sync). The choice is retained separately on each device. Turning it off returns to manual mode.

Use a dedicated bucket or prefix. The provider must support object listing, reads, writes, deletes, and correct `If-Match` / `If-None-Match` conditional writes. Check connection verifies these with a small temporary object and removes it afterward. Each check request has a 15-second timeout, and progress is shown in settings.

## Synchronization behavior

- **Manual:** one click pulls remote changes first, then uploads local changes, and stops. Starting Obsidian or editing a note does not start a sync. Failures show an error without an automatic retry.
- **Automatic:** pulls after the vault loads, then synchronizes local changes after a 3-second debounce (10-second maximum while editing continuously). It checks for remote changes about 30 seconds after each completed round and catches up on focus or reconnection. Failed rounds retry with a backoff from 5 seconds to 5 minutes.
- **Incremental:** only files whose contents changed are transferred. Unchanged local files reuse short-lived in-memory SHA-256 hashes; edits invalidate them. The remote index uses conditional GET, avoiding its response body when unchanged. This is file-level synchronization, so changing a large attachment transfers the whole file.
- **Progress:** settings and the status bar show the current operation and file. Completion reports uploads, downloads, deletions, and conflict copies, including an explicit no-changes result.
- **Conflicts:** when both devices changed a file, the remote content occupies the original path and local differences are preserved as `.conflict-<hash>` copies. Content checksums and conditional index updates protect against corrupt downloads and concurrent commits.
- **Deletions:** synchronized deletions leave a remote tombstone. Local removals use Obsidian's trash and retain a recovery copy. A round deleting at least 10 files and at least 25% of active remote files stops for review.

Regular files and attachments are included. Hidden files/directories and the vault's configured Obsidian configuration directory are excluded, even when that directory has a custom non-hidden name. Empty folders are not synchronized. Nonportable filenames, case collisions, and file/folder collisions stop the round with an error.

## Remote format and existing objects

The plugin uses its own format:

```text
<prefix>/.s3-auto-sync/manifest.json       Current index, revision, and tombstones
<prefix>/.s3-auto-sync/blobs/<sha256>      Immutable file content
```

On the first synchronization, existing unencrypted ordinary S3 objects in the selected prefix are indexed. Existing objects are not overwritten or deleted. This initial pass can take longer because it reads and indexes each file; progress includes a file count. Encrypted Remotely Save data is not supported.

After initialization, every device using this S3 location must use this plugin. Other sync plugins and direct edits to the original ordinary S3 objects do not update this index. The plugin blocks synchronization if Remotely Save / Remotely Sync is loaded on the same device; other devices must be switched separately. There is no settings-import button.

## Recovery and retained versions

Overwritten or removed local content is retained at `.s3-auto-sync-recovery/<original SHA-256>` inside the vault. These are raw file contents; restore by copying a recovery file to a regular path with the appropriate extension. Remote tombstones retain the original content hash, which can be used to retrieve its blob.

The **重新拉取远端（保留本地差异副本）** command resets this device's baseline and performs one sync in manual mode, preserving local differences. It can restore files still present remotely, but cannot undo a deletion already committed to the remote index.

Content blobs are immutable and currently are not automatically removed. Recovery copies are not automatically removed either, so storage usage can grow. **There is no history browser or complete per-file revision timeline.** Retained blobs and recovery copies do not replace an independent backup.

## Privacy, network access, and costs

- A storage-provider account, bucket, and S3 credentials are required. This plugin is free and open source; your provider may charge for storage, requests, and transfer. There is no developer-operated sync service or plugin subscription.
- The plugin sends note contents, attachment contents, filenames, metadata, and a synchronization index to the HTTPS S3 endpoint you configure. Connection checks send temporary probe content there. The plugin has no analytics, telemetry, advertising, update service, or other network destination.
- Credentials are saved unencrypted in the plugin's local `data.json` through Obsidian's settings API. Do not share that file. Software synchronizing your configuration directory may copy these credentials to other devices. Sync mode and the synchronization baseline are kept separately in device-local Obsidian storage.
- Transport uses HTTPS and S3 request signing. The plugin does not provide end-to-end encryption; storage access is controlled by your provider and credentials.
- Runtime file access stays within the vault through Obsidian APIs, apart from any trash destination selected by Obsidian. Recovery copies are inside the vault. Developer test scripts are separate from the installed plugin and only run when explicitly invoked.

## Limits and compatibility

Synchronization runs only while Obsidian and the vault are active. Mobile operating systems can suspend the app. It is not real-time collaborative editing or a background daemon.

Whole files are read into memory; large attachments increase memory use and transfer time. Normal requests time out after 60 seconds. Markdown replacements use Obsidian's atomic `Vault.process` content check. Binary replacements are backed up and checked again, but the API does not provide an atomic comparison-and-write across processes.

You can keep an existing iCloud workflow, but avoid running multiple S3 bridges over the same iCloud-backed files. Changes overwritten by another service before this plugin observes them cannot be recovered by this plugin.

Verified on macOS with Obsidian 1.13.7, with compile-time API compatibility checked against 1.8.7. Mobile loading is allowed, but physical iOS, Android, and Windows validation is still pending. Cloudflare R2 connection and conditional-write checks passed; a full multi-client live test on an independent test bucket has not yet been completed. See [Testing](TESTING.md) for scope and reproducible checks.

## Development

Use Node.js 22.12 or newer and npm:

```sh
npm ci
npm run lint
npm run coverage
npm run package
npm run verify-package
```

Source is in `src/`; mocked adapter, synchronization, scheduler, and UI tests are in `test/`. GitHub Actions runs the same checks without cloud credentials. Release tags match `manifest.json` exactly, without a `v` prefix. Release assets include `main.js`, `manifest.json`, and `styles.css`.

[Report an issue](https://github.com/hlyang1992/s3-auto-sync/issues) with the plugin version, Obsidian version, operating system, and the displayed error. Remove credentials, bucket/account identifiers, and private filenames from logs or screenshots before posting.

## 中文快速说明

默认手动同步，填好 S3 配置后点击“检查连接”，保存后点击“立即同步”。需要持续同步时打开“自动同步”：启动先拉取，本地修改后合并触发同步，每隔约 30 秒检查其他设备的修改。同步只传输内容有变化的文件。

密钥保存在本地插件配置中；请勿分享 `data.json`。使用同一远端目录的设备都要切换到本插件。首次接入已有未加密对象需要建立索引，可能较慢。历史内容保留但尚无图形化版本浏览器，远端内容块和本地恢复副本目前不会自动清理。

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
