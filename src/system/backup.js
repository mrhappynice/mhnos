import * as fs from '../kernel/fs.js';

const BACKUP_CONFIG_PATH = '/system/backup.json';
const AWS4FETCH_URL = 'https://esm.sh/aws4fetch';
const FFLATE_URL = 'https://esm.sh/fflate';
const DEFAULT_KDF = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 150000
};

let awsClientPromise = null;
let fflatePromise = null;

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

function encodePath(path) {
    const clean = path.replace(/^\/+/, '');
    return clean.split('/').map(encodeURIComponent).join('/');
}

function buildKey(config, objectKey) {
    const prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${objectKey}` : objectKey;
}

function buildObjectUrl(config, key) {
    const base = config.endpoint.replace(/\/+$/, '');
    const bucket = config.bucket.replace(/^\/+|\/+$/g, '');
    const cleanKey = key.replace(/^\/+/, '');
    return `${base}/${bucket}/${cleanKey}`;
}

async function getAwsClient(config) {
    if (!awsClientPromise) {
        awsClientPromise = import(AWS4FETCH_URL).then((mod) => mod.AwsClient);
    }
    const AwsClient = await awsClientPromise;
    return new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region || 'auto',
        service: 's3'
    });
}

async function getFflate() {
    if (!fflatePromise) {
        fflatePromise = import(FFLATE_URL);
    }
    return await fflatePromise;
}

async function s3PutObject(config, key, body, contentType) {
    const client = await getAwsClient(config);
    const url = buildObjectUrl(config, key);
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    const res = await client.fetch(url, { method: 'PUT', headers, body });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 PUT failed: ${res.status} ${text}`);
    }
}

