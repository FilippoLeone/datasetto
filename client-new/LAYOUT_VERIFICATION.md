# Visual Layout Verification Checklist

## Please tell me which of these is NOT working:

### ❓ Issue Checklist - What's Wrong?

Please tell me specifically:

1. **Message Input Field**
   - [ ] Can you see the message input box at all?
   - [ ] Is it at the very bottom of the chat area?
   - [ ] Is it hidden behind something?
   - [ ] Is it in the middle instead of bottom?

2. **User Info (Sidebar Bottom)**
   - [ ] Can you see your user avatar and name?
   - [ ] Is it at the very bottom of the sidebar?
   - [ ] Is it floating in the middle?
   - [ ] Is it cut off?

3. **Layout Issues**
   - [ ] Is there a scrollbar where there shouldn't be?
   - [ ] Is content overflowing?
   - [ ] Are elements overlapping?
   - [ ] Is the spacing wrong?

## Expected Layout

```
┌──────────┬─────────────────────────────┐
│          │ # channel-name     [icons]  │ ← Header (fixed)
│ Channels ├─────────────────────────────┤
│          │                             │
│ general  │  (Scrollable messages)      │
│ announce │                             │
│          │  ● Welcome message          │
│ voice    │                             │
│ channels │                             │
│          ├─────────────────────────────┤
│          │ Message #channel  [😀][📎]  │ ← Input (fixed bottom)
│          └─────────────────────────────┘
│ ┌──────┐ │
│ │  L   │ │ ← User area (fixed bottom)
│ │ Lele │ │
│ └──────┘ │
└──────────┴─────────────────────────────┘
```

## Current CSS State

### User Area (Sidebar):
- `position: sticky`
- `bottom: 0`
- `z-index: var(--z-sticky)`
- Should be pinned to bottom of sidebar ✅

### Chat Input:
- `padding: 0 16px 24px`
- `flex-shrink: 0`
- Should be at bottom of chat panel ✅

### Chat Messages:
- `flex: 1` (grows to fill space)
- `overflow-y: auto` (scrollable)
- Should push input to bottom ✅

## Quick Fixes to Try

### If user area is not at bottom:
The sidebar needs `display: flex` and `flex-direction: column`.

### If input is not at bottom:
The chat-panel needs proper flex layout.

### If everything is squished:
Height chain might be broken.

## Please describe the issue:

**What do you see that's wrong?**
_[Your description here]_

**Screenshot would help!**
