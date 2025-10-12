# Discord UI Clone - Quick Start Guide

## 🚀 Getting Started

### 1. Start the Development Server

```bash
cd client-new
npm install  # if not already installed
npm start
```

### 2. View the Discord UI Demo

Navigate to: **http://localhost:4200/discord-demo**

You should see a complete Discord-like interface with:
- Server list on the far left (vertical icons)
- Channel list (text and voice channels)
- Chat area in the center
- User list on the right

## 📋 What's Included

### Components Created:
1. ✅ **servers-list** - Vertical server icons with active indicators
2. ✅ **channels-list** - Text/voice channels grouped by category
3. ✅ **chat-messages** - Message display with avatars and timestamps
4. ✅ **chat-input** - Message input with action buttons
5. ✅ **chat-panel** - Complete chat view (combines messages + input)
6. ✅ **user-list** - Members panel with roles and status
7. ✅ **discord-layout** - Main 4-column grid layout

### Features:
- ✅ Dark theme with Discord color palette
- ✅ Mock data service with realistic content
- ✅ Fully responsive design
- ✅ Hover effects and animations
- ✅ Active state indicators
- ✅ Status indicators (online/idle/offline)
- ✅ Role-based user grouping

## 🎨 Architecture

### Grid Layout (4 columns):
```
┌────────┬──────────┬─────────────────┬──────────┐
│Servers │ Channels │  Chat Messages  │  Users   │
│ 72px   │  240px   │      1fr        │  240px   │
└────────┴──────────┴─────────────────┴──────────┘
```

### Component Hierarchy:
```
discord-layout
├── servers-list
├── channels-list
├── chat-panel
│   ├── chat-messages
│   └── chat-input
└── user-list
```

## 🔧 How to Use Components

### Standalone Usage

Import any component individually:

```typescript
import { ServersListComponent } from '@app/shared/components';

// In your template
<app-servers-list 
  [servers]="myServers"
  [activeServerId]="currentServerId"
  (serverSelected)="handleServerChange($event)">
</app-servers-list>
```

### Full Layout

Use the complete Discord layout:

```typescript
import { DiscordLayoutComponent } from '@app/shared/components';

// In your routes
{
  path: 'my-chat',
  component: DiscordLayoutComponent
}
```

## 📊 Mock Data

The `DataService` provides realistic mock data:

- **4 Servers**: Datasetto, Gaming Hub, Dev Community, Art & Design
- **8 Channels**: 4 text + 4 voice channels per server
- **8 Messages**: Sample chat messages with timestamps
- **8 Users**: Split into Admins and Members with different statuses

### Customize Mock Data

Edit `src/app/core/services/data.service.ts`:

```typescript
getServers(): Observable<Server[]> {
  return of([
    { id: '1', name: 'My Server', imageUrl: 'path/to/icon' },
    // Add your servers
  ]);
}
```

## 🎨 Color Customization

Colors are defined in `src/styles/_variables.scss`:

```scss
$brand-primary: #5865F2;   // Discord Blurple
$bg-primary: #313338;       // Main background
$bg-secondary: #2b2d31;     // Sidebar background
$text-normal: #dbdee1;      // Text color
```

Change these to match your brand!

## 📱 Responsive Behavior

- **Desktop (>1200px)**: All 4 columns visible
- **Tablet (768-1200px)**: 3 columns (hides user list)
- **Mobile (<768px)**: 1 column (chat only)

## 🧪 Testing the UI

### Interactive Elements:

1. **Click Servers** - Switch between different servers
2. **Click Channels** - Change active channel (loads new messages)
3. **Type Messages** - Test the input field (press Enter to "send")
4. **Hover Effects** - Move mouse over servers, channels, messages
5. **Status Indicators** - See online/idle/offline states on user avatars

## 🛠️ Integration with Existing App

### Replace Existing Layout

To integrate with your current app, update `app.routes.ts`:

```typescript
import { DiscordLayoutComponent } from './shared/components';

export const routes: Routes = [
  {
    path: '',
    component: DiscordLayoutComponent,  // Use Discord layout
    canActivate: [authGuard],
    // Your child routes here
  }
];
```

### Use with Real Data

Replace `DataService` calls with your actual API:

```typescript
// Instead of mock data
this.dataService.getServers()

// Use your API service
this.apiService.fetchServers()
```

## 📚 Next Steps

1. **Connect to Backend**: Replace mock data with real API calls
2. **Add WebSocket**: Implement real-time message updates
3. **User Interactions**: Add click handlers for reactions, replies
4. **Voice Channels**: Implement WebRTC for voice functionality
5. **File Uploads**: Add drag-and-drop file support
6. **Emoji Picker**: Create emoji selection popup
7. **User Profiles**: Add user profile modals
8. **Server Settings**: Implement server/channel management

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Kill process on port 4200
npx kill-port 4200
npm start
```

### Module Not Found
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Styles Not Loading
- Check that SCSS files are in the correct location
- Verify `styleUrl` paths in component decorators
- Clear Angular cache: `npm run clean` (if available)

## 📖 Documentation

For detailed component documentation, see:
- `DISCORD_UI_README.md` - Complete component reference
- Component source files - Inline JSDoc comments

## ✨ Features Showcase

Visit `/discord-demo` to see:
- ✅ Smooth hover transitions
- ✅ Active state indicators
- ✅ Status badges (online/idle/offline)
- ✅ Role-based grouping
- ✅ Message hover actions
- ✅ Channel icons (text vs voice)
- ✅ Server tooltips
- ✅ Responsive grid layout

Enjoy your Discord UI clone! 🎉
