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
    JSArray routes = new JSArray();

    if (audioManager == null) {
      JSObject result = new JSObject();
      result.put("routes", routes);
      call.resolve(result);
      return;
    }

    boolean speakerSelected = isSpeakerphoneActive();
    boolean earpieceSelected = isEarpieceActive();

    routes.put(makeRoute("speakerphone", "Speakerphone", "speaker", speakerSelected));

    if (hasEarpiece()) {
      routes.put(makeRoute("earpiece", "Phone Earpiece", "earpiece", earpieceSelected));
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

    if (id == null || id.isEmpty() || "default".equals(id)) {
      success = routeToSpeakerphone();
    } else if ("speakerphone".equals(id)) {
      success = routeToSpeakerphone();
    } else if ("earpiece".equals(id)) {
      success = routeToEarpiece();
    } else {
      success = false;
    }

    if (success) {
      call.resolve();
    } else {
      call.reject("Unsupported or unavailable audio route: " + id);
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
    if (audioManager == null) {
      return false;
    }

    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    audioManager.stopBluetoothSco();
    audioManager.setBluetoothScoOn(false);
    audioManager.setSpeakerphoneOn(true);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo speaker = findDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
      if (speaker != null) {
        return audioManager.setCommunicationDevice(speaker);
      }
      audioManager.clearCommunicationDevice();
    }

    return true;
  }

  private boolean routeToEarpiece() {
    if (audioManager == null || !hasEarpiece()) {
      return false;
    }

    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    audioManager.stopBluetoothSco();
    audioManager.setBluetoothScoOn(false);
    audioManager.setSpeakerphoneOn(false);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo earpiece = findDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
      if (earpiece != null) {
        return audioManager.setCommunicationDevice(earpiece);
      }
    }

    return true;
  }

  private boolean hasEarpiece() {
    if (audioManager == null) {
      return false;
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      AudioDeviceInfo[] devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
      for (AudioDeviceInfo device : devices) {
        if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
          return true;
        }
      }
      return false;
    }

    PackageManager pm = getContext().getPackageManager();
    return pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
  }

  private boolean isSpeakerphoneActive() {
    if (audioManager == null) {
      return false;
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo current = audioManager.getCommunicationDevice();
      if (current != null) {
        return current.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
      }
    }

    return audioManager.isSpeakerphoneOn();
  }

  private boolean isEarpieceActive() {
    if (audioManager == null) {
      return false;
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo current = audioManager.getCommunicationDevice();
      if (current != null) {
        return current.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
      }
    }

    return !audioManager.isSpeakerphoneOn();
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
