import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '..', '..');

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    return parse(content);
  } catch (error) {
    console.warn(`⚠️  Failed to read ${filePath}:`, error.message);
    return {};
  }
}

const opsEnv = loadEnv(resolve(repoRoot, 'ops', '.env'));
const clientMobileEnv = loadEnv(resolve(repoRoot, 'client', '.env.mobile'));
const clientProdEnv = loadEnv(resolve(repoRoot, 'client', '.env.production'));

function resolveValue(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

const resolvedServerUrl = resolveValue(
  process.env.VITE_SERVER_URL,
  clientMobileEnv.VITE_SERVER_URL,
  clientProdEnv.VITE_SERVER_URL,
  opsEnv.VITE_SERVER_URL,
  opsEnv.SERVER_URL
);

const resolvedApiBaseUrl = resolveValue(
  process.env.VITE_API_BASE_URL,
  clientMobileEnv.VITE_API_BASE_URL,
  clientProdEnv.VITE_API_BASE_URL,
  opsEnv.VITE_API_BASE_URL,
  opsEnv.API_BASE_URL,
  resolvedServerUrl
);

const resolvedHlsBaseUrl = resolveValue(
  process.env.VITE_HLS_BASE_URL,
  clientMobileEnv.VITE_HLS_BASE_URL,
  clientProdEnv.VITE_HLS_BASE_URL,
  opsEnv.VITE_HLS_BASE_URL,
  opsEnv.HLS_BASE_URL,
  resolvedServerUrl ? `${resolvedServerUrl.replace(/\/$/, '')}/hls` : undefined
);

const resolvedRtmpUrl = resolveValue(
  process.env.VITE_RTMP_SERVER_URL,
  clientMobileEnv.VITE_RTMP_SERVER_URL,
  clientProdEnv.VITE_RTMP_SERVER_URL,
  opsEnv.VITE_RTMP_SERVER_URL,
  resolvedServerUrl
    ? `rtmp://${resolvedServerUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}:1935/live`
    : undefined
);

const requiredValues = {
  VITE_SERVER_URL: resolvedServerUrl,
  VITE_API_BASE_URL: resolvedApiBaseUrl,
  VITE_HLS_BASE_URL: resolvedHlsBaseUrl,
  VITE_RTMP_SERVER_URL: resolvedRtmpUrl,
};

const missingEntries = Object.entries(requiredValues)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEntries.length > 0) {
  console.warn(
    `⚠️  Missing configuration for ${missingEntries.join(', ')}. The mobile build will fall back to localhost if these remain unset.`
  );
}

Object.assign(process.env, requiredValues, {
  NODE_ENV: 'production',
  VITE_BUILD_TARGET: 'mobile',
});

console.log('ℹ️  Building Datasetto web assets for mobile with the following endpoints:');
for (const [key, value] of Object.entries(requiredValues)) {
  console.log(`   ${key} = ${value ?? '<not set>'}`);
}

const build = spawn('npm', ['run', 'build', '--prefix', '../client'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

build.on('close', (code) => {
  if (code !== 0) {
    console.error(`❌ Web build failed with exit code ${code}.`);
    process.exit(code ?? 1);
  }

  console.log('✅ Web assets built successfully.');
});
