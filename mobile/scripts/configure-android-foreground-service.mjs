import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidManifestPath = resolve(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const drawableDir = resolve(projectRoot, 'android', 'app', 'src', 'main', 'res', 'drawable');
const iconPath = resolve(drawableDir, 'ic_stat_datasetto.xml');

const manifestRequirements = {
  toolsNamespace: 'xmlns:tools="http://schemas.android.com/tools"',
  receiver: '<receiver\n            android:name="io.capawesome.capacitorjs.plugins.foregroundservice.NotificationActionBroadcastReceiver"\n            android:exported="false" />',
  service: '<service\n            android:name="io.capawesome.capacitorjs.plugins.foregroundservice.AndroidForegroundService"\n            android:exported="false"\n            android:foregroundServiceType="microphone" />',
};

const permissions = [
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission\n        android:name="android.permission.BLUETOOTH_CONNECT"\n        android:usesPermissionFlags="neverForLocation"\n        tools:targetApi="s" />',
];

const features = [
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
];

// The manifest fragments above are joined with \n. The manifest is edited on LF so they match
// on a CRLF checkout (Windows, core.autocrlf=true) as well as an LF one, and written back in the
// line-ending style it was read in, so repeated runs leave the file byte-for-byte unchanged.
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function withEol(text, eol) {
  return eol === '\n' ? text : normalizeEol(text).replace(/\n/g, eol);
}

function ensureManifest() {
  if (!existsSync(androidManifestPath)) {
    console.warn('[configure-android-foreground-service] AndroidManifest.xml not found, skipping foreground service configuration.');
    return;
  }

  const source = readFileSync(androidManifestPath, 'utf8');
  const eol = detectEol(source);
  let manifest = normalizeEol(source);

  const receiverRegex = /<receiver[\s\S]*?NotificationActionBroadcastReceiver[\s\S]*?>/;
  const serviceRegex = /<service[\s\S]*?AndroidForegroundService[\s\S]*?>/;

  if (!manifest.includes(manifestRequirements.toolsNamespace)) {
    const hookSimple = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">';
    const hookIndented = '<manifest\n    xmlns:android="http://schemas.android.com/apk/res/android"';

    if (manifest.includes(hookSimple)) {
      manifest = manifest.replace(
        hookSimple,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    ${manifestRequirements.toolsNamespace}>`
      );
    } else if (manifest.includes(hookIndented)) {
      manifest = manifest.replace(
        hookIndented,
        `${hookIndented}\n    ${manifestRequirements.toolsNamespace}`
      );
    }
  }

  if (receiverRegex.test(manifest)) {
    manifest = manifest.replace(receiverRegex, manifestRequirements.receiver);
  }

  if (serviceRegex.test(manifest)) {
    manifest = manifest.replace(serviceRegex, manifestRequirements.service);
  }

  const hasReceiver = manifest.includes('NotificationActionBroadcastReceiver');
  const hasService = manifest.includes('AndroidForegroundService');

  if (!hasReceiver || !hasService) {
    const fragments = [manifestRequirements.receiver, manifestRequirements.service]
      .filter((fragment) => !manifest.includes(fragment));

    if (fragments.length > 0) {
      manifest = manifest.replace('</application>', `        ${fragments.join('\n        ')}\n    </application>`);
    }
  }

  const permissionAnchor = '</manifest>';
  for (const permission of permissions) {
    if (!manifest.includes(permission)) {
      manifest = manifest.replace(permissionAnchor, `    ${permission}\n${permissionAnchor}`);
    }
  }

  for (const feature of features) {
    if (!manifest.includes(feature)) {
      manifest = manifest.replace(permissionAnchor, `    ${feature}\n${permissionAnchor}`);
    }
  }

  writeFileSync(androidManifestPath, withEol(`${manifest.trim()}\n`, eol), 'utf8');
}

// The notification icon (the brand mark in white) is committed and drawn by brand/generate.mjs.
function ensureIcon() {
  if (!existsSync(iconPath)) {
    console.warn('[configure-android-foreground-service] res/drawable/ic_stat_datasetto.xml is missing: run node brand/generate.mjs --only android.');
  }
}

ensureManifest();
ensureIcon();
