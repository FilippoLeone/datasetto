import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards';
import { Login } from './features/auth/login/login';
import { Register } from './features/auth/register/register';
import { MainLayout } from './shared/components/main-layout/main-layout';
import { DiscordLayoutComponent } from './shared/components/discord-layout/discord-layout';

export const routes: Routes = [
  // Auth routes (no layout, only for guests)
  {
    path: 'auth',
    canActivate: [guestGuard],
    children: [
      {
        path: 'login',
        component: Login
      },
      {
        path: 'register',
        component: Register
      },
      {
        path: '',
        redirectTo: 'login',
        pathMatch: 'full'
      }
    ]
  },
  
  // Discord UI Demo (no auth required for demo)
  {
    path: 'discord-demo',
    component: DiscordLayoutComponent
  },

  // Main app routes (with layout and auth guard)
  {
    path: '',
    component: MainLayout,
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/chat/chat-view/chat-view').then(m => m.ChatView)
      },
      {
        path: 'chat/:id',
        loadComponent: () => import('./features/chat/chat-view/chat-view').then(m => m.ChatView)
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings').then(m => m.SettingsComponent)
      }
    ]
  },

  // Fallback - redirect to login if not authenticated
  {
    path: '**',
    redirectTo: 'auth/login'
  }
];