async function s3GetObject(config, key) {
    const client = await getAwsClient(config);
    const url = buildObjectUrl(config, key);
    const res = await client.fetch(url);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 GET failed: ${res.status} ${text}`);
    }
    return await res.arrayBuffer();
}

async function readBackupConfig() {
    const res = await fs.readFile(BACKUP_CONFIG_PATH, true);
    if (!res.success) return null;
    try {
        return JSON.parse(res.data);
    } catch {
        return null;
    }
}

async function writeBackupConfig(config) {
    return await fs.writeFile(BACKUP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function promptField(label, currentValue, options = {}) {
    const value = window.prompt(label, currentValue ?? '');
    if (value === null) return null;
    if (options.required && value.trim() === '' && currentValue) return currentValue;
    return value.trim();
}

async function ensureKdf(config) {
    if (!config.kdf) config.kdf = { ...DEFAULT_KDF };
    if (!config.kdf.saltB64) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        config.kdf.saltB64 = bytesToBase64(salt);
    }
}

async function deriveKey(passphrase, kdf) {
    const encoder = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    const salt = base64ToBytes(kdf.saltB64);
    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: kdf.iterations,
            hash: kdf.hash
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptBuffer(key, buffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    return { iv, ciphertext };
}

async function decryptBuffer(key, iv, buffer) {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buffer);
}

async function hashBuffer(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return bytesToHex(digest);
}

function redactConfig(config) {
    if (!config) return null;
    return {
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region,
        prefix: config.prefix || '',
        accessKeyId: config.accessKeyId ? `${config.accessKeyId.slice(0, 4)}...` : '',
        secretAccessKey: config.secretAccessKey ? '***' : '',
        kdf: config.kdf
    };
}

async function promptPassphrase(shell) {
    const passphrase = window.prompt('Backup passphrase (not stored)');
    if (!passphrase) {
        shell.print('Backup cancelled (no passphrase provided).', 'error');
        return null;
    }
    return passphrase;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function pickZipFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        input.onchange = () => {
            const file = input.files && input.files[0];
            input.remove();
            resolve(file || null);
        };
        document.body.appendChild(input);
        input.click();
    });
}

export async function runBackupCommand(shell, args) {
    const sub = args[0];
    if (!sub || sub === 'help') {
        shell.print("Usage: backup <config|push|pull|list|local>", 'system');
        shell.print("backup config set  - configure S3 settings", 'system');
        shell.print("backup config show - show current config", 'system');
        shell.print("backup config test - verify S3 access", 'system');
        shell.print("backup push        - encrypt and upload OPFS", 'system');
        shell.print("backup pull        - restore from remote", 'system');
        shell.print("backup list        - list files from remote manifest", 'system');
        shell.print("backup local push  - export encrypted zip to device", 'system');
        shell.print("backup local pull  - restore from encrypted zip", 'system');
        return;
    }

    if (sub === 'config') {
        const action = args[1] || 'show';
        if (action === 'show') {
            const config = await readBackupConfig();
            if (!config) {
                shell.print('No backup config found.', 'error');
                return;
            }
            shell.print(JSON.stringify(redactConfig(config), null, 2));
            return;
        }
        if (action === 'set') {
            const existing = await readBackupConfig();
            const endpoint = promptField('S3 endpoint (e.g. https://<account>.r2.cloudflarestorage.com)', existing?.endpoint, { required: true });
            if (endpoint === null || endpoint === '') return shell.print('Config cancelled.', 'error');
            const bucket = promptField('Bucket name', existing?.bucket, { required: true });
            if (bucket === null || bucket === '') return shell.print('Config cancelled.', 'error');
            const region = promptField('Region (R2 uses auto)', existing?.region || 'auto', { required: true });
            if (region === null || region === '') return shell.print('Config cancelled.', 'error');
            const accessKeyId = promptField('Access Key ID', existing?.accessKeyId, { required: true });
            if (accessKeyId === null || accessKeyId === '') return shell.print('Config cancelled.', 'error');
            const secretAccessKey = promptField('Secret Access Key', existing?.secretAccessKey, { required: true });
            if (secretAccessKey === null || secretAccessKey === '') return shell.print('Config cancelled.', 'error');
            const prefix = promptField('Prefix (optional)', existing?.prefix || '', { required: false }) || '';

            const config = {
                endpoint,
                bucket,
                region,
                accessKeyId,
                secretAccessKey,
                prefix,
                kdf: existing?.kdf ? { ...existing.kdf } : { ...DEFAULT_KDF }
            };
            await ensureKdf(config);
            const res = await writeBackupConfig(config);
            if (res.success) shell.print(`Saved backup config to ${BACKUP_CONFIG_PATH}`, 'success');
            else shell.print(`Failed to save config: ${res.error}`, 'error');
            return;
        }
        if (action === 'test') {
            const config = await readBackupConfig();
            if (!config) return shell.print('Backup config missing. Run: backup config set', 'error');
            const testKey = buildKey(config, `__mhnos_test/${Date.now()}.txt`);
            const payload = new TextEncoder().encode('mhnos backup test');
            shell.print('Testing S3 access (PUT + GET)...', 'system');
            try {
                await s3PutObject(config, testKey, payload, 'text/plain');
                await s3GetObject(config, testKey);
                shell.print('S3 test OK.', 'success');
            } catch (err) {
                shell.print(`S3 test failed: ${err.message}`, 'error');
            }
            return;
        }
        shell.print('Usage: backup config <show|set|test>', 'error');
        return;
    }

    if (sub === 'push') {
        const config = await readBackupConfig();
        if (!config) return shell.print('Backup config missing. Run: backup config set', 'error');
        await ensureKdf(config);
        const passphrase = await promptPassphrase(shell);
        if (!passphrase) return;
        const key = await deriveKey(passphrase, config.kdf);

        shell.print('Scanning OPFS...', 'system');
        const tree = await fs.getFullTree();
        const files = tree.filter((item) => item.kind === 'file');
        shell.print(`Found ${files.length} files. Uploading...`, 'system');

        const manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            kdf: config.kdf,
            files: []
        };

        for (const item of files) {
            const file = await item.handle.getFile();
            const buffer = await file.arrayBuffer();
            const hash = await hashBuffer(buffer);
            const { iv, ciphertext } = await encryptBuffer(key, buffer);

            const objectKey = buildKey(config, `data/${encodePath(item.path)}`);
            await s3PutObject(config, objectKey, ciphertext, 'application/octet-stream');

            manifest.files.push({
                path: item.path,
                size: file.size,
                mtime: file.lastModified,
                hash,
                ivB64: bytesToBase64(iv),
                algo: 'AES-GCM'
            });
            shell.print(`Uploaded: ${item.path}`, 'success');
        }

        const manifestKey = buildKey(config, 'backup.json');
        await s3PutObject(
            config,
            manifestKey,
            JSON.stringify(manifest, null, 2),
            'application/json'
        );
        shell.print('Backup manifest uploaded.', 'accent');
        return;
    }

    if (sub === 'local') {
        const action = args[1];
        if (!action || (action !== 'push' && action !== 'pull')) {
            shell.print("Usage: backup local <push|pull>", 'error');
            return;
        }

        if (action === 'push') {
            const passphrase = await promptPassphrase(shell);
            if (!passphrase) return;

            const kdf = { ...DEFAULT_KDF };
            const salt = crypto.getRandomValues(new Uint8Array(16));
            kdf.saltB64 = bytesToBase64(salt);
            const key = await deriveKey(passphrase, kdf);

            shell.print('Scanning OPFS...', 'system');
            const tree = await fs.getFullTree();
            const files = tree.filter((item) => item.kind === 'file');

            const manifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                kdf,
                files: []
            };

            const { zipSync, strToU8 } = await getFflate();
            const entries = {};

            for (const item of files) {
                const file = await item.handle.getFile();
                const buffer = await file.arrayBuffer();
                const hash = await hashBuffer(buffer);
                const { iv, ciphertext } = await encryptBuffer(key, buffer);
                const zipPath = `data/${encodePath(item.path)}`;
                entries[zipPath] = new Uint8Array(ciphertext);
                manifest.files.push({
                    path: item.path,
                    size: file.size,
                    mtime: file.lastModified,
                    hash,
                    ivB64: bytesToBase64(iv),
                    algo: 'AES-GCM'
                });
                shell.print(`Packed: ${item.path}`, 'success');
            }

            entries['backup.json'] = strToU8(JSON.stringify(manifest, null, 2));
            const zipBytes = zipSync(entries, { level: 0 });
            const filename = `mhnos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
            downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), filename);
            shell.print(`Local backup saved: ${filename}`, 'accent');
            return;
        }

        if (action === 'pull') {
            const file = await pickZipFile();
            if (!file) {
                shell.print('No zip selected.', 'error');
                return;
            }
            const passphrase = await promptPassphrase(shell);
            if (!passphrase) return;

            const buffer = await file.arrayBuffer();
            const { unzipSync, strFromU8 } = await getFflate();
            const entries = unzipSync(new Uint8Array(buffer));
            if (!entries['backup.json']) {
                shell.print('Invalid backup zip: missing backup.json', 'error');
                return;
            }

            const manifest = JSON.parse(strFromU8(entries['backup.json']));
            const kdf = manifest.kdf;
            if (!kdf || !kdf.saltB64) {
                shell.print('Invalid backup zip: missing KDF data', 'error');
                return;
            }
            const key = await deriveKey(passphrase, kdf);

            shell.print(`Restoring ${manifest.files.length} files...`, 'system');
            for (const entry of manifest.files) {
                const zipPath = `data/${encodePath(entry.path)}`;
                const cipherBytes = entries[zipPath];
                if (!cipherBytes) {
                    shell.print(`Missing entry in zip: ${entry.path}`, 'error');
                    continue;
                }
                const cipherBuf = cipherBytes.buffer.slice(
                    cipherBytes.byteOffset,
                    cipherBytes.byteOffset + cipherBytes.byteLength
                );
                const iv = base64ToBytes(entry.ivB64);
                const plainBuf = await decryptBuffer(key, iv, cipherBuf);
                const hash = await hashBuffer(plainBuf);
                if (hash !== entry.hash) {
                    shell.print(`Hash mismatch: ${entry.path}`, 'error');
                    continue;
                }
                const res = await fs.writeFile(entry.path, plainBuf);
                if (res.success) shell.print(`Restored: ${entry.path}`, 'success');
                else shell.print(`Failed to write ${entry.path}: ${res.error}`, 'error');
            }
            shell.print('Local restore completed.', 'accent');
            return;
        }
    }

    if (sub === 'pull') {
        const config = await readBackupConfig();
        if (!config) return shell.print('Backup config missing. Run: backup config set', 'error');

        const manifestKey = buildKey(config, 'backup.json');
        const manifestBuf = await s3GetObject(config, manifestKey);
        const manifestText = new TextDecoder().decode(manifestBuf);
        const manifest = JSON.parse(manifestText);

        const kdf = manifest.kdf || config.kdf;
        if (!kdf || !kdf.saltB64) {
            shell.print('Missing KDF settings. Update backup config and retry.', 'error');
            return;
        }

        const passphrase = await promptPassphrase(shell);
        if (!passphrase) return;
        const key = await deriveKey(passphrase, kdf);

        shell.print(`Restoring ${manifest.files.length} files...`, 'system');
        for (const entry of manifest.files) {
            const objectKey = buildKey(config, `data/${encodePath(entry.path)}`);
            const cipherBuf = await s3GetObject(config, objectKey);
            const iv = base64ToBytes(entry.ivB64);
            const plainBuf = await decryptBuffer(key, iv, cipherBuf);
            const hash = await hashBuffer(plainBuf);
            if (hash !== entry.hash) {
                shell.print(`Hash mismatch: ${entry.path}`, 'error');
                continue;
            }
            const res = await fs.writeFile(entry.path, plainBuf);
            if (res.success) shell.print(`Restored: ${entry.path}`, 'success');
            else shell.print(`Failed to write ${entry.path}: ${res.error}`, 'error');
        }
        shell.print('Restore completed.', 'accent');
        return;
    }

    if (sub === 'list') {
        const config = await readBackupConfig();
        if (!config) return shell.print('Backup config missing. Run: backup config set', 'error');
        const manifestKey = buildKey(config, 'backup.json');
        const manifestBuf = await s3GetObject(config, manifestKey);
        const manifestText = new TextDecoder().decode(manifestBuf);
        const manifest = JSON.parse(manifestText);
        shell.print(`Files in backup: ${manifest.files.length}`, 'system');
        manifest.files.forEach((entry) => shell.print(entry.path));
        return;
    }

    shell.print('Unknown backup command. Use: backup help', 'error');
}
