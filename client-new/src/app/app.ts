import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Store } from '@ngrx/store';
import { ToastContainer } from './shared/components/toast-container/toast-container';
import { SocketService } from './core/services/socket.service';
import { environment } from '../environments/environment';
import * as AuthActions from './store/auth/auth.actions';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastContainer],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  title = 'Datasetto';

  constructor(
    private store: Store,
    private socketService: SocketService
  ) {}

  ngOnInit(): void {
    // Initialize socket connection
    const serverUrl = environment.serverUrl || 'http://localhost:3000';
    this.socketService.connect(serverUrl);

    // Try to load existing session
    this.store.dispatch(AuthActions.loadSession());

    // Subscribe to socket events and dispatch to store
    this.setupSocketSubscriptions();
  }

  private setupSocketSubscriptions(): void {
    // Connection status
    this.socketService.onConnectionStatus().subscribe(status => {
      console.log('[App] Connection status:', status);
    });

    // Auth success
    this.socketService.onAuthSuccess().subscribe(data => {
      // Handled by auth effects
    });

    // You can add more socket event subscriptions here
    // that dispatch actions to the store
  }
}
