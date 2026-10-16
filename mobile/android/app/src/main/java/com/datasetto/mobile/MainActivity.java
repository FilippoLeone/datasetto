package com.datasetto.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		// Plugins must be registered before super.onCreate() builds the bridge;
		// registering afterwards silently leaves them out.
		registerPlugin(AudioRoutePlugin.class);
		super.onCreate(savedInstanceState);
		if (Build.VERSION.SDK_INT >= 35) {
			keepWebViewClearOfSystemUi();
		}
	}

	/**
	 * Android 15+ draws apps edge to edge. Keep the WebView clear of the status
	 * and navigation bars, a display cutout and the on-screen keyboard, so the
	 * client's header and composer stay visible. Capacitor's own margin handling
	 * (adjustMarginsForEdgeToEdge) ignores the keyboard, so it is disabled in
	 * capacitor.config.ts and done here instead.
	 */
	private void keepWebViewClearOfSystemUi() {
		if (getBridge() == null) {
			return;
		}
		WebView webView = getBridge().getWebView();
		ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
			Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
			Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
			ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
			params.leftMargin = bars.left;
			params.topMargin = bars.top;
			params.rightMargin = bars.right;
			params.bottomMargin = Math.max(bars.bottom, ime.bottom);
			view.setLayoutParams(params);
			return WindowInsetsCompat.CONSUMED;
		});
	}
}
