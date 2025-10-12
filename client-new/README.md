# Datasetto Client - Angular# ClientNew



Modern real-time communication client built with Angular 20, NgRx, and Tailwind CSS v4.This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 20.3.5.



## 🚀 Tech Stack## Development server



- **Angular 20.3.4** - Latest Angular framework with standalone componentsTo start a local development server, run:

- **NgRx 20.0.1** - State management (Store, Effects, DevTools)

- **Tailwind CSS v4.1.14** - Utility-first CSS framework```bash

- **Socket.io Client 4.8.1** - Real-time WebSocket communicationng serve

- **HLS.js 1.6.13** - HTTP Live Streaming video player```

- **TypeScript 5.6.2** - Type-safe development

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## 📁 Project Structure

## Code scaffolding

```

src/app/Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

├── core/

│   ├── guards/          # Auth and admin guards```bash

│   ├── models/          # TypeScript interfacesng generate component component-name

│   ├── services/        # Core services (Socket, Audio, Voice, Player)```

│   └── utils/           # Helper functions

├── store/               # NgRx state (auth, channel, chat, voice, ui)For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

├── features/            # Feature components (auth, chat, voice, video, settings)

├── shared/              # Shared components (toast, spinner, modal, button, etc.)```bash

└── environments/        # Environment configurationng generate --help

``````



## 🛠️ Development## Building



### InstallationTo build the project run:

```bash

npm install```bash

```ng build

```

### Development Server

```bashThis will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

npm start

# Navigate to http://localhost:4200/## Running unit tests

```

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

### Production Build

```bash```bash

npm run buildng test

# Output: dist/client/```

```

## Running end-to-end tests

## 🐳 Docker Production

For end-to-end (e2e) testing, run:

### Build

```bash```bash

docker build -f Dockerfile.prod -t datasetto-client:latest .ng e2e

``````



### RunAngular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

```bash

docker run -d -p 8080:8080 datasetto-client:latest## Additional Resources

```

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

## 📦 Features

- ✅ Real-time chat with Socket.io
- ✅ WebRTC voice communication
- ✅ HLS video streaming
- ✅ Audio device management
- ✅ NgRx state management
- ✅ Authentication & authorization
- ✅ Responsive UI with Tailwind CSS v4
- ✅ Toast notifications
- ✅ Loading states (spinners, skeletons)
- ✅ Settings page

## 🔌 Key Services

### SocketService
Real-time WebSocket communication with Socket.io

### VoiceService  
WebRTC peer-to-peer voice chat

### PlayerService
HLS video streaming with quality control

### AudioService
Audio device enumeration and management

## 🎨 Tailwind CSS v4

Uses the new `@theme` syntax in `styles.css`:

```css
@import "tailwindcss";

@theme {
  --color-brand-primary: #5865F2;
  --font-sans: "Inter", system-ui, sans-serif;
}
```

## 📝 Environment Configuration

- **Development**: `src/environments/environment.ts`
- **Production**: `src/environments/environment.prod.ts`

## 🚢 Deployment

1. Build: `npm run build`
2. Deploy `dist/client/` to web server
3. Configure nginx for SPA routing (see `nginx.conf`)
4. Set environment variables

## 📄 License

See LICENSE.md

## 📚 Documentation

- [Angular Docs](https://angular.dev)
- [NgRx Docs](https://ngrx.io)
- [Tailwind CSS](https://tailwindcss.com)
