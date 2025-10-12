# Voice Channels - Quick Start Guide 🚀

## Testing Your New Voice Channels

### Prerequisites ✅
- Server running (Node.js backend)
- Client running (Angular app)
- Modern browser (Chrome/Firefox/Edge/Safari 11+)
- Microphone connected and working

---

## Step-by-Step Testing

### 1. Start the Application

**Terminal 1 - Server:**
```powershell
cd server
npm start
```

**Terminal 2 - Client:**
```powershell
cd client-new
npm start
```

Wait for the app to open in your browser (usually http://localhost:4200)

---

### 2. Single User Test

#### A. Join a Voice Channel
1. Look at the left sidebar
2. Find a voice channel (🔊 icon)
3. Click on it
4. **Browser will prompt for microphone permission** → Click "Allow"
5. VoicePanel should appear on the right side showing you're connected

#### B. Test Your Microphone
1. Speak into your microphone
2. Watch the **audio level bar** under the microphone button
   - Should move as you talk
   - Blue (quiet) → Green (loud)
3. Watch your **audio level ring** around your avatar (if visible)
   - Pulses when you speak

#### C. Test Mute
1. Click the **microphone button** 🎤
2. Button should turn red 🔇
3. Speak - audio level bar should NOT move
4. Click again to unmute

#### D. Test Deafen
1. Click the **speaker button** 🔊
2. Button should turn red 🔇
3. This mutes your mic AND stops you hearing others

#### E. Leave Voice Channel
1. Click the **✕ button** in the VoicePanel header
2. Panel should disappear
3. You're disconnected

---

### 3. Two User Test (Most Important!)

You need **TWO browser windows or TWO different computers** for this.

#### Setup:
- **Window A**: Open app in Chrome
- **Window B**: Open app in Chrome Incognito (or different browser)
- Login as **different users** in each window

#### Test Flow:

**User A:**
1. Click a voice channel
2. Grant microphone permission
3. See VoicePanel appear

**User B:**
1. Click the **SAME voice channel**
2. Grant microphone permission
3. See VoicePanel appear
4. **You should now see User A in your participants list!**

**Both Users:**
1. User A speaks → User B should **HEAR** User A's voice
2. User B speaks → User A should **HEAR** User B's voice
3. Check visual indicators:
   - ✅ Speaking indicator appears ("Speaking" text)
   - ✅ Audio level bar moves (0-100%)
   - ✅ Avatar ring pulses when speaking
   - ✅ Color changes based on volume

**User A:**
1. Click mute button 🎤
2. User B should see **mute icon** 🔇 next to User A's name

**User B:**
1. Click deafen button 🔊
2. User A should see **deafen icon** next to User B's name

**User A:**
1. Leave voice channel (click ✕)
2. User B should see User A disappear from the list

---

### 4. Push-to-Talk Test (Optional)

**Note**: PTT is enabled by default but needs to be tested.

1. Join a voice channel (both users)
2. Press and hold **Space bar**
3. **"PTT Active" badge** should appear at bottom
4. Speak while holding Space
5. Release Space
6. Badge disappears

**Expected Behavior**:
- Transmit audio ONLY when Space is pressed (if PTT-only mode)
- OR transmit when Space OR voice detected (if dual mode)

---

## What You Should See

### VoicePanel Layout:
```
┌─────────────────────────────────┐
│ 🔊 Voice Channel            ✕   │  ← Header with disconnect
├─────────────────────────────────┤
│                                 │
│  ┌─────────────────────────┐   │
│  │ ⭕ Alice                 │   │  ← Avatar with ring
│  │   └ 🎤 Speaking          │   │  ← Speaking indicator
│  │   [████████░░░] 80%      │   │  ← Audio level bar
│  │   🔇                      │   │  ← Muted icon
│  └─────────────────────────┘   │
│                                 │
│  ┌─────────────────────────┐   │
│  │ ⭕ Bob                   │   │
│  │   [██░░░░░░░░] 20%      │   │
│  └─────────────────────────┘   │
│                                 │
├─────────────────────────────────┤
│   [██░] ← Your audio level      │
│                                 │
│        🎤         🔊            │  ← Controls
│      (mute)    (deafen)         │
│                                 │
│   🎤 PTT Active                 │  ← PTT indicator (if active)
└─────────────────────────────────┘
```

---

## Visual Indicators Explained

### 🎤 Speaking Indicator
- **Appears**: When user is talking
- **Color**: Green (#57f287)
- **Animation**: Pulsing dot
- **Location**: Below username

### Audio Level Bar
- **Width**: 0-100% based on volume
- **Colors**:
  - Blue (#5865f2) = Quiet/Low
  - Blue-Green gradient = Medium
  - Green (#57f287) = Loud/High
- **Updates**: Real-time (~60fps)

### Audio Level Ring
- **Location**: Around avatar
- **Opacity**: 0-100% based on volume
- **Animation**: Pulsing when speaking
- **Color**: Matches audio level (blue → green)

### PTT Badge
- **Text**: "PTT Active"
- **Appears**: When Space key pressed
- **Animation**: Pulsing glow effect
- **Color**: Green gradient

### Status Icons
- **🔇 Muted**: Red, user's mic is off
- **🔇 Deafened**: Gray, user can't hear

---

## Troubleshooting

### "No microphone permission"
**Solution**: 
1. Browser should prompt automatically
2. If not, click the 🔒 icon in address bar
3. Allow microphone access
4. Refresh page and try again

### "Can't hear other user"
**Check**:
1. Other user is in same voice channel ✅
2. Other user is not muted 🎤
3. Your deafen is OFF 🔊
4. Your system volume is up 🔊
5. Check browser console for WebRTC errors

### "No speaking indicators"
**Check**:
1. Browser console for errors
2. AudioService is monitoring (should see logs)
3. Microphone is actually picking up sound
4. VAD threshold isn't too high (default: 30)

### "Audio is choppy/laggy"
**Solutions**:
1. Check network connection
2. Reduce number of users (mesh topology scales to ~8 users)
3. Close other applications
4. Check CPU usage

### "WebRTC connection failed"
**Solutions**:
1. Check firewall settings
2. May need TURN server for NAT traversal
3. Currently using STUN only (works for most cases)
4. Check browser console for ICE errors

### "VoicePanel not appearing"
**Check**:
1. Voice channel was clicked (not text channel)
2. Browser console for errors
3. VoiceController injected properly
4. Angular app compiled without errors

---

## Console Logs to Watch

When everything works, you should see:

```
[VoiceController] ✅ Joined voice channel: channel-id
[VoiceController] ✅ Voice joined: channel-id Peers: 1
[VoiceController] 👤 Peer joined: Alice
[VoiceController] 🎵 Received remote track from: user-id
[WebRTCService] ICE candidate generated for user-id
[WebRTCService] Received remote track from user-id
```

---

## Performance Metrics

### Expected Performance:
- **CPU Usage**: 5-15% (depends on number of users)
- **Memory**: 50-100MB (for 5 users)
- **Network**: 50-100 Kbps per user connection
- **Latency**: 100-300ms (depends on network)

### Audio Quality:
- **Sample Rate**: 48kHz
- **Codec**: Opus (automatic in WebRTC)
- **Echo Cancellation**: Enabled
- **Noise Suppression**: Enabled
- **Auto Gain**: Enabled

---

## Advanced Testing

### 3+ Users:
1. Open 3+ browser windows/devices
2. All join same voice channel
3. Everyone should see everyone else
4. Everyone should hear everyone else
5. Check if audio quality degrades

### Network Conditions:
1. Test on different networks (WiFi, mobile, etc.)
2. Test with VPN
3. Test behind corporate firewall
4. Test with different ISPs

### Stress Test:
1. Join with 5+ users
2. Everyone speaks at once
3. Check for audio dropouts
4. Monitor CPU and memory usage
5. Check network bandwidth

---

## Next Steps After Testing

### If Everything Works ✅:
- Deploy to production
- Monitor logs and errors
- Gather user feedback
- Consider Phase 4 features (settings panel)

### If Issues Found ⚠️:
1. Check browser console for errors
2. Check server logs
3. Verify WebRTC connection in Chrome DevTools:
   - Open DevTools → `chrome://webrtc-internals`
   - Check peer connection stats
4. File bug reports with details

### Future Enhancements:
- Voice settings panel (VAD threshold, PTT key)
- Device selection (microphone, speakers)
- Connection quality indicator
- Recording functionality
- Video streaming
- Screen sharing

---

## Support

### Browser DevTools:
- **Chrome**: F12 → Console
- **Firefox**: F12 → Console
- **Edge**: F12 → Console

### Useful URLs:
- **WebRTC Internals**: `chrome://webrtc-internals` (Chrome)
- **MediaDevices**: `about:webrtc` (Firefox)

### Documentation:
- See `PHASE3_COMPLETE.md` for full details
- See `VOICE_CHANNEL_PHASE1_COMPLETE.md` for Phase 1
- See `SERVER_VOICE_ANALYSIS.md` for server details

---

## Happy Testing! 🎉

Your voice channels are ready to use. Enjoy Discord-like voice chat in your application!

**Questions or Issues?**
- Check browser console
- Check server logs
- Review documentation files
- Test with different browsers
