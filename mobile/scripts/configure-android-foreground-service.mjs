import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

const iconVector = `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="24dp"\n    android:height="24dp"\n    android:viewportWidth="24"\n    android:viewportHeight="24">\n    <path\n        android:fillColor="#FFFFFFFF"\n        android:pathData="M12,2a10,10 0 1,0 0,20 10,10 0 1,0 0,-20zM10.2,7.4l1.8,1.8 1.8,-1.8 1.6,1.6 -1.8,1.8 1.8,1.8 -1.6,1.6 -1.8,-1.8 -1.8,1.8 -1.6,-1.6 1.8,-1.8 -1.8,-1.8z" />\n</vector>\n`;

function ensureManifest() {
  if (!existsSync(androidManifestPath)) {
    console.warn('[configure-android-foreground-service] AndroidManifest.xml not found, skipping foreground service configuration.');
    return;
  }

  let manifest = readFileSync(androidManifestPath, 'utf8');

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

  writeFileSync(androidManifestPath, `${manifest.trim()}\n`, 'utf8');
}

function ensureIcon() {
  if (!existsSync(drawableDir)) {
    mkdirSync(drawableDir, { recursive: true });
  }

  writeFileSync(iconPath, iconVector, 'utf8');
}

ensureManifest();
ensureIcon();
