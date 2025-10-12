package com.datasetto.mobile;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {
  private AudioManager audioManager;

  @Override
  public void load() {
    super.load();
    audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
  }

  @PluginMethod
  public void listRoutes(PluginCall call) {
    if (audioManager == null) {
      call.reject("AudioManager unavailable");
      return;
    }

    JSArray routes = new JSArray();
    // Always include speakerphone as the primary option
    routes.put(makeRoute("speakerphone", "Speakerphone", "speaker", isSpeakerphoneActive()));

    // Only include earpiece if the device actually has one
    boolean deviceHasEarpiece = hasEarpiece();
    if (deviceHasEarpiece) {
      routes.put(makeRoute("earpiece", "Phone Earpiece", "earpiece", isEarpieceActive()));
    }

    JSObject result = new JSObject();
    result.put("routes", routes);
    call.resolve(result);
  }

  @PluginMethod
  public void setRoute(PluginCall call) {
    String id = call.getString("id");

    if (audioManager == null) {
      call.reject("AudioManager unavailable");
      return;
    }

    boolean success;
    if (id == null || id.isEmpty() || "speakerphone".equals(id)) {
      // Default or explicit speakerphone selection
      success = routeToSpeakerphone();
    } else if ("earpiece".equals(id)) {
      if (!hasEarpiece()) {
        call.reject("Earpiece not available on this device");
        return;
      }
      success = routeToEarpiece();
    } else {
      call.reject("Unsupported or unavailable audio route: " + id);
      return;
    }

    if (success) {
      call.resolve();
    } else {
      call.reject("Failed to set audio route: " + id);
    }
  }

  private JSObject makeRoute(String id, String label, String type, boolean selected) {
    JSObject route = new JSObject();
    route.put("id", id);
    route.put("label", label);
    route.put("type", type);
    route.put("selected", selected);
    return route;
  }

  private boolean routeToSpeakerphone() {
    return setCommunicationDevice(true, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
  }

  private boolean routeToEarpiece() {
    if (!hasEarpiece()) {
      return false;
    }
    return setCommunicationDevice(false, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
  }

  private boolean setCommunicationDevice(boolean speakerphoneOn, int deviceType) {
    if (audioManager == null) {
      return false;
    }

    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    audioManager.stopBluetoothSco();
    audioManager.setBluetoothScoOn(false);
    audioManager.setSpeakerphoneOn(speakerphoneOn);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo device = findDevice(deviceType);
      if (device != null) {
        return audioManager.setCommunicationDevice(device);
      }
      if (speakerphoneOn) {
        audioManager.clearCommunicationDevice();
      }
    }

    return true;
  }

  private boolean hasEarpiece() {
    if (getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
      return true;
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      return findDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) != null;
    }

    return false;
  }

  private boolean isSpeakerphoneActive() {
    if (audioManager == null) {
      return false;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo current = audioManager.getCommunicationDevice();
      return current != null && current.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
    }
    return audioManager.isSpeakerphoneOn();
  }

  private boolean isEarpieceActive() {
    if (audioManager == null) {
      return false;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo current = audioManager.getCommunicationDevice();
      return current != null && current.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
    }
    return !audioManager.isSpeakerphoneOn() && hasEarpiece();
  }

  @Nullable
  private AudioDeviceInfo findDevice(int type) {
    if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      return null;
    }

    AudioDeviceInfo[] devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
    for (AudioDeviceInfo device : devices) {
      if (device.getType() == type) {
        return device;
      }
    }

    return null;
  }
}
