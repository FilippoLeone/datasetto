# Discord UI Clone - Angular Components

This folder contains a complete Discord-like UI implementation using Angular 17+ standalone components, TypeScript, and SCSS.

## 🎨 Color Palette

The UI uses a dark theme inspired by Discord:

- **Charcoal** (`#2c2f33`): Primary backgrounds
- **Dark Gray** (`#23272a`): Secondary surfaces
- **Light Gray** (`#ffffff`): Text
- **Blurple** (`#5865F2`): Brand/accent color (Discord's signature purple-blue)

All colors are defined in `/src/styles/_variables.scss` for consistency.

## 📁 Component Structure

### Core Components

#### 1. `servers-list` Component
- **Location**: `shared/components/servers-list/`
- **Purpose**: Vertical list of server icons on the far left
- **Features**:
  - Circular server icons with tooltips
  - Active server indicator (white pill)
  - Hover effects with rounded corners
  - Home button and Add Server button
- **Inputs**:
  - `servers: Server[]` - Array of server objects
  - `activeServerId: string | null` - Currently selected server
- **Outputs**:
  - `serverSelected: EventEmitter<string>` - Emits when a server is clicked

#### 2. `channels-list` Component
- **Location**: `shared/components/channels-list/`
- **Purpose**: List of text and voice channels grouped by category
- **Features**:
  - Text channels with `#` icon
  - Voice channels with microphone icon
  - Active channel highlighting
  - Hover actions (Invite, Settings)
  - Category headers with expand/collapse
- **Inputs**:
  - `categories: ChannelCategory[]` - Channel groups
  - `activeChannelId: string | null` - Currently selected channel
- **Outputs**:
  - `channelSelected: EventEmitter<string>` - Emits when text channel is clicked

#### 3. `chat-messages` Component
- **Location**: `shared/components/chat-messages/`
- **Purpose**: Display chat messages with author info
- **Features**:
  - Author avatar and name
  - Message timestamp
  - Hover actions (React, Reply, More)
  - Empty state for new channels
- **Inputs**:
  - `messages: Message[]` - Array of messages
  - `channelName: string` - Current channel name

#### 4. `chat-input` Component
- **Location**: `shared/components/chat-input/`
- **Purpose**: Message input with actions
- **Features**:
  - Text input with placeholder
  - Attachment, Emoji, GIF, Sticker buttons
  - Enter to send, Shift+Enter for new line
- **Inputs**:
  - `channelName: string` - For placeholder text
- **Outputs**:
  - `messageSent: EventEmitter<string>` - Emits message content

#### 5. `chat-panel` Component
- **Location**: `shared/components/chat-panel/`
- **Purpose**: Complete chat view (header + messages + input)
- **Features**:
  - Channel header with actions
  - Integrates `chat-messages` and `chat-input`
  - Notification, Pin, Members, Search buttons
- **Inputs**:
  - `messages: Message[]` - Messages to display
  - `channelName: string` - Current channel name

#### 6. `user-list` Component
- **Location**: `shared/components/user-list/`
- **Purpose**: Members panel on the right
- **Features**:
  - Users grouped by role (Admins, Members, etc.)
  - Avatar with status indicator (online/idle/offline)
  - Role badges
  - Member count header
- **Inputs**:
  - `userGroups: UserGroup[]` - Users grouped by role

#### 7. `discord-layout` Component
- **Location**: `shared/components/discord-layout/`
- **Purpose**: Main 4-column grid layout
- **Features**:
  - CSS Grid: `72px 240px 1fr 240px`
  - Integrates all Discord UI components
  - Responsive breakpoints
  - Mock data integration via `DataService`

## 🔧 Services

### `DataService`
- **Location**: `core/services/data.service.ts`
- **Purpose**: Provides mock data for demonstration
- **Methods**:
  - `getServers(): Observable<Server[]>`
  - `getChannels(serverId: string): Observable<ChannelCategory[]>`
  - `getMessages(channelId: string): Observable<Message[]>`
  - `getUsers(channelId: string): Observable<UserGroup[]>`

All methods return RxJS Observables to simulate async data fetching.

## 📐 Interfaces

```typescript
interface Server {
  id: string;
  name: string;
  imageUrl: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
}

interface ChannelCategory {
  id: string;
  name: string;
  channels: DiscordChannel[];
}

interface Message {
  id: string;
  author: {
    name: string;
    avatarUrl: string;
  };
  timestamp: Date;
  content: string;
}

interface DiscordUser {
  id: string;
  name: string;
  status: 'online' | 'idle' | 'offline';
  avatarUrl: string;
  role?: string;
}

interface UserGroup {
  role: string;
  users: DiscordUser[];
}
```

## 🚀 Usage

### View the Demo

Navigate to `/discord-demo` to see the complete Discord UI:

```bash
npm start
# Navigate to http://localhost:4200/discord-demo
```

### Use Individual Components

```typescript
import { ServersListComponent, ChannelsListComponent, ChatPanelComponent, UserListComponent } from '@app/shared/components';

// In your component
<app-servers-list 
  [servers]="servers"
  [activeServerId]="activeServerId"
  (serverSelected)="onServerSelected($event)">
</app-servers-list>
```

### Custom Integration

```typescript
import { Component, OnInit } from '@angular/core';
import { DataService } from '@app/core/services';

@Component({
  selector: 'app-my-discord',
  template: `
    <app-discord-layout></app-discord-layout>
  `
})
export class MyDiscordComponent implements OnInit {
  constructor(private dataService: DataService) {}

  ngOnInit() {
    // Load and customize data
    this.dataService.getServers().subscribe(servers => {
      // Your logic here
    });
  }
}
```

## 🎯 Key Features

### Design Patterns
- ✅ **Standalone Components** - All components are standalone (Angular 17+)
- ✅ **Reactive Programming** - Uses RxJS Observables throughout
- ✅ **Component Isolation** - Each component is self-contained with scoped styles
- ✅ **Type Safety** - Full TypeScript with strict interfaces
- ✅ **SCSS Variables** - Centralized color palette and design tokens

### UI/UX Features
- ✅ **Hover Effects** - Subtle transitions and state changes
- ✅ **Active Indicators** - Visual feedback for selected items
- ✅ **Responsive Design** - Adapts to different screen sizes
- ✅ **Accessibility** - ARIA labels and keyboard navigation
- ✅ **Custom Scrollbars** - Styled to match Discord's aesthetic

### Mock Data
- ✅ **Realistic Content** - Placeholder servers, channels, messages, and users
- ✅ **Observable Streams** - Async data simulation with RxJS
- ✅ **Easy Customization** - Modify `data.service.ts` to change mock data

## 🛠️ Customization

### Change Colors

Edit `/src/styles/_variables.scss`:

```scss
$brand-primary: #5865F2;  // Change to your brand color
$bg-primary: #313338;      // Change background
```

### Add More Mock Data

Edit `core/services/data.service.ts`:

```typescript
getServers(): Observable<Server[]> {
  return of([
    { id: '1', name: 'My Server', imageUrl: '...' },
    // Add more servers
  ]);
}
```

### Modify Layout

Edit `discord-layout.scss`:

```scss
.discord-layout {
  grid-template-columns: 72px 240px 1fr 240px;
  // Adjust column widths
}
```

## 📱 Responsive Breakpoints

- **Desktop** (>1200px): 4-column layout
- **Tablet** (768px-1200px): 3-column layout (no user list)
- **Mobile** (<768px): 1-column layout (chat only)

## 🧪 Testing

All components are fully standalone and can be tested independently:

```typescript
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ServersListComponent } from './servers-list';

describe('ServersListComponent', () => {
  let component: ServersListComponent;
  let fixture: ComponentFixture<ServersListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServersListComponent]
    }).compileComponents();
    
    fixture = TestBed.createComponent(ServersListComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
```

## 📚 Resources

- [Angular Standalone Components](https://angular.io/guide/standalone-components)
- [Discord Design](https://discord.com/branding)
- [SCSS Best Practices](https://sass-lang.com/guide)
- [RxJS Documentation](https://rxjs.dev/)

## ✨ Credits

Built with Angular 17+, TypeScript, and SCSS. Inspired by Discord's design language.
